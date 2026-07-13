import { isIP } from "node:net";
import ssh2Runtime from "ssh2";
import type * as ssh2 from "ssh2";
import type {
  PeerFileTransferFallbackReason,
  SSHConnectionConfig,
} from "../../types";
import { ScopedOpenSshAgent } from "./ScopedOpenSshAgent";

const TARGET_CONNECT_TIMEOUT_SECONDS = 2;
const EXEC_OPEN_TIMEOUT_MS = 3_000;
const CAPABILITY_PROBE_TIMEOUT_MS = 2_000;
const PROGRESS_POLL_INTERVAL_MS = 250;
const SFTP_STAT_TIMEOUT_MS = 2_000;
const MINIMUM_REMOTE_OPENSSH_MAJOR = 9;
const DEFAULT_FIRST_PROGRESS_TIMEOUT_MS = 5_000;
const DEFAULT_IDLE_PROGRESS_TIMEOUT_MS = 15_000;

type RemoteScpCapability = "supported" | "unsupported" | "unavailable";

export interface SshScpTransferAttemptOptions {
  firstProgressTimeoutMs?: number;
  idleProgressTimeoutMs?: number;
}

export type PeerTransferSide = "source" | "target";

export type AgentExecutorClientFactory = (
  executorSide: PeerTransferSide,
  agentSocketPath: string,
  signal?: AbortSignal,
) => Promise<ssh2.Client | null>;

export interface SshTransferEndpoint {
  side: PeerTransferSide;
  client: ssh2.Client;
  config: SSHConnectionConfig;
  observedHostKey: Buffer;
}

export interface SshScpTransferAttemptInput {
  executor: SshTransferEndpoint;
  remote: SshTransferEndpoint;
  sourcePath: string;
  targetPath: string;
  direction: "push" | "pull";
  targetSftp: ssh2.SFTPWrapper;
  expectedBytes: number;
  hostAlias: string;
  openAgentExecutorClient: AgentExecutorClientFactory;
  signal?: AbortSignal;
  onProgress?: (bytesTransferred: number) => void;
}

export interface SshScpTransferAttemptResult {
  succeeded: boolean;
  maxObservedBytes: number;
  reason: PeerFileTransferFallbackReason;
}

interface ScpExecutionResult {
  exitCode: number;
  passwordPromptSeen: boolean;
  agentForwardingDenied: boolean;
  authenticationFailed: boolean;
  connectionFailed: boolean;
}

const createAbortError = (): Error => {
  const error = new Error("Transfer cancelled by user.");
  error.name = "AbortError";
  return error;
};

const isAbortError = (error: unknown): boolean =>
  (error as { name?: unknown } | null)?.name === "AbortError";

const ensureNotAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw createAbortError();
};

const shellQuote = (value: string): string =>
  `'${value.replace(/'/g, `'"'"'`)}'`;

const delay = async (
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> => {
  ensureNotAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => signal?.removeEventListener("abort", onAbort);
    const onAbort = (): void => {
      clearTimeout(timer);
      cleanup();
      reject(createAbortError());
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
};

const statSftpFile = async (
  sftp: ssh2.SFTPWrapper,
  filePath: string,
  signal?: AbortSignal,
): Promise<ssh2.Stats | null> =>
  await new Promise<ssh2.Stats | null>((resolve, reject) => {
    let settled = false;
    const finish = (value?: ssh2.Stats | null, error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(value ?? null);
    };
    const onAbort = (): void => finish(undefined, createAbortError());
    const timer = setTimeout(
      () =>
        finish(undefined, new Error("Timed out while reading staging state.")),
      SFTP_STAT_TIMEOUT_MS,
    );
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    sftp.stat(filePath, (error, stats) => {
      if (error) {
        const code = (error as { code?: unknown }).code;
        if (code === 2 || code === "ENOENT") {
          finish(null);
          return;
        }
        finish(undefined, error);
        return;
      }
      finish(stats);
    });
  });

/** Executes one source-side push or target-side pull attempt. */
export class SshScpTransferAttempt {
  private readonly capabilityCache = new WeakMap<
    ssh2.Client,
    Exclude<RemoteScpCapability, "unavailable">
  >();

  constructor(private readonly options: SshScpTransferAttemptOptions = {}) {}

  async run(
    input: SshScpTransferAttemptInput,
  ): Promise<SshScpTransferAttemptResult> {
    ensureNotAborted(input.signal);
    const capability = await this.resolveScpCapability(
      input.executor.client,
      input.signal,
    );
    if (capability !== "supported") {
      return {
        succeeded: false,
        maxObservedBytes: 0,
        reason:
          capability === "unsupported"
            ? "remote-openssh-unsupported"
            : "remote-capability-unavailable",
      };
    }

    let scpClient = input.executor.client;
    let ownsScpClient = false;
    let agent: ScopedOpenSshAgent | null = null;
    let copySettled = false;
    let maxObservedBytes = 0;
    let progressTask: Promise<void> | null = null;
    let watchdogTimer: ReturnType<typeof setTimeout> | null = null;
    let routeTimedOut = false;
    const routeController = new AbortController();
    const abortRoute = (): void => routeController.abort();
    const resetWatchdog = (timeoutMs: number): void => {
      if (watchdogTimer) clearTimeout(watchdogTimer);
      watchdogTimer = setTimeout(() => {
        routeTimedOut = true;
        abortRoute();
      }, timeoutMs);
    };

    try {
      if (input.remote.config.authMethod === "privateKey") {
        try {
          // ssh2 proxies the forwarded socket but does not synthesize an
          // executor-hop session bind. This one-transfer lease is therefore
          // constrained to the exact final user+host key and attached to only
          // one short-lived executor connection.
          agent = await ScopedOpenSshAgent.create({
            credential: input.remote.config,
            destinationUsername: input.remote.config.username,
            destinationAlias: input.hostAlias,
            destinationHostKey: input.remote.observedHostKey,
            signal: input.signal,
          });
        } catch (error) {
          if (input.signal?.aborted || isAbortError(error)) throw error;
          return {
            succeeded: false,
            maxObservedBytes: 0,
            reason: "local-openssh-unsupported",
          };
        }
        const agentClient = await input.openAgentExecutorClient(
          input.executor.side,
          agent.socketPath,
          input.signal,
        );
        if (!agentClient) {
          return {
            succeeded: false,
            maxObservedBytes: 0,
            reason: "unsupported-route",
          };
        }
        scpClient = agentClient;
        ownsScpClient = true;
      }

      input.signal?.addEventListener("abort", abortRoute, { once: true });
      if (input.signal?.aborted) abortRoute();
      resetWatchdog(
        this.options.firstProgressTimeoutMs ??
          DEFAULT_FIRST_PROGRESS_TIMEOUT_MS,
      );

      progressTask = this.pollProgress({
        sftp: input.targetSftp,
        stagingPath: input.targetPath,
        expectedBytes: input.expectedBytes,
        signal: routeController.signal,
        isSettled: () => copySettled,
        onProgress: (bytes) => {
          maxObservedBytes = Math.max(maxObservedBytes, bytes);
          resetWatchdog(
            this.options.idleProgressTimeoutMs ??
              DEFAULT_IDLE_PROGRESS_TIMEOUT_MS,
          );
          input.onProgress?.(bytes);
        },
      });

      const result = await this.executeScp({
        client: scpClient,
        command: this.buildScpCommand(input),
        password:
          input.remote.config.authMethod === "password"
            ? input.remote.config.password
            : undefined,
        agentForward: input.remote.config.authMethod === "privateKey",
        signal: routeController.signal,
      });
      copySettled = true;
      if (watchdogTimer) clearTimeout(watchdogTimer);
      const finalStat = await statSftpFile(
        input.targetSftp,
        input.targetPath,
        input.signal,
      );
      maxObservedBytes = Math.max(
        maxObservedBytes,
        Math.max(0, Number(finalStat?.size) || 0),
      );

      if (result.exitCode === 0) {
        return {
          succeeded: true,
          maxObservedBytes,
          reason: "direct-copy-failed",
        };
      }
      return {
        succeeded: false,
        maxObservedBytes,
        reason: this.classifyScpFailure(result),
      };
    } catch (error) {
      if (input.signal?.aborted) {
        throw createAbortError();
      }
      if (routeTimedOut) {
        return {
          succeeded: false,
          maxObservedBytes,
          reason: "direct-copy-failed",
        };
      }
      if (isAbortError(error)) throw createAbortError();
      return {
        succeeded: false,
        maxObservedBytes,
        reason: "direct-copy-failed",
      };
    } finally {
      copySettled = true;
      if (watchdogTimer) clearTimeout(watchdogTimer);
      input.signal?.removeEventListener("abort", abortRoute);
      await progressTask?.catch(() => {});
      if (ownsScpClient) {
        try {
          scpClient.end();
        } catch {
          // The short-lived control client may already be closed.
        }
      }
      await agent?.dispose();
    }
  }

  private buildScpCommand(input: SshScpTransferAttemptInput): string {
    const remoteAddress = this.buildRemoteAddress(input.remote.config);
    const knownHostsCommand = this.buildKnownHostsCommand(
      input.hostAlias,
      input.remote.observedHostKey,
    );
    const args = [
      "scp",
      "-F",
      "/dev/null",
      "-P",
      String(input.remote.config.port),
      "-o",
      `ConnectTimeout=${TARGET_CONNECT_TIMEOUT_SECONDS}`,
      "-o",
      "ConnectionAttempts=1",
      "-o",
      "ServerAliveInterval=3",
      "-o",
      "ServerAliveCountMax=2",
      "-o",
      "ControlMaster=no",
      "-o",
      "ControlPath=none",
      "-o",
      "ClearAllForwardings=yes",
      "-o",
      "ForwardAgent=no",
      "-o",
      "ProxyCommand=none",
      "-o",
      "ProxyJump=none",
      "-o",
      "UserKnownHostsFile=/dev/null",
      "-o",
      "GlobalKnownHostsFile=/dev/null",
      "-o",
      `KnownHostsCommand=${knownHostsCommand}`,
      "-o",
      `HostKeyAlias=${input.hostAlias}`,
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      "LogLevel=ERROR",
    ];

    if (input.remote.config.authMethod === "password") {
      args.push(
        "-o",
        "PreferredAuthentications=password",
        "-o",
        "PubkeyAuthentication=no",
        "-o",
        "KbdInteractiveAuthentication=no",
        "-o",
        "NumberOfPasswordPrompts=1",
      );
    } else {
      args.push(
        "-B",
        "-o",
        "PreferredAuthentications=publickey",
        "-o",
        "PasswordAuthentication=no",
        "-o",
        "KbdInteractiveAuthentication=no",
        "-o",
        "IdentityAgent=SSH_AUTH_SOCK",
        "-o",
        "IdentityFile=none",
      );
    }

    args.push("--");
    if (input.direction === "push") {
      args.push(input.sourcePath, `${remoteAddress}:${input.targetPath}`);
    } else {
      args.push(`${remoteAddress}:${input.sourcePath}`, input.targetPath);
    }
    return `LC_ALL=C ${args.map(shellQuote).join(" ")}`;
  }

  private buildRemoteAddress(config: SSHConnectionConfig): string {
    const host =
      isIP(config.host) === 6 || config.host.includes(":")
        ? `[${config.host}]`
        : config.host;
    return `${config.username}@${host}`;
  }

  private buildKnownHostsCommand(
    hostAlias: string,
    rawHostKey: Buffer,
  ): string {
    const parsed = ssh2Runtime.utils.parseKey(rawHostKey);
    const key = Array.isArray(parsed) ? parsed[0] : parsed;
    if (key instanceof Error || !key) {
      throw new Error("The observed host key could not be parsed.");
    }
    const line = `${hostAlias} ${key.type} ${rawHostKey.toString("base64")}`;
    // OpenSSH expands percent tokens before invoking KnownHostsCommand.
    return `/usr/bin/printf '%%s\\n' ${shellQuote(line)}`;
  }

  private classifyScpFailure(
    result: ScpExecutionResult,
  ): PeerFileTransferFallbackReason {
    if (result.agentForwardingDenied) return "agent-forwarding-denied";
    if (result.authenticationFailed || result.passwordPromptSeen) {
      return "direct-authentication-failed";
    }
    if (result.connectionFailed) return "direct-connection-failed";
    return "direct-copy-failed";
  }

  private isConnectionFailureDiagnostic(value: string): boolean {
    return (
      value.includes("connection refused") ||
      value.includes("connection timed out") ||
      value.includes("operation timed out") ||
      value.includes("no route to host") ||
      value.includes("network is unreachable") ||
      value.includes("connection reset") ||
      value.includes("could not resolve hostname")
    );
  }

  private async executeScp(input: {
    client: ssh2.Client;
    command: string;
    password?: string;
    agentForward: boolean;
    signal?: AbortSignal;
  }): Promise<ScpExecutionResult> {
    ensureNotAborted(input.signal);
    if (input.password && /[\0\r\n]/.test(input.password)) {
      throw new Error("The password cannot be submitted through a PTY.");
    }

    return await new Promise<ScpExecutionResult>((resolve, reject) => {
      let channel: ssh2.ClientChannel | null = null;
      let outputTail = "";
      let passwordPromptSeen = false;
      let passwordSent = false;
      let settled = false;

      const finish = (result?: ScpExecutionResult, error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(openTimer);
        input.signal?.removeEventListener("abort", onAbort);
        if (error) reject(error);
        else resolve(result!);
      };
      const onAbort = (): void => {
        try {
          channel?.signal("KILL");
          channel?.close();
        } catch {
          // Rejecting stops the owning short-lived connection as a fallback.
        }
        finish(undefined, createAbortError());
      };
      const appendOutput = (chunk: Buffer): void => {
        outputTail = `${outputTail}${chunk.toString("utf8")}`.slice(-2_048);
        if (!input.password || passwordSent) return;
        if (!/password:\s*$/i.test(outputTail)) return;
        passwordPromptSeen = true;
        passwordSent = true;
        channel?.write(`${input.password}\n`);
        outputTail = "";
      };
      const openTimer = setTimeout(() => {
        try {
          channel?.close();
        } catch {
          // The channel may not have opened yet.
        }
        finish(undefined, new Error("Timed out while opening scp."));
      }, EXEC_OPEN_TIMEOUT_MS);

      input.signal?.addEventListener("abort", onAbort, { once: true });
      input.client.exec(
        input.command,
        {
          ...(input.password ? { pty: true } : {}),
          ...(input.agentForward ? { agentForward: true } : {}),
        },
        (error, stream) => {
          if (settled) {
            try {
              stream?.signal("KILL");
              stream?.close();
            } catch {
              // A timed-out late channel is cleanup-only.
            }
            return;
          }
          if (error || !stream) {
            const normalized = (error?.message || "").toLowerCase();
            finish({
              exitCode: -1,
              passwordPromptSeen: false,
              agentForwardingDenied:
                normalized.includes("agent forwarding") ||
                normalized.includes("auth-agent@openssh.com"),
              authenticationFailed:
                normalized.includes("permission denied") ||
                normalized.includes("authentication failed"),
              connectionFailed: this.isConnectionFailureDiagnostic(normalized),
            });
            return;
          }
          channel = stream;
          clearTimeout(openTimer);
          stream.on("data", appendOutput);
          stream.stderr.on("data", appendOutput);
          stream.on("close", (code: number | null) => {
            const normalized = outputTail.toLowerCase();
            finish({
              exitCode: typeof code === "number" ? code : -1,
              passwordPromptSeen,
              agentForwardingDenied:
                normalized.includes("agent forwarding") ||
                normalized.includes("auth-agent@openssh.com"),
              authenticationFailed:
                normalized.includes("permission denied") ||
                normalized.includes("authentication failed"),
              connectionFailed: this.isConnectionFailureDiagnostic(normalized),
            });
          });
        },
      );
    });
  }

  private async resolveScpCapability(
    client: ssh2.Client,
    signal?: AbortSignal,
  ): Promise<RemoteScpCapability> {
    const cached = this.capabilityCache.get(client);
    if (cached !== undefined) return cached;

    const capability = await new Promise<RemoteScpCapability>(
      (resolve, reject) => {
        let channel: ssh2.ClientChannel | null = null;
        let output = "";
        let settled = false;
        const finish = (value?: RemoteScpCapability, error?: Error): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          if (error) reject(error);
          else resolve(value ?? "unavailable");
        };
        const onAbort = (): void => {
          try {
            channel?.close();
          } catch {
            // Cancellation result below is authoritative.
          }
          finish(undefined, createAbortError());
        };
        const timer = setTimeout(() => {
          try {
            channel?.close();
          } catch {
            // The bounded probe result below is authoritative.
          }
          finish("unavailable");
        }, CAPABILITY_PROBE_TIMEOUT_MS);

        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) {
          onAbort();
          return;
        }
        client.exec(
          "LC_ALL=C ssh -V 2>&1 && command -v scp >/dev/null 2>&1 && test -x /usr/bin/printf",
          (error, stream) => {
            if (settled) {
              try {
                stream?.close();
              } catch {
                // A late capability channel is cleanup-only.
              }
              return;
            }
            if (error || !stream) {
              finish("unavailable");
              return;
            }
            channel = stream;
            const append = (chunk: Buffer): void => {
              output = `${output}${chunk.toString("utf8")}`.slice(-512);
            };
            stream.on("data", append);
            stream.stderr.on("data", append);
            stream.on("close", (code: number | null) => {
              const match = /OpenSSH_(\d+)(?:\.\d+)?/i.exec(output);
              if (!match) {
                finish("unavailable");
                return;
              }
              const major = Number(match[1]);
              finish(
                code === 0 && major >= MINIMUM_REMOTE_OPENSSH_MAJOR
                  ? "supported"
                  : "unsupported",
              );
            });
          },
        );
      },
    );
    if (capability !== "unavailable") {
      this.capabilityCache.set(client, capability);
    }
    return capability;
  }

  private async pollProgress(input: {
    sftp: ssh2.SFTPWrapper;
    stagingPath: string;
    expectedBytes: number;
    signal?: AbortSignal;
    isSettled: () => boolean;
    onProgress?: (bytesTransferred: number) => void;
  }): Promise<void> {
    let lastReported = 0;
    while (!input.isSettled()) {
      await delay(PROGRESS_POLL_INTERVAL_MS, input.signal);
      if (input.isSettled()) return;
      try {
        const stats = await statSftpFile(
          input.sftp,
          input.stagingPath,
          input.signal,
        );
        const transferred = Math.min(
          input.expectedBytes,
          Math.max(0, Number(stats?.size) || 0),
        );
        if (transferred > lastReported) {
          lastReported = transferred;
          input.onProgress?.(transferred);
        }
      } catch {
        // A timed-out SFTP request cannot be cancelled in ssh2. Stop polling so
        // a stuck channel cannot accumulate an unbounded request backlog.
        return;
      }
    }
  }
}
