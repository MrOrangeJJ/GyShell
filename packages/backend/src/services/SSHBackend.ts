import * as ssh2 from "ssh2";
import * as fs from "fs";
import * as net from "net";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";
import { pipeline } from "node:stream/promises";
import { StringDecoder } from "node:string_decoder";
import { SocksClient } from "socks";
import { COMMAND_CAPTURE_MAX_UTF8_BYTES } from "@gyshell/shared";
import {
  isSshConnectionConfig,
  type TerminalCommandShellFamily,
  type TerminalCommandTrackingToken,
  type TerminalCommandTrackingMode,
  type TerminalCommandTrackingUpdate,
  type TerminalCommandProtocolMetadata,
  type TerminalBackend,
  type TerminalConfig,
  type TerminalExecOptions,
  type PeerFileTransferOptions,
  type PeerFileTransferResult,
  type SSHConnectionConfig,
  type FileSystemEntry,
  type FileStatInfo,
} from "../types";
import {
  DEFAULT_SFTP_TRANSFER_PROFILES,
  SftpAdaptiveTransferTuner,
  type SftpTransferDirection,
  type SftpTransferProfile,
} from "./ssh/SftpAdaptiveTransferTuner";
import { SshDirectFileTransfer } from "./ssh/SshDirectFileTransfer";
import {
  buildWindowsPowerShellBootstrapScript,
  buildWindowsPowerShellBootstrapLoaderEncodedCommand,
  buildWindowsPowerShellDispatchInput,
  buildWindowsPowerShellEncodedCommand,
  buildWindowsPowerShellRequestMarkerPath,
  WINDOWS_POWERSHELL_COMMAND_OUTPUT_FILE_PREFIX,
  escapePowerShellSingleQuotedString,
  parseWindowsBuildNumber,
  parseWindowsPromptMarkerLine,
  parseWindowsPowerShellRequestMarkerFile,
  shouldUseWindowsPowerShellSidecar,
  WINDOWS_POWERSHELL_COMMAND_REQUEST_FILE_PREFIX,
  WINDOWS_POWERSHELL_SIDECAR_BUILD_THRESHOLD,
  WINDOWS_POWERSHELL_REMOTE_SIDECAR_DIR_NAME,
  WINDOWS_POWERSHELL_REQUEST_MARKER_MAX_UTF8_BYTES,
  WINDOWS_POWERSHELL_SIDECAR_RETENTION_MS,
  type WindowsCommandTrackingMode,
  type WindowsPromptMarkerState,
} from "./windowsPowerShellTracking";
import {
  buildCommandProtocolMarkerPrefix,
  buildInitializationReadyMarker,
  buildUnixCommandDispatcherScript,
  consumeInitializationReadyMarker,
} from "./terminal/CommandStreamProtocol";

const SSH_CONNECT_READY_TIMEOUT_MS = 20_000;
const SSH_KEEPALIVE_INTERVAL_MS = 30_000;
const SSH_KEEPALIVE_COUNT_MAX = 3;
const SSH_DIRECT_CONTROL_READY_TIMEOUT_MS = 4_000;
const WINDOWS_POWERSHELL_BOOTSTRAP_FILE_PREFIX = "gyshell-bootstrap-";

interface SshRouteConnectOptions {
  signal?: AbortSignal;
  readyTimeoutMs?: number;
  forwardTimeoutMs?: number;
}

const createRouteAbortError = (): Error => {
  const error = new Error("SSH route setup was cancelled.");
  error.name = "AbortError";
  return error;
};

interface TerminalWindowSize {
  cols: number;
  rows: number;
}

interface SSHInstance {
  client: ssh2.Client;
  sshConfig?: SSHConnectionConfig;
  stream?: ssh2.ClientChannel;
  sftp?: ssh2.SFTPWrapper;
  sftpInitPromise?: Promise<ssh2.SFTPWrapper>;
  sftpInitError?: string;
  dataCallbacks: Set<(data: string) => void>;
  exitCallbacks: Set<(code: number) => void>;
  requestedCols?: number;
  requestedRows?: number;
  isInitializing: boolean;
  buffer: string;
  commandProtocolToken: string;
  cwd?: string;
  homeDir?: string;
  remoteOs?: "unix" | "windows";
  commandShellFamily?: TerminalCommandShellFamily;
  powerShellExecutable?: "powershell.exe" | "pwsh";
  observedHostKey?: Buffer;
  systemInfo?: any;
  systemInfoPromise?: Promise<any>;
  systemInfoRetryTimer?: ReturnType<typeof setTimeout>;
  systemInfoRetryCount?: number;
  commandTrackingMode?: WindowsCommandTrackingMode;
  windowsBuildNumber?: number;
  windowsPromptMarkerPath?: string;
  windowsCommandRequestPath?: string;
  windowsCommandOutputPath?: string;
  windowsPowerShellBootstrapPath?: string;
  windowsPromptMarkerState?: WindowsPromptMarkerState;
  forwardServers: net.Server[];
  remoteForwards: Array<{ host: string; port: number }>;
  remoteForwardHandlerInstalled: boolean;
  initializationState: "initializing" | "ready" | "failed";
  exitEmitted?: boolean;
  streamDecoder: StringDecoder;
  commandProtocolAvailable?: boolean;
}

interface SftpChunkWriteSession {
  sftp: ssh2.SFTPWrapper;
  handle: Buffer;
  expectedOffset: number;
  cleanupTimer?: ReturnType<typeof setTimeout>;
}

interface WindowsBootstrapInfo {
  Version?: string;
  CSName?: string;
  Arch?: string;
  TempPath?: string;
  PSVersionMajor?: number;
}

interface BoundedWindowsCommandOutput {
  text: string;
  observedUtf8Bytes: number;
  truncated: boolean;
}

const utf8Length = (value: string): number => Buffer.byteLength(value, "utf8");

const takeUtf8Prefix = (value: string, byteLimit: number): string => {
  if (byteLimit <= 0) return "";
  let bytes = 0;
  let result = "";
  for (const scalar of value) {
    const scalarBytes = utf8Length(scalar);
    if (bytes + scalarBytes > byteLimit) break;
    result += scalar;
    bytes += scalarBytes;
  }
  return result;
};

const normalizeBoundedWindowsCommandOutput = (
  decoded: string,
  observedFileBytes: number,
): BoundedWindowsCommandOutput => {
  const text = takeUtf8Prefix(
    decoded,
    COMMAND_CAPTURE_MAX_UTF8_BYTES,
  );
  const observedUtf8Bytes = Math.max(
    0,
    Math.floor(observedFileBytes),
  );
  return {
    text,
    observedUtf8Bytes,
    truncated: observedUtf8Bytes > utf8Length(text),
  };
};

export class SSHBackend implements TerminalBackend {
  private static readonly SHELL_INIT_RETRY_INTERVAL_MS = 8000;
  private static readonly WINDOWS_SHELL_INIT_RETRY_INTERVAL_MS = 20000;
  private static readonly WINDOWS_PROMPT_MARKER_TAIL_BYTES = 8192;
  private sessions: Map<string, SSHInstance> = new Map();
  private readonly chunkWriteSessions = new Map<
    string,
    SftpChunkWriteSession
  >();
  private readonly transferTuner = new SftpAdaptiveTransferTuner({
    profiles: DEFAULT_SFTP_TRANSFER_PROFILES,
    preferredProfileId: "balanced-32x128k",
    explorationInterval: 8,
  });
  private readonly directFileTransfer = new SshDirectFileTransfer();
  private static readonly CHUNK_SESSION_IDLE_MS = 8000;
  private static readonly MAX_SFTP_READ_REQUEST_BYTES = 64 * 1024;
  private static readonly MAX_SFTP_READ_CONCURRENCY = 16;
  private static readonly FAST_TRANSFER_TIMEOUT_MIN_MS = 45_000;
  private static readonly FAST_TRANSFER_TIMEOUT_MAX_MS = 10 * 60 * 1000;
  private static readonly FAST_TRANSFER_TIMEOUT_PER_MB_MS = 12_000;
  private static readonly SYSTEM_INFO_RETRY_BASE_MS = 1500;
  private static readonly SYSTEM_INFO_RETRY_MAX_MS = 8000;
  private static readonly SYSTEM_INFO_RETRY_MAX_ATTEMPTS = 6;

  private createSshClient(): ssh2.Client {
    return new ssh2.Client();
  }

  private buildBaseConnectConfig(
    sshConfig: SSHConnectionConfig,
    sock?: ssh2.ConnectConfig["sock"],
  ): ssh2.ConnectConfig {
    return {
      host: sshConfig.host,
      port: sshConfig.port,
      username: sshConfig.username,
      readyTimeout: SSH_CONNECT_READY_TIMEOUT_MS,
      keepaliveInterval: SSH_KEEPALIVE_INTERVAL_MS,
      keepaliveCountMax: SSH_KEEPALIVE_COUNT_MAX,
      ...(sock ? { sock } : {}),
    };
  }

  private async openAgentExecutorClient(
    instance: SSHInstance,
    agentSocketPath: string,
    signal?: AbortSignal,
  ): Promise<ssh2.Client | null> {
    const sshConfig = instance.sshConfig;
    const expectedHostKey = instance.observedHostKey;
    if (signal?.aborted) throw createRouteAbortError();
    if (!sshConfig || !expectedHostKey || sshConfig.proxy) {
      return null;
    }

    let executorPrivateKey: Buffer | string | undefined;
    if (sshConfig.authMethod === "password") {
      if (!sshConfig.password) return null;
    } else {
      executorPrivateKey = sshConfig.privateKey;
      if (!executorPrivateKey && sshConfig.privateKeyPath) {
        try {
          executorPrivateKey = fs.readFileSync(sshConfig.privateKeyPath);
        } catch {
          return null;
        }
      }
      if (!executorPrivateKey) return null;
    }

    let controlSocket: net.Socket | undefined;
    if (sshConfig.jumpHost) {
      const routedSocket = await this.openDirectControlRouteSocket(
        sshConfig,
        signal,
      );
      if (!routedSocket) return null;
      controlSocket = routedSocket;
    }

    const connectConfig = this.buildBaseConnectConfig(sshConfig, controlSocket);
    connectConfig.readyTimeout = SSH_DIRECT_CONTROL_READY_TIMEOUT_MS;
    connectConfig.agent = agentSocketPath;
    connectConfig.agentForward = true;
    connectConfig.hostVerifier = (hostKey: Buffer) =>
      Buffer.from(hostKey).equals(expectedHostKey);

    if (sshConfig.authMethod === "password") {
      connectConfig.password = sshConfig.password;
      connectConfig.authHandler = ["password"];
    } else {
      connectConfig.privateKey = executorPrivateKey;
      if (sshConfig.passphrase) {
        connectConfig.passphrase = sshConfig.passphrase;
      }
      connectConfig.authHandler = ["publickey"];
    }

    const client = this.createSshClient();
    return await new Promise<ssh2.Client | null>((resolve, reject) => {
      let settled = false;
      const finish = (result: ssh2.Client | null, error?: Error): void => {
        if (settled) {
          if (result) {
            try {
              result.end();
            } catch {
              // A late-ready connection after cancellation is cleanup-only.
            }
          }
          return;
        }
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        if (!result) {
          try {
            client.end();
          } catch {
            // Failed short-lived connections have no further cleanup contract.
          }
          try {
            controlSocket?.destroy();
          } catch {
            // The routed socket may already have closed with the SSH client.
          }
        }
        if (error) reject(error);
        else resolve(result);
      };
      const onAbort = (): void => finish(null, createRouteAbortError());
      client.once("ready", () => finish(client));
      client.once("error", () => finish(null));
      client.once("close", () => finish(null));
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      try {
        client.connect(connectConfig);
      } catch {
        finish(null);
      }
    });
  }

  private async openDirectControlRouteSocket(
    sshConfig: SSHConnectionConfig,
    signal?: AbortSignal,
  ): Promise<net.Socket | null> {
    if (signal?.aborted) throw createRouteAbortError();
    return await new Promise<net.Socket | null>((resolve, reject) => {
      let settled = false;
      const finish = (socket: net.Socket | null, error?: Error): void => {
        if (settled) {
          try {
            socket?.destroy();
          } catch {
            // A late route socket after cancellation is cleanup-only.
          }
          return;
        }
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        if (error) reject(error);
        else resolve(socket);
      };
      const onAbort = (): void => finish(null, createRouteAbortError());
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      void this.buildConnectSocketIfNeeded(sshConfig, () => {}, {
        signal,
        readyTimeoutMs: SSH_DIRECT_CONTROL_READY_TIMEOUT_MS,
        forwardTimeoutMs: SSH_DIRECT_CONTROL_READY_TIMEOUT_MS,
      })
        .then((socket) => finish(socket ?? null))
        .catch((error: unknown) => {
          if (
            signal?.aborted ||
            (error as { name?: unknown } | null)?.name === "AbortError"
          ) {
            finish(null, createRouteAbortError());
            return;
          }
          finish(null);
        });
    });
  }

  private normalizeWindowSize(
    cols: number | undefined,
    rows: number | undefined,
  ): TerminalWindowSize | null {
    if (
      typeof cols !== "number" ||
      typeof rows !== "number" ||
      !Number.isFinite(cols) ||
      !Number.isFinite(rows) ||
      cols <= 0 ||
      rows <= 0
    ) {
      return null;
    }
    return {
      cols: Math.max(1, Math.floor(cols)),
      rows: Math.max(1, Math.floor(rows)),
    };
  }

  private updateRequestedWindowSize(
    instance: SSHInstance,
    cols: number,
    rows: number,
  ): TerminalWindowSize | null {
    const size = this.normalizeWindowSize(cols, rows);
    if (!size) return null;
    instance.requestedCols = size.cols;
    instance.requestedRows = size.rows;
    return size;
  }

  private resolveRequestedWindowSize(
    instance: SSHInstance,
    fallback: TerminalWindowSize,
  ): TerminalWindowSize {
    return (
      this.normalizeWindowSize(
        instance.requestedCols,
        instance.requestedRows,
      ) ||
      this.normalizeWindowSize(fallback.cols, fallback.rows) || {
        cols: 80,
        rows: 24,
      }
    );
  }

  private applyRequestedWindowSize(instance: SSHInstance): void {
    if (!instance.stream) return;
    const size = this.resolveRequestedWindowSize(instance, {
      cols: 80,
      rows: 24,
    });
    try {
      instance.stream.setWindow(size.rows, size.cols, 0, 0);
    } catch {
      // SSH window-size updates are best-effort; the latest size remains cached
      // and will be re-applied when a later resize arrives.
    }
  }

  /**
   * Public exec wrapper for ResourceMonitorService.
   * Executes a command on an existing SSH session and collects output.
   */
  async execOnSession(
    ptyId: string,
    command: string,
    timeoutMs = 6000,
    options?: TerminalExecOptions,
  ): Promise<{ stdout: string; stderr: string } | null> {
    const instance = this.sessions.get(ptyId);
    if (!instance) return null;
    try {
      return await this.execCollect(
        instance.client,
        command,
        timeoutMs,
        options,
      );
    } catch {
      return null;
    }
  }

  async tryPeerFileTransfer(
    sourcePtyId: string,
    sourcePath: string,
    targetPtyId: string,
    targetPath: string,
    options: PeerFileTransferOptions,
  ): Promise<PeerFileTransferResult> {
    const source = this.sessions.get(sourcePtyId);
    const target = this.sessions.get(targetPtyId);
    if (!source || !target) {
      return { status: "fallback", reason: "unavailable" };
    }
    if (source.remoteOs !== "unix" || target.remoteOs !== "unix") {
      return { status: "fallback", reason: "unsupported-os" };
    }
    if (
      !source.sshConfig ||
      !target.sshConfig ||
      !source.observedHostKey ||
      !target.observedHostKey
    ) {
      return { status: "fallback", reason: "missing-host-key" };
    }

    return await this.directFileTransfer.tryTransfer({
      sourceClient: source.client,
      sourceConfig: source.sshConfig,
      sourceObservedHostKey: source.observedHostKey,
      sourcePath,
      targetClient: target.client,
      targetConfig: target.sshConfig,
      targetObservedHostKey: target.observedHostKey,
      targetPath,
      openAgentExecutorClient: async (side, socketPath, signal) =>
        await this.openAgentExecutorClient(
          side === "source" ? source : target,
          socketPath,
          signal,
        ),
      options,
    });
  }

  async prepareCommandTracking(
    ptyId: string,
  ): Promise<TerminalCommandTrackingToken | undefined> {
    const instance = this.sessions.get(ptyId);
    if (
      !instance ||
      instance.commandTrackingMode !== "windows-powershell-sidecar"
    ) {
      return undefined;
    }
    let snapshot: WindowsPromptMarkerState | null = null;
    try {
      snapshot = await this.refreshWindowsPromptMarkerState(instance, {
        allowCachedFallback: false,
      });
    } catch {
      snapshot = null;
    }
    if (!snapshot) {
      const resetOk = await this.resetWindowsPromptMarker(instance);
      if (!resetOk) {
        throw new Error(
          "Unable to establish a live Windows prompt marker baseline",
        );
      }
      return {
        mode: "windows-powershell-sidecar",
        trackingScopeId: instance.commandProtocolToken,
        baselineSequence: 0,
        dispatchMode: instance.windowsCommandRequestPath
          ? "prompt-file"
          : undefined,
        dispatchInput: instance.windowsCommandRequestPath
          ? buildWindowsPowerShellDispatchInput(instance.commandProtocolToken)
          : undefined,
        displayMode: instance.windowsCommandRequestPath
          ? "synthetic-transcript"
          : undefined,
        commandRequestPath: instance.windowsCommandRequestPath,
        commandOutputPath: instance.windowsCommandOutputPath,
      };
    }
    if (!(await this.resetWindowsPromptMarker(instance))) {
      throw new Error("Unable to reset the live Windows prompt marker journal");
    }
    return {
      mode: "windows-powershell-sidecar",
      trackingScopeId: instance.commandProtocolToken,
      baselineSequence: snapshot.sequence,
      dispatchMode: instance.windowsCommandRequestPath
        ? "prompt-file"
        : undefined,
      dispatchInput: instance.windowsCommandRequestPath
        ? buildWindowsPowerShellDispatchInput(instance.commandProtocolToken)
        : undefined,
      displayMode: instance.windowsCommandRequestPath
        ? "synthetic-transcript"
        : undefined,
      commandRequestPath: instance.windowsCommandRequestPath,
      commandOutputPath: instance.windowsCommandOutputPath,
    };
  }

  getCommandTrackingMode(
    ptyId: string,
  ): TerminalCommandTrackingMode | undefined {
    return this.sessions.get(ptyId)?.commandTrackingMode ===
      "windows-powershell-sidecar"
      ? "windows-powershell-sidecar"
      : undefined;
  }

  getCommandShellFamily(
    ptyId: string,
  ): TerminalCommandShellFamily | undefined {
    return this.sessions.get(ptyId)?.commandShellFamily;
  }

  async pollCommandTracking(
    ptyId: string,
    token: TerminalCommandTrackingToken,
  ): Promise<TerminalCommandTrackingUpdate | undefined> {
    if (token.mode !== "windows-powershell-sidecar") {
      return undefined;
    }
    const instance = this.sessions.get(ptyId);
    if (
      !instance ||
      instance.commandTrackingMode !== "windows-powershell-sidecar"
    ) {
      return undefined;
    }
    if (
      token.trackingScopeId &&
      instance.commandProtocolToken !== token.trackingScopeId
    ) {
      return undefined;
    }
    const snapshot = token.awaitingInitialFreshMarker
      ? await this.refreshWindowsPromptMarkerStateViaExec(instance, {
          allowCachedFallback: false,
          expectedRequestId: token.expectedRequestId,
        })
      : await this.refreshWindowsPromptMarkerState(instance, {
          expectedRequestId: token.expectedRequestId,
        });
    if (!snapshot || snapshot.sequence <= token.baselineSequence) {
      return undefined;
    }
    if (
      this.sessions.get(ptyId) !== instance ||
      (token.trackingScopeId &&
        instance.commandProtocolToken !== token.trackingScopeId)
    ) {
      return undefined;
    }
    if (
      token.expectedRequestId &&
      snapshot.requestId !== token.expectedRequestId
    ) {
      return undefined;
    }
    const preferExecOutputRead = Boolean(token.awaitingInitialFreshMarker);
    if (token.awaitingInitialFreshMarker) {
      token.awaitingInitialFreshMarker = false;
    }
    const output = await this.readWindowsCommandOutputBestEffort(
      instance,
      token.commandOutputPath || instance.windowsCommandOutputPath,
      { preferExec: preferExecOutputRead },
    );
    if (
      this.sessions.get(ptyId) !== instance ||
      (token.trackingScopeId &&
        instance.commandProtocolToken !== token.trackingScopeId)
    ) {
      return undefined;
    }
    if (token.expectCommandOutput && token.commandOutputPath && !output) {
      throw new Error("Windows sidecar output file is not readable yet");
    }
    if (token.expectCommandOutput && output) {
      if (snapshot.outputRetainedUtf8Bytes === undefined) {
        throw new Error(
          "Windows sidecar completion marker has no retained output length",
        );
      }
      if (output.observedUtf8Bytes !== snapshot.outputRetainedUtf8Bytes) {
        throw new Error(
          "Windows sidecar output file length does not match its completion marker",
        );
      }
      if (utf8Length(output.text) !== output.observedUtf8Bytes) {
        throw new Error(
          "Windows sidecar output file was not read as one complete UTF-8 transcript",
        );
      }
    }
    if (token.expectedRequestId && instance.windowsPromptMarkerPath) {
      const completedMarkerPath = buildWindowsPowerShellRequestMarkerPath(
        instance.windowsPromptMarkerPath,
        token.expectedRequestId,
      );
      try {
        const sftp = await this.initializeSftp(instance);
        await this.sftpUnlink(
          sftp,
          this.normalizeRemotePath(completedMarkerPath),
        );
      } catch {
        // The runtime-scoped marker is also removed on terminal cleanup and by
        // stale-sidecar retention. A transient unlink failure cannot revoke a
        // completion whose marker and output were already fully validated.
      }
    }
    return {
      mode: "windows-powershell-sidecar",
      sequence: snapshot.sequence,
      exitCode: snapshot.exitCode,
      outcomeKnown: snapshot.outcomeKnown,
      requestId: snapshot.requestId,
      cwd: snapshot.cwd,
      homeDir: snapshot.homeDir,
      output: output?.text,
      outputObservedUtf8Bytes:
        snapshot.outputObservedUtf8Bytes ?? output?.observedUtf8Bytes,
      outputRetainedUtf8Bytes:
        snapshot.outputRetainedUtf8Bytes ?? output?.observedUtf8Bytes,
      outputTruncated: snapshot.outputTruncated ?? output?.truncated,
    };
  }

  async refreshSessionState(ptyId: string): Promise<void> {
    const instance = this.sessions.get(ptyId);
    if (
      !instance ||
      instance.commandTrackingMode !== "windows-powershell-sidecar"
    ) {
      return;
    }
    await this.refreshWindowsPromptMarkerState(instance);
  }

  private clearSystemInfoRetry(instance: SSHInstance): void {
    if (instance.systemInfoRetryTimer) {
      clearTimeout(instance.systemInfoRetryTimer);
      instance.systemInfoRetryTimer = undefined;
    }
    instance.systemInfoRetryCount = 0;
  }

  private scheduleSystemInfoRetry(ptyId: string): void {
    const instance = this.sessions.get(ptyId);
    if (
      !instance ||
      instance.systemInfo ||
      instance.systemInfoPromise ||
      instance.systemInfoRetryTimer
    ) {
      return;
    }
    if (instance.initializationState === "failed") {
      return;
    }
    const nextAttempt = (instance.systemInfoRetryCount || 0) + 1;
    if (nextAttempt > SSHBackend.SYSTEM_INFO_RETRY_MAX_ATTEMPTS) {
      return;
    }
    instance.systemInfoRetryCount = nextAttempt;
    const delayMs = Math.min(
      SSHBackend.SYSTEM_INFO_RETRY_BASE_MS *
        Math.max(1, 2 ** (nextAttempt - 1)),
      SSHBackend.SYSTEM_INFO_RETRY_MAX_MS,
    );
    instance.systemInfoRetryTimer = setTimeout(() => {
      const current = this.sessions.get(ptyId);
      if (!current) {
        return;
      }
      current.systemInfoRetryTimer = undefined;
      void this.getSystemInfo(ptyId);
    }, delayMs);
  }

  private async execCollect(
    client: ssh2.Client,
    command: string,
    timeoutMs = 6000,
    options?: TerminalExecOptions,
  ): Promise<{ stdout: string; stderr: string }> {
    return await new Promise((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      const stdoutDecoder = new StringDecoder("utf8");
      const stderrDecoder = new StringDecoder("utf8");
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`exec timeout: ${command}`));
      }, timeoutMs);

      client.exec(command, (err, stream) => {
        if (err) {
          clearTimeout(timer);
          reject(err);
          return;
        }

        stream.on("data", (d: Buffer) => {
          stdout += stdoutDecoder.write(d);
        });
        stream.stderr.on("data", (d: Buffer) => {
          stderr += stderrDecoder.write(d);
        });
        stream.on("close", () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          stdout += stdoutDecoder.end();
          stderr += stderrDecoder.end();
          resolve({ stdout, stderr });
        });
        if (options?.stdin !== undefined) {
          try {
            stream.end(options.stdin);
          } catch (error) {
            clearTimeout(timer);
            reject(error);
            return;
          }
        }
      });
    });
  }

  private async detectCommandShellFamily(
    instance: SSHInstance,
  ): Promise<TerminalCommandShellFamily> {
    const markerSuffix = instance.commandProtocolToken;
    const powerShellMarker = `__GYSHELL_SHELL_POWERSHELL__${markerSuffix}`;
    const unixMarker = `__GYSHELL_SHELL_UNIX__${markerSuffix}`;

    try {
      const result = await this.execCollect(
        instance.client,
        `if ($null -ne $PSVersionTable) { [Console]::Out.Write('${powerShellMarker}') }`,
        6000,
      );
      if (String(result.stdout || "").includes(powerShellMarker)) {
        instance.powerShellExecutable =
          instance.remoteOs === "windows" ? "powershell.exe" : "pwsh";
        return "powershell";
      }
    } catch {
      // A POSIX login shell rejects the PowerShell-only probe.
    }

    try {
      const result = await this.execCollect(
        instance.client,
        `if [ -n "\${BASH_VERSION-}\${ZSH_VERSION-}" ]; then printf '%s' '${unixMarker}'; fi`,
        6000,
      );
      if (String(result.stdout || "").includes(unixMarker)) {
        return "unix";
      }
    } catch {
      // cmd.exe and PowerShell reject the POSIX-only probe.
    }

    const fallback = instance.remoteOs === "windows" ? "powershell" : "unix";
    if (fallback === "powershell") {
      instance.powerShellExecutable = "powershell.exe";
    }
    return fallback;
  }

  private getPowerShellExecutable(instance: SSHInstance): "powershell.exe" | "pwsh" {
    return (
      instance.powerShellExecutable ||
      (instance.remoteOs === "unix" ? "pwsh" : "powershell.exe")
    );
  }

  private normalizePowerShellPath(instance: SSHInstance, filePath: string): string {
    const normalized = this.normalizeRemotePath(filePath);
    return instance.remoteOs === "unix"
      ? normalized
      : normalized.replace(/\//g, "\\");
  }

  private buildPowerShellEncodedInvocation(
    instance: SSHInstance,
    encoded: string,
    options?: { noExit?: boolean; bypassExecutionPolicy?: boolean },
  ): string {
    const executable = this.getPowerShellExecutable(instance);
    const lifecycleArg = options?.noExit ? "-NoExit" : "-NonInteractive";
    const executionPolicy =
      options?.bypassExecutionPolicy && instance.remoteOs !== "unix"
        ? " -ExecutionPolicy Bypass"
        : "";
    return `${executable} -NoLogo -NoProfile ${lifecycleArg}${executionPolicy} -EncodedCommand ${encoded}`;
  }

  private buildWindowsBootstrapInfoCommand(instance: SSHInstance): string {
    const script = [
      "$utf8=[System.Text.UTF8Encoding]::new($false)",
      "[Console]::OutputEncoding=$utf8",
      "$OutputEncoding=$utf8",
      "$json=([pscustomobject]@{Version=[Environment]::OSVersion.Version.ToString();CSName=$env:COMPUTERNAME;Arch=$(if([Environment]::Is64BitOperatingSystem){'x64'}else{'x86'});TempPath=[IO.Path]::GetTempPath();PSVersionMajor=$PSVersionTable.PSVersion.Major}|ConvertTo-Json -Compress)",
      "$bytes=$utf8.GetBytes($json)",
      "[Console]::OpenStandardOutput().Write($bytes,0,$bytes.Length)",
    ].join(";");
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    return this.buildPowerShellEncodedInvocation(instance, encoded);
  }

  private shouldUseWindowsPowerShellSidecar(instance: SSHInstance): boolean {
    return shouldUseWindowsPowerShellSidecar({
      buildNumber: instance.windowsBuildNumber,
      shell: String(
        instance.systemInfo?.shell || this.getPowerShellExecutable(instance),
      ),
      trackingChannelAvailable: !instance.sftpInitError,
    });
  }

  private hasReliableWindowsCommandProtocol(instance: SSHInstance): boolean {
    if (instance.commandTrackingMode === "windows-powershell-sidecar") {
      return Boolean(
        instance.sftp &&
          !instance.sftpInitError &&
          instance.windowsPromptMarkerPath &&
          instance.windowsCommandRequestPath &&
          instance.windowsCommandOutputPath &&
          instance.windowsPowerShellBootstrapPath,
      );
    }
    const buildNumber = instance.windowsBuildNumber;
    if (!buildNumber) {
      return false;
    }
    return (
      buildNumber >= WINDOWS_POWERSHELL_SIDECAR_BUILD_THRESHOLD &&
      instance.commandTrackingMode === "shell-integration"
    );
  }

  private buildWindowsPromptMarkerPath(
    tempPath: string,
    ptyId: string,
  ): string {
    return `${this.buildWindowsPromptMarkerDirectory(tempPath)}/gyshell-prompt-${ptyId}.log`;
  }

  private buildWindowsCommandRequestPath(
    tempPath: string,
    ptyId: string,
  ): string {
    return `${this.buildWindowsPromptMarkerDirectory(tempPath)}/${WINDOWS_POWERSHELL_COMMAND_REQUEST_FILE_PREFIX}${ptyId}.b64`;
  }

  private buildWindowsCommandOutputPath(
    tempPath: string,
    ptyId: string,
  ): string {
    return `${this.buildWindowsPromptMarkerDirectory(tempPath)}/${WINDOWS_POWERSHELL_COMMAND_OUTPUT_FILE_PREFIX}${ptyId}.txt`;
  }

  private buildWindowsPowerShellBootstrapPath(
    tempPath: string,
    runtimeToken: string,
  ): string {
    return `${this.buildWindowsPromptMarkerDirectory(tempPath)}/${WINDOWS_POWERSHELL_BOOTSTRAP_FILE_PREFIX}${runtimeToken}.ps1`;
  }

  private buildWindowsPromptMarkerDirectory(tempPath: string): string {
    const normalizedTemp = this.normalizeRemotePath(tempPath).replace(
      /\/+$/,
      "",
    );
    return `${normalizedTemp}/${WINDOWS_POWERSHELL_REMOTE_SIDECAR_DIR_NAME}`;
  }

  private buildWindowsPowerShellEncodedCommand(options?: {
    commandTrackingMode?: SSHInstance["commandTrackingMode"];
    promptMarkerPath?: string;
    commandRequestPath?: string;
    commandOutputPath?: string;
    commandProtocolToken?: string;
  }): string {
    return buildWindowsPowerShellEncodedCommand({
      readyMarker: buildInitializationReadyMarker(
        options?.commandProtocolToken,
      ),
      commandTrackingMode: options?.commandTrackingMode || "shell-integration",
      promptMarkerPath: options?.promptMarkerPath,
      commandRequestPath: options?.commandRequestPath,
      commandOutputPath: options?.commandOutputPath,
      commandProtocolToken: options?.commandProtocolToken,
    });
  }

  private buildWindowsPowerShellBootstrapScript(options: {
    commandTrackingMode: WindowsCommandTrackingMode;
    promptMarkerPath?: string;
    commandRequestPath?: string;
    commandOutputPath?: string;
    commandProtocolToken: string;
  }): string {
    return buildWindowsPowerShellBootstrapScript({
      readyMarker: buildInitializationReadyMarker(
        options.commandProtocolToken,
      ),
      ...options,
    });
  }

  private buildWindowsPowerShellLaunchCommand(instance: SSHInstance): string {
    if (
      instance.commandTrackingMode === "windows-powershell-sidecar" &&
      instance.windowsPowerShellBootstrapPath
    ) {
      const loader = buildWindowsPowerShellBootstrapLoaderEncodedCommand(
        this.normalizePowerShellPath(
          instance,
          instance.windowsPowerShellBootstrapPath,
        ),
      );
      return this.buildPowerShellEncodedInvocation(instance, loader, {
        noExit: true,
        bypassExecutionPolicy: true,
      });
    }
    const encoded = this.buildWindowsPowerShellEncodedCommand({
      commandTrackingMode: instance.commandTrackingMode,
      promptMarkerPath: instance.windowsPromptMarkerPath,
      commandRequestPath: instance.windowsCommandRequestPath,
      commandOutputPath: instance.windowsCommandOutputPath,
      commandProtocolToken: instance.commandProtocolToken,
    });
    return this.buildPowerShellEncodedInvocation(instance, encoded, {
      noExit: true,
    });
  }

  private getShellInitRetryIntervalMs(
    shellFamily: TerminalCommandShellFamily | undefined,
  ): number {
    return shellFamily === "powershell"
      ? SSHBackend.WINDOWS_SHELL_INIT_RETRY_INTERVAL_MS
      : SSHBackend.SHELL_INIT_RETRY_INTERVAL_MS;
  }

  private async bootstrapWindowsSession(instance: SSHInstance): Promise<void> {
    try {
      const info = await this.execCollect(
        instance.client,
        this.buildWindowsBootstrapInfoCommand(instance),
        10000,
      );
      const parsed = JSON.parse(info.stdout || "{}") as WindowsBootstrapInfo;
      const release = String(parsed.Version || "").trim();
      const tempPath = String(parsed.TempPath || "").trim();
      if (instance.remoteOs !== "unix") {
        instance.systemInfo = {
          os: "Windows",
          platform: "win32",
          release,
          arch: String(parsed.Arch || "").trim(),
          hostname: String(parsed.CSName || "").trim(),
          isRemote: true,
          shell: this.getPowerShellExecutable(instance),
        };
        instance.windowsBuildNumber = parseWindowsBuildNumber(release);
      }
      instance.commandTrackingMode = this.shouldUseWindowsPowerShellSidecar(
        instance,
      )
        ? "windows-powershell-sidecar"
        : "shell-integration";
      if (instance.commandTrackingMode === "windows-powershell-sidecar") {
        const fallbackTempPath =
          tempPath ||
          (instance.remoteOs === "unix" ? "/tmp" : "C:/Windows/Temp");
        await this.cleanupStaleWindowsPromptMarkers(instance, fallbackTempPath);
        // The public SSH config id and pty id are intentionally stable across
        // reconnects. Sidecar paths must not be: a delayed SFTP write from an
        // abandoned runtime could otherwise overwrite a replacement command.
        // The command protocol token is random for every spawned SSH runtime.
        const runtimeSidecarId = instance.commandProtocolToken;
        instance.windowsPromptMarkerPath = this.buildWindowsPromptMarkerPath(
          fallbackTempPath,
          runtimeSidecarId,
        );
        instance.windowsCommandRequestPath =
          this.buildWindowsCommandRequestPath(
            fallbackTempPath,
            runtimeSidecarId,
          );
        instance.windowsCommandOutputPath = this.buildWindowsCommandOutputPath(
          fallbackTempPath,
          runtimeSidecarId,
        );
        instance.windowsPowerShellBootstrapPath =
          this.buildWindowsPowerShellBootstrapPath(
            fallbackTempPath,
            runtimeSidecarId,
          );
        const bootstrapDirectory = this.normalizePowerShellPath(
          instance,
          dirname(instance.windowsPowerShellBootstrapPath),
        );
        const createDirectoryScript =
          `[IO.Directory]::CreateDirectory('${escapePowerShellSingleQuotedString(bootstrapDirectory)}')|Out-Null`;
        const createDirectoryEncoded = Buffer.from(
          createDirectoryScript,
          "utf16le",
        ).toString("base64");
        await this.execCollect(
          instance.client,
          this.buildPowerShellEncodedInvocation(
            instance,
            createDirectoryEncoded,
          ),
          6000,
        );
        const bootstrapScript = this.buildWindowsPowerShellBootstrapScript({
          commandTrackingMode: "windows-powershell-sidecar",
          promptMarkerPath: instance.windowsPromptMarkerPath,
          commandRequestPath: instance.windowsCommandRequestPath,
          commandOutputPath: instance.windowsCommandOutputPath,
          commandProtocolToken: instance.commandProtocolToken,
        });
        const sftp = await this.initializeSftp(instance);
        await this.sftpWriteFile(
          sftp,
          this.normalizeRemotePath(instance.windowsPowerShellBootstrapPath),
          Buffer.concat([
            Buffer.from([0xef, 0xbb, 0xbf]),
            Buffer.from(bootstrapScript, "utf8"),
          ]),
        );
      } else {
        instance.windowsPromptMarkerPath = undefined;
        instance.windowsCommandRequestPath = undefined;
        instance.windowsCommandOutputPath = undefined;
        instance.windowsPowerShellBootstrapPath = undefined;
      }
      instance.windowsPromptMarkerState = undefined;
    } catch {
      instance.commandTrackingMode = "shell-integration";
      instance.windowsPromptMarkerPath = undefined;
      instance.windowsCommandRequestPath = undefined;
      instance.windowsCommandOutputPath = undefined;
      instance.windowsPowerShellBootstrapPath = undefined;
    }
  }

  private async cleanupStaleWindowsPromptMarkers(
    instance: SSHInstance,
    tempPath: string,
  ): Promise<void> {
    const markerDir = this.normalizePowerShellPath(
      instance,
      this.buildWindowsPromptMarkerDirectory(tempPath),
    );
    const cutoffDays = Math.floor(
      WINDOWS_POWERSHELL_SIDECAR_RETENTION_MS / (24 * 60 * 60 * 1000),
    );
    const script = [
      `$__gyshell_marker_dir='${escapePowerShellSingleQuotedString(markerDir)}'`,
      `if(Test-Path -LiteralPath $__gyshell_marker_dir){Get-ChildItem -LiteralPath $__gyshell_marker_dir -File -ErrorAction SilentlyContinue|Where-Object{($_.Name -like 'gyshell-prompt-*.log' -or $_.Name -like 'gyshell-prompt-*.log.*' -or $_.Name -like '${WINDOWS_POWERSHELL_COMMAND_REQUEST_FILE_PREFIX}*.b64' -or $_.Name -like '${WINDOWS_POWERSHELL_COMMAND_OUTPUT_FILE_PREFIX}*.txt' -or $_.Name -like '${WINDOWS_POWERSHELL_BOOTSTRAP_FILE_PREFIX}*.ps1') -and $_.LastWriteTimeUtc -lt (Get-Date).ToUniversalTime().AddDays(-${cutoffDays})}|Remove-Item -Force -ErrorAction SilentlyContinue}`,
    ].join(";");
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    try {
      await this.execCollect(
        instance.client,
        this.buildPowerShellEncodedInvocation(instance, encoded),
        6000,
      );
    } catch {
      // ignore best-effort stale temp cleanup failures
    }
  }

  private async resetWindowsPromptMarker(
    instance: SSHInstance,
  ): Promise<boolean> {
    if (!instance.windowsPromptMarkerPath) {
      return false;
    }
    const markerPath = this.normalizePowerShellPath(
      instance,
      instance.windowsPromptMarkerPath,
    );
    const script = [
      "$__gyshell_utf8=[Text.UTF8Encoding]::new($false)",
      "$OutputEncoding=$__gyshell_utf8",
      `$__gyshell_marker_path='${escapePowerShellSingleQuotedString(markerPath)}'`,
      "[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($__gyshell_marker_path))|Out-Null",
      "[IO.File]::WriteAllText($__gyshell_marker_path,'',$__gyshell_utf8)",
    ].join(";");
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    try {
      await this.execCollect(
        instance.client,
        this.buildPowerShellEncodedInvocation(instance, encoded),
        6000,
      );
      instance.windowsPromptMarkerState = undefined;
      return true;
    } catch {
      return false;
    }
  }

  private async readWindowsPromptMarkerState(
    instance: SSHInstance,
    expectedRequestId?: string,
  ): Promise<WindowsPromptMarkerState | null> {
    if (!instance.windowsPromptMarkerPath) {
      return null;
    }
    const sftp = await this.initializeSftp(instance);
    const markerPath = expectedRequestId
      ? buildWindowsPowerShellRequestMarkerPath(
          instance.windowsPromptMarkerPath,
          expectedRequestId,
        )
      : instance.windowsPromptMarkerPath;
    const normalizedPath = this.normalizeRemotePath(markerPath);
    let stats: ssh2.Stats;
    try {
      stats = await this.sftpStat(sftp, normalizedPath);
    } catch (error: any) {
      if (error?.code === 2 || error?.code === "ENOENT") {
        return null;
      }
      throw error;
    }

    const totalSize = Math.max(0, Number(stats.size) || 0);
    if (totalSize <= 0) {
      if (expectedRequestId) {
        throw new Error("Windows sidecar request marker is empty.");
      }
      return null;
    }

    if (
      expectedRequestId &&
      totalSize > WINDOWS_POWERSHELL_REQUEST_MARKER_MAX_UTF8_BYTES
    ) {
      throw new Error("Windows sidecar request marker exceeds its protocol limit.");
    }

    const readSize = expectedRequestId
      ? totalSize
      : Math.min(totalSize, SSHBackend.WINDOWS_PROMPT_MARKER_TAIL_BYTES);
    const startOffset = expectedRequestId ? 0 : Math.max(0, totalSize - readSize);
    const handle = await this.sftpOpen(sftp, normalizedPath, "r");
    try {
      const buffer = Buffer.allocUnsafe(readSize);
      const bytesRead = await this.sftpReadDirect(
        sftp,
        handle,
        buffer,
        0,
        readSize,
        startOffset,
      );
      if (bytesRead <= 0) {
        if (expectedRequestId) {
          throw new Error("Windows sidecar request marker could not be read.");
        }
        return null;
      }
      const text = buffer.subarray(0, bytesRead).toString("utf8");
      const exactRequestMarker = expectedRequestId
        ? parseWindowsPowerShellRequestMarkerFile(text, expectedRequestId)
        : undefined;
      if (expectedRequestId && !exactRequestMarker) {
        throw new Error("Windows sidecar request marker is malformed.");
      }
      const candidates: Array<string | WindowsPromptMarkerState> = exactRequestMarker
        ? [exactRequestMarker]
        : text.split(/\r?\n/);
      for (let index = candidates.length - 1; index >= 0; index -= 1) {
        const candidate = candidates[index];
        const parsed = typeof candidate === "string"
          ? parseWindowsPromptMarkerLine(candidate)
          : candidate;
        if (parsed) {
          if (expectedRequestId && parsed.requestId !== expectedRequestId) {
            continue;
          }
          return {
            sequence: parsed.sequence,
            exitCode: parsed.exitCode,
            outcomeKnown: parsed.outcomeKnown,
            requestId: parsed.requestId,
            outputObservedUtf8Bytes: parsed.outputObservedUtf8Bytes,
            outputRetainedUtf8Bytes: parsed.outputRetainedUtf8Bytes,
            outputTruncated: parsed.outputTruncated,
            cwd: parsed.cwd
              ? this.normalizeDecodedRemotePath(parsed.cwd) || undefined
              : undefined,
            homeDir: parsed.homeDir
              ? this.normalizeDecodedRemotePath(parsed.homeDir) || undefined
              : undefined,
            modifiedAtMs: Number.isFinite(Number((stats as any).mtime))
              ? Number((stats as any).mtime) * 1000
              : undefined,
          };
        }
      }
      return null;
    } finally {
      await this.sftpClose(sftp, handle).catch(() => {});
    }
  }

  private async refreshWindowsPromptMarkerState(
    instance: SSHInstance,
    options?: {
      allowCachedFallback?: boolean;
      expectedRequestId?: string;
    },
  ): Promise<WindowsPromptMarkerState | null> {
    let next: WindowsPromptMarkerState | null = null;
    try {
      next = await this.readWindowsPromptMarkerState(
        instance,
        options?.expectedRequestId,
      );
    } catch (error) {
      next = await this.readWindowsPromptMarkerStateViaExec(
        instance,
        options?.expectedRequestId,
      ).catch(() => {
        throw error;
      });
    }
    return this.applyWindowsPromptMarkerState(instance, next, options);
  }

  private async refreshWindowsPromptMarkerStateViaExec(
    instance: SSHInstance,
    options?: {
      allowCachedFallback?: boolean;
      expectedRequestId?: string;
    },
  ): Promise<WindowsPromptMarkerState | null> {
    const next = await this.readWindowsPromptMarkerStateViaExec(
      instance,
      options?.expectedRequestId,
    );
    return this.applyWindowsPromptMarkerState(instance, next, options);
  }

  private applyWindowsPromptMarkerState(
    instance: SSHInstance,
    next: WindowsPromptMarkerState | null,
    options?: {
      allowCachedFallback?: boolean;
      expectedRequestId?: string;
    },
  ): WindowsPromptMarkerState | null {
    if (!next) {
      if (options?.expectedRequestId) {
        return null;
      }
      if (options?.allowCachedFallback === false) {
        return null;
      }
      const cached = instance.windowsPromptMarkerState;
      if (
        options?.expectedRequestId &&
        cached?.requestId !== options.expectedRequestId
      ) {
        return null;
      }
      return cached || null;
    }
    if (options?.expectedRequestId) {
      return next;
    }
    instance.windowsPromptMarkerState = next;
    if (next.cwd) {
      instance.cwd = next.cwd;
    }
    if (next.homeDir) {
      instance.homeDir = next.homeDir;
    }
    return next;
  }

  private async readWindowsPromptMarkerStateViaExec(
    instance: SSHInstance,
    expectedRequestId?: string,
  ): Promise<WindowsPromptMarkerState | null> {
    if (!instance.windowsPromptMarkerPath) {
      return null;
    }
    const sourceMarkerPath = expectedRequestId
      ? buildWindowsPowerShellRequestMarkerPath(
          instance.windowsPromptMarkerPath,
          expectedRequestId,
        )
      : instance.windowsPromptMarkerPath;
    const markerPath = this.normalizePowerShellPath(instance, sourceMarkerPath);
    const readMarkerBody = expectedRequestId
      ? `$__gyshell_length=(Get-Item -LiteralPath $__gyshell_marker_path).Length;if($__gyshell_length -gt ${WINDOWS_POWERSHELL_REQUEST_MARKER_MAX_UTF8_BYTES}){[Console]::Error.WriteLine('__GYSHELL_REQUEST_MARKER_OVERSIZE__='+$__gyshell_length)}else{$__gyshell_text=[IO.File]::ReadAllText($__gyshell_marker_path,$__gyshell_utf8)}`
      : "$__gyshell_lines=@(Get-Content -LiteralPath $__gyshell_marker_path -Tail 128 -ErrorAction SilentlyContinue);$__gyshell_text=[string]::Join([Environment]::NewLine,[string[]]$__gyshell_lines)";
    const script = [
      "$__gyshell_utf8=[Text.UTF8Encoding]::new($false)",
      "[Console]::OutputEncoding=$__gyshell_utf8",
      "$OutputEncoding=$__gyshell_utf8",
      `$__gyshell_marker_path='${escapePowerShellSingleQuotedString(markerPath)}'`,
      `if(Test-Path -LiteralPath $__gyshell_marker_path){${expectedRequestId ? "[Console]::Error.WriteLine('__GYSHELL_REQUEST_MARKER_EXISTS__=1');" : ""}${readMarkerBody};if(-not [string]::IsNullOrEmpty($__gyshell_text)){$__gyshell_bytes=$__gyshell_utf8.GetBytes($__gyshell_text);[Console]::OpenStandardOutput().Write($__gyshell_bytes,0,$__gyshell_bytes.Length)}}`,
    ].join(";");
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    const result = await this.execCollect(
      instance.client,
      this.buildPowerShellEncodedInvocation(instance, encoded),
      6000,
    );
    if (
      expectedRequestId &&
      /(?:^|\r?\n)__GYSHELL_REQUEST_MARKER_OVERSIZE__=\d+(?:\r?\n|$)/.test(
        String(result.stderr || ""),
      )
    ) {
      throw new Error("Windows sidecar request marker exceeds its protocol limit.");
    }
    const exactMarkerExists =
      expectedRequestId &&
      /(?:^|\r?\n)__GYSHELL_REQUEST_MARKER_EXISTS__=1(?:\r?\n|$)/.test(
        String(result.stderr || ""),
      );
    const text = String(result.stdout || "").trim();
    if (!text) {
      if (exactMarkerExists) {
        throw new Error("Windows sidecar request marker is empty.");
      }
      return null;
    }
    const parseLines = (
      source: string,
      modifiedAtMs?: number,
    ): WindowsPromptMarkerState | null => {
      const lines = source.split(/\r?\n/);
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const parsed = parseWindowsPromptMarkerLine(lines[index] || "");
        if (parsed) {
          if (expectedRequestId && parsed.requestId !== expectedRequestId) {
            continue;
          }
          return {
            sequence: parsed.sequence,
            exitCode: parsed.exitCode,
            outcomeKnown: parsed.outcomeKnown,
            requestId: parsed.requestId,
            outputObservedUtf8Bytes: parsed.outputObservedUtf8Bytes,
            outputRetainedUtf8Bytes: parsed.outputRetainedUtf8Bytes,
            outputTruncated: parsed.outputTruncated,
            cwd: parsed.cwd
              ? this.normalizeDecodedRemotePath(parsed.cwd) || undefined
              : undefined,
            homeDir: parsed.homeDir
              ? this.normalizeDecodedRemotePath(parsed.homeDir) || undefined
              : undefined,
            modifiedAtMs,
          };
        }
      }
      return null;
    };
    if (expectedRequestId) {
      const exact = parseWindowsPowerShellRequestMarkerFile(
        text,
        expectedRequestId,
      );
      if (!exact) {
        throw new Error("Windows sidecar request marker is malformed.");
      }
      return {
        ...exact,
        cwd: exact.cwd
          ? this.normalizeDecodedRemotePath(exact.cwd) || undefined
          : undefined,
        homeDir: exact.homeDir
          ? this.normalizeDecodedRemotePath(exact.homeDir) || undefined
          : undefined,
      };
    }
    return parseLines(text);
  }

  private async readWindowsCommandOutput(
    instance: SSHInstance,
    outputPath: string,
  ): Promise<BoundedWindowsCommandOutput | undefined> {
    const sftp = await this.initializeSftp(instance);
    const normalizedPath = this.normalizeRemotePath(outputPath);
    let handle: Buffer | undefined;
    try {
      const stats = await this.sftpStat(sftp, normalizedPath);
      const fileBytes = Math.max(0, Number(stats.size) || 0);
      // Read a few look-ahead bytes so a scalar crossing the retention limit
      // can be decoded before the Unicode-safe prefix is selected.
      const bytesToRead = Math.min(
        fileBytes,
        COMMAND_CAPTURE_MAX_UTF8_BYTES + 6,
      );
      handle = await this.sftpOpen(sftp, normalizedPath, "r");
      const buffer = Buffer.allocUnsafe(bytesToRead);
      const bytesRead = await this.sftpReadRangeConcurrent(
        sftp,
        handle,
        buffer,
        0,
        bytesToRead,
        0,
      );
      if (bytesRead !== bytesToRead) {
        throw new Error("Windows sidecar output file changed during SFTP read");
      }
      const decoder = new StringDecoder("utf8");
      const decoded = decoder.end(buffer.subarray(0, bytesRead));
      return normalizeBoundedWindowsCommandOutput(decoded, fileBytes);
    } catch (error: any) {
      if (error?.code === 2 || error?.code === "ENOENT") {
        return undefined;
      }
      throw error;
    } finally {
      if (handle) {
        await this.sftpClose(sftp, handle).catch(() => {});
      }
    }
  }

  private async readWindowsCommandOutputViaExec(
    instance: SSHInstance,
    outputPath: string,
  ): Promise<BoundedWindowsCommandOutput | undefined> {
    const normalizedPath = this.normalizePowerShellPath(instance, outputPath);
    const readLimit = COMMAND_CAPTURE_MAX_UTF8_BYTES + 6;
    const script = [
      `$__gyshell_output_path='${escapePowerShellSingleQuotedString(normalizedPath)}'`,
      `if(Test-Path -LiteralPath $__gyshell_output_path){$__gyshell_file=[IO.File]::Open($__gyshell_output_path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite);try{$__gyshell_length=$__gyshell_file.Length;[Console]::Error.WriteLine('__GYSHELL_OUTPUT_BYTES__='+$__gyshell_length);$__gyshell_limit=[int][Math]::Min($__gyshell_length,${readLimit});$__gyshell_bytes=New-Object byte[] $__gyshell_limit;$__gyshell_read=0;while($__gyshell_read -lt $__gyshell_limit){$__gyshell_part=$__gyshell_file.Read($__gyshell_bytes,$__gyshell_read,$__gyshell_limit-$__gyshell_read);if($__gyshell_part -le 0){break};$__gyshell_read+=$__gyshell_part};[Console]::OpenStandardOutput().Write($__gyshell_bytes,0,$__gyshell_read);[Console]::Error.WriteLine('__GYSHELL_OUTPUT_READ__='+$__gyshell_read)}finally{$__gyshell_file.Dispose()}}`,
    ].join(";");
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    const result = await this.execCollect(
      instance.client,
      this.buildPowerShellEncodedInvocation(instance, encoded),
      6000,
    );
    const marker = String(result.stderr || "").match(
      /(?:^|\r?\n)__GYSHELL_OUTPUT_BYTES__=(\d+)(?:\r?\n|$)/,
    );
    const readMarker = String(result.stderr || "").match(
      /(?:^|\r?\n)__GYSHELL_OUTPUT_READ__=(\d+)(?:\r?\n|$)/,
    );
    if (!marker || !readMarker) return undefined;
    const observedFileBytes = Number.parseInt(marker[1], 10);
    const actualReadBytes = Number.parseInt(readMarker[1], 10);
    const expectedReadBytes = Math.min(observedFileBytes, readLimit);
    if (
      !Number.isFinite(observedFileBytes) ||
      !Number.isFinite(actualReadBytes) ||
      actualReadBytes !== expectedReadBytes ||
      utf8Length(String(result.stdout || "")) !== actualReadBytes
    ) {
      return undefined;
    }
    return normalizeBoundedWindowsCommandOutput(
      String(result.stdout || ""),
      observedFileBytes,
    );
  }

  private async readWindowsCommandOutputBestEffort(
    instance: SSHInstance,
    outputPath: string | undefined,
    options?: { preferExec?: boolean },
  ): Promise<BoundedWindowsCommandOutput | undefined> {
    if (!outputPath) {
      return undefined;
    }
    if (options?.preferExec) {
      try {
        return await this.readWindowsCommandOutputViaExec(instance, outputPath);
      } catch {
        return undefined;
      }
    }
    try {
      return await this.readWindowsCommandOutput(instance, outputPath);
    } catch {
      try {
        return await this.readWindowsCommandOutputViaExec(instance, outputPath);
      } catch {
        return undefined;
      }
    }
  }

  private async cleanupWindowsPromptMarker(
    instance: SSHInstance,
  ): Promise<void> {
    const markerPath = instance.windowsPromptMarkerPath;
    const requestPath = instance.windowsCommandRequestPath;
    const outputPath = instance.windowsCommandOutputPath;
    const bootstrapPath = instance.windowsPowerShellBootstrapPath;
    if (!markerPath) {
      instance.windowsCommandRequestPath = undefined;
      instance.windowsCommandOutputPath = undefined;
      instance.windowsPowerShellBootstrapPath = undefined;
      return;
    }
    const sftp = instance.sftp;
    if (!sftp) {
      instance.windowsPromptMarkerPath = undefined;
      instance.windowsCommandRequestPath = undefined;
      instance.windowsCommandOutputPath = undefined;
      instance.windowsPowerShellBootstrapPath = undefined;
      instance.windowsPromptMarkerState = undefined;
      return;
    }
    try {
      await this.sftpUnlink(sftp, this.normalizeRemotePath(markerPath));
      const normalizedMarkerPath = this.normalizeRemotePath(markerPath);
      const markerDir = this.normalizeRemotePath(dirname(markerPath));
      const markerBaseName = normalizedMarkerPath.slice(
        normalizedMarkerPath.lastIndexOf("/") + 1,
      );
      try {
        const entries = await this.sftpReaddir(sftp, markerDir);
        for (const entry of entries) {
          if (
            entry.filename.startsWith(`${markerBaseName}.`) &&
            /^[a-f0-9]{32}(?:\.tmp)?$/i.test(
              entry.filename.slice(markerBaseName.length + 1),
            )
          ) {
            await this.sftpUnlink(
              sftp,
              this.joinRemotePath(markerDir, entry.filename),
            ).catch(() => {});
          }
        }
      } catch {}
      if (requestPath) {
        try {
          await this.sftpUnlink(sftp, this.normalizeRemotePath(requestPath));
        } catch {}
      }
      if (outputPath) {
        try {
          await this.sftpUnlink(sftp, this.normalizeRemotePath(outputPath));
        } catch {}
      }
      if (bootstrapPath) {
        try {
          await this.sftpUnlink(
            sftp,
            this.normalizeRemotePath(bootstrapPath),
          );
        } catch {}
      }
      try {
        await this.sftpRmdir(sftp, markerDir);
      } catch {}
      try {
        await this.sftpRmdir(
          sftp,
          this.normalizeRemotePath(dirname(markerDir)),
        );
      } catch {}
    } catch (error: any) {
      if (!(error?.code === 2 || error?.code === "ENOENT")) {
        // ignore best-effort cleanup failures
      }
    } finally {
      instance.windowsPromptMarkerPath = undefined;
      instance.windowsCommandRequestPath = undefined;
      instance.windowsCommandOutputPath = undefined;
      instance.windowsPowerShellBootstrapPath = undefined;
      instance.windowsPromptMarkerState = undefined;
    }
  }

  private async connectViaSocks5Proxy(opts: {
    proxyHost: string;
    proxyPort: number;
    proxyUsername?: string;
    proxyPassword?: string;
    dstHost: string;
    dstPort: number;
  }): Promise<net.Socket> {
    const info = await SocksClient.createConnection({
      proxy: {
        host: opts.proxyHost,
        port: opts.proxyPort,
        type: 5,
        userId: opts.proxyUsername,
        password: opts.proxyPassword,
      },
      command: "connect",
      destination: {
        host: opts.dstHost,
        port: opts.dstPort,
      },
      timeout: 10000, // 10s timeout for proxy handshake
    });

    return info.socket;
  }

  private async connectViaHttpProxy(opts: {
    proxyHost: string;
    proxyPort: number;
    proxyUsername?: string;
    proxyPassword?: string;
    dstHost: string;
    dstPort: number;
  }): Promise<net.Socket> {
    // socks library also supports HTTP proxies via type: 1 (or we can use it for CONNECT)
    // However, for maximum compatibility with standard HTTP proxies, we'll use SocksClient's HTTP support
    const info = await SocksClient.createConnection({
      proxy: {
        host: opts.proxyHost,
        port: opts.proxyPort,
        type: 5, // Default to 5, but we will check if socks supports HTTP directly or if we need another approach
        userId: opts.proxyUsername,
        password: opts.proxyPassword,
      },
      command: "connect",
      destination: {
        host: opts.dstHost,
        port: opts.dstPort,
      },
      timeout: 10000,
    }).catch(async (err) => {
      // If socks library fails or doesn't support the specific HTTP proxy,
      // we could fallback to a specialized HTTP tunnel library if needed.
      // But for now, let's stick to the most robust way.
      throw err;
    });

    return info.socket;
  }

  private async awaitRouteSocketWithCancellation(
    socketPromise: Promise<net.Socket>,
    signal?: AbortSignal,
  ): Promise<net.Socket> {
    if (!signal) return await socketPromise;
    if (signal.aborted) throw createRouteAbortError();
    return await new Promise<net.Socket>((resolve, reject) => {
      let settled = false;
      const finish = (socket?: net.Socket, error?: Error): void => {
        if (settled) {
          try {
            socket?.destroy();
          } catch {}
          return;
        }
        settled = true;
        signal.removeEventListener("abort", onAbort);
        if (error || !socket) reject(error || createRouteAbortError());
        else resolve(socket);
      };
      const onAbort = (): void => finish(undefined, createRouteAbortError());
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
        return;
      }
      void socketPromise
        .then((socket) => finish(socket))
        .catch((error) => finish(undefined, error as Error));
    });
  }

  private async buildConnectSocketIfNeeded(
    sshConfig: SSHConnectionConfig,
    emit: (data: string) => void,
    options: SshRouteConnectOptions = {},
  ): Promise<net.Socket | undefined> {
    if (options.signal?.aborted) throw createRouteAbortError();
    const routeReadyTimeoutMs =
      options.readyTimeoutMs ?? SSH_CONNECT_READY_TIMEOUT_MS;
    const routeForwardTimeoutMs =
      options.forwardTimeoutMs ?? routeReadyTimeoutMs;
    // 1. Handle Jump Host (Recursive)
    if (sshConfig.jumpHost) {
      const jumpId = `[Jump:${sshConfig.jumpHost.host}]`;
      console.log(`${jumpId} Starting jump host connection flow...`);
      emit(
        `\x1b[36m▹ ${jumpId} Establishing tunnel via jump host ${sshConfig.jumpHost.host}...\x1b[0m\r\n`,
      );

      const jumpClient = this.createSshClient();

      // Recursive call to handle nested jump hosts or proxies for the jump host itself
      const jumpSock = await this.buildConnectSocketIfNeeded(
        sshConfig.jumpHost,
        emit,
        options,
      );
      if (jumpSock) {
        console.log(
          `${jumpId} Jump host will itself connect via a proxy/nested jump.`,
        );
      }

      await new Promise<void>((resolve, reject) => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | null = null;
        const closeRoute = (): void => {
          try {
            jumpClient.end();
          } catch {}
          try {
            jumpSock?.destroy();
          } catch {}
        };
        const finish = (error?: Error): void => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          options.signal?.removeEventListener("abort", onAbort);
          if (error) {
            closeRoute();
            reject(error);
          } else {
            resolve();
          }
        };
        const onAbort = (): void => finish(createRouteAbortError());
        const jumpConnectConfig = this.buildBaseConnectConfig(
          sshConfig.jumpHost!,
          jumpSock,
        );
        jumpConnectConfig.readyTimeout = routeReadyTimeoutMs;

        if (sshConfig.jumpHost!.authMethod === "password") {
          jumpConnectConfig.password = sshConfig.jumpHost!.password;
        } else if (sshConfig.jumpHost!.authMethod === "privateKey") {
          if (sshConfig.jumpHost!.privateKey) {
            jumpConnectConfig.privateKey = sshConfig.jumpHost!.privateKey;
          } else if (sshConfig.jumpHost!.privateKeyPath) {
            try {
              jumpConnectConfig.privateKey = fs.readFileSync(
                sshConfig.jumpHost!.privateKeyPath,
              );
            } catch (e: any) {
              finish(
                new Error(`${jumpId} Failed to read private key: ${e.message}`),
              );
              return;
            }
          }
          if (sshConfig.jumpHost!.passphrase) {
            jumpConnectConfig.passphrase = sshConfig.jumpHost!.passphrase;
          }
        }

        jumpClient.once("ready", () => {
          console.log(`${jumpId} Jump host connection READY.`);
          finish();
        });

        jumpClient.once("error", (err) => {
          console.error(`${jumpId} Jump host connection ERROR:`, err);
          finish(err);
        });
        jumpClient.once("close", () => {
          finish(
            new Error(`${jumpId} Jump host closed before becoming ready.`),
          );
        });
        timer = setTimeout(
          () => finish(new Error(`${jumpId} Jump host connection timed out.`)),
          routeReadyTimeoutMs,
        );
        options.signal?.addEventListener("abort", onAbort, { once: true });
        if (options.signal?.aborted) {
          onAbort();
          return;
        }
        try {
          jumpClient.connect(jumpConnectConfig);
        } catch (error) {
          finish(error as Error);
        }
      });

      emit(
        `\x1b[32m✔ ${jumpId} Jump host ready. Requesting forward to target ${sshConfig.host}:${sshConfig.port}...\x1b[0m\r\n`,
      );
      console.log(
        `${jumpId} Requesting forwardOut to ${sshConfig.host}:${sshConfig.port}`,
      );

      // Create stream to target
      return await new Promise((resolve, reject) => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | null = null;
        const finish = (stream?: ssh2.ClientChannel, error?: Error): void => {
          if (settled) {
            try {
              stream?.close();
            } catch {}
            return;
          }
          settled = true;
          if (timer) clearTimeout(timer);
          options.signal?.removeEventListener("abort", onAbort);
          if (error || !stream) {
            try {
              jumpClient.end();
            } catch {}
            try {
              jumpSock?.destroy();
            } catch {}
            reject(error || new Error(`${jumpId} Jump forwarding failed.`));
            return;
          }
          console.log(`${jumpId} forwardOut SUCCESS. Tunnel established.`);
          // Keep the jump chain alive exactly as long as the returned stream.
          stream.once("close", () => {
            console.log(
              `${jumpId} Tunnel stream closed, ending jump client connection.`,
            );
            jumpClient.end();
          });
          resolve(stream as unknown as net.Socket);
        };
        const onAbort = (): void => finish(undefined, createRouteAbortError());
        timer = setTimeout(
          () =>
            finish(
              undefined,
              new Error(`${jumpId} Jump forwarding timed out.`),
            ),
          routeForwardTimeoutMs,
        );
        options.signal?.addEventListener("abort", onAbort, { once: true });
        if (options.signal?.aborted) {
          onAbort();
          return;
        }
        try {
          jumpClient.forwardOut(
            "127.0.0.1",
            0,
            sshConfig.host,
            sshConfig.port,
            (err, stream) => {
              if (err) {
                console.error(
                  `${jumpId} forwardOut FAILED to ${sshConfig.host}:`,
                  err,
                );
                finish(
                  undefined,
                  new Error(
                    `${jumpId} Jump host failed to forward to ${sshConfig.host}: ${err.message}`,
                  ),
                );
                return;
              }
              finish(stream);
            },
          );
        } catch (error) {
          finish(undefined, error as Error);
        }
      });
    }

    // 2. Handle Proxy
    const proxy = sshConfig.proxy;
    if (!proxy) return undefined;

    if (proxy.type === "socks5") {
      return await this.awaitRouteSocketWithCancellation(
        this.connectViaSocks5Proxy({
          proxyHost: proxy.host,
          proxyPort: proxy.port,
          proxyUsername: proxy.username,
          proxyPassword: proxy.password,
          dstHost: sshConfig.host,
          dstPort: sshConfig.port,
        }),
        options.signal,
      );
    }
    if (proxy.type === "http") {
      return await this.awaitRouteSocketWithCancellation(
        this.connectViaHttpProxy({
          proxyHost: proxy.host,
          proxyPort: proxy.port,
          proxyUsername: proxy.username,
          proxyPassword: proxy.password,
          dstHost: sshConfig.host,
          dstPort: sshConfig.port,
        }),
        options.signal,
      );
    }

    return undefined;
  }

  private async setupPortForwards(
    instance: SSHInstance,
    sshConfig: SSHConnectionConfig,
  ): Promise<void> {
    const tunnels = sshConfig.tunnels ?? [];
    if (!tunnels.length) return;

    const remoteTunnels = tunnels.filter((t) => t.type === "Remote");
    if (remoteTunnels.length && !instance.remoteForwardHandlerInstalled) {
      instance.remoteForwardHandlerInstalled = true;
      instance.client.on("tcp connection", (info: any, accept, reject) => {
        const match = remoteTunnels.find(
          (t) => t.host === info.destIP && t.port === info.destPort,
        );
        if (!match || !match.targetAddress || !match.targetPort) {
          reject?.();
          return;
        }
        const upstream = net.connect(match.targetPort, match.targetAddress);
        upstream.once("error", () => {
          try {
            reject?.();
          } catch {}
        });
        const ch = accept();
        ch.on("data", (d: Buffer) => upstream.write(d));
        upstream.on("data", (d) => ch.write(d));
        ch.on("close", () => upstream.destroy());
        upstream.on("close", () => {
          try {
            ch.close();
          } catch {}
        });
      });
    }

    for (const t of tunnels) {
      if (t.type === "Local") {
        const server = net.createServer((sock) => {
          const srcAddr = sock.remoteAddress ?? "127.0.0.1";
          const srcPort = sock.remotePort ?? 0;
          const dstAddr = t.targetAddress ?? "127.0.0.1";
          const dstPort = t.targetPort ?? 0;
          instance.client.forwardOut(
            srcAddr,
            srcPort,
            dstAddr,
            dstPort,
            (err, stream) => {
              if (err || !stream) {
                sock.destroy();
                return;
              }
              sock.pipe(stream);
              stream.pipe(sock);
              stream.on("close", () => sock.destroy());
              sock.on("close", () => {
                try {
                  stream.close();
                } catch {}
              });
            },
          );
        });
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(t.port, t.host, resolve);
        });
        instance.forwardServers.push(server);
      } else if (t.type === "Dynamic") {
        const server = net.createServer((sock) => {
          let buf = Buffer.alloc(0);
          const need = async (n: number): Promise<Buffer> => {
            while (buf.length < n) {
              const chunk = await new Promise<Buffer>((resolve, reject) => {
                const onData = (d: Buffer) => {
                  sock.off("error", onErr);
                  resolve(d);
                };
                const onErr = (e: Error) => {
                  sock.off("data", onData);
                  reject(e);
                };
                sock.once("data", onData);
                sock.once("error", onErr);
              });
              buf = Buffer.concat([buf, chunk]);
            }
            const out = buf.subarray(0, n);
            buf = buf.subarray(n);
            return out;
          };

          (async () => {
            try {
              const hello = await need(2);
              if (hello[0] !== 0x05) throw new Error("SOCKS version mismatch");
              const nMethods = hello[1];
              const methods = await need(nMethods);
              const wantsAuth = false;
              const method = wantsAuth ? 0x02 : 0x00;
              if (!methods.includes(method)) {
                sock.write(Buffer.from([0x05, 0xff]));
                sock.destroy();
                return;
              }
              sock.write(Buffer.from([0x05, method]));

              const reqHead = await need(4);
              if (reqHead[0] !== 0x05)
                throw new Error("SOCKS request version mismatch");
              const cmd = reqHead[1];
              const atyp = reqHead[3];
              if (cmd !== 0x01) {
                sock.write(
                  Buffer.from([0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0]),
                );
                sock.destroy();
                return;
              }

              let dstAddr = "";
              if (atyp === 0x01) {
                const a = await need(4);
                dstAddr = `${a[0]}.${a[1]}.${a[2]}.${a[3]}`;
              } else if (atyp === 0x03) {
                const l = await need(1);
                const name = await need(l[0]);
                dstAddr = name.toString("utf8");
              } else if (atyp === 0x04) {
                const a = await need(16);
                const parts: string[] = [];
                for (let i = 0; i < 16; i += 2) {
                  parts.push(((a[i] << 8) | a[i + 1]).toString(16));
                }
                dstAddr = parts.join(":");
              } else {
                throw new Error("Unknown ATYP");
              }
              const p = await need(2);
              const dstPort = (p[0] << 8) | p[1];

              instance.client.forwardOut(
                sock.remoteAddress ?? "127.0.0.1",
                sock.remotePort ?? 0,
                dstAddr,
                dstPort,
                (err, stream) => {
                  if (err || !stream) {
                    sock.write(
                      Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]),
                    );
                    sock.destroy();
                    return;
                  }
                  sock.write(
                    Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]),
                  );
                  if (buf.length) {
                    stream.write(buf);
                    buf = Buffer.alloc(0);
                  }
                  sock.pipe(stream);
                  stream.pipe(sock);
                  stream.on("close", () => sock.destroy());
                  sock.on("close", () => {
                    try {
                      stream.close();
                    } catch {}
                  });
                },
              );
            } catch {
              sock.destroy();
            }
          })();
        });
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(t.port, t.host, resolve);
        });
        instance.forwardServers.push(server);
      } else if (t.type === "Remote") {
        await new Promise<void>((resolve, reject) => {
          instance.client.forwardIn(t.host, t.port, (err) => {
            if (err) reject(err);
            else resolve();
          });
        });
        instance.remoteForwards.push({ host: t.host, port: t.port });
      }
    }
  }

  private emitExitOnce(
    ptyId: string,
    instance: SSHInstance,
    code: number,
  ): void {
    if (instance.exitEmitted) {
      return;
    }
    instance.exitEmitted = true;
    instance.isInitializing = false;
    if (instance.initializationState === "initializing") {
      instance.initializationState = "failed";
    }
    this.clearSystemInfoRetry(instance);
    this.closeChunkSessionsForPty(ptyId);
    for (const s of instance.forwardServers) {
      try {
        s.close();
      } catch {}
    }
    for (const rf of instance.remoteForwards) {
      try {
        instance.client.unforwardIn(rf.host, rf.port);
      } catch {}
    }
    try {
      instance.sftp?.end?.();
    } catch {}
    try {
      instance.client.end();
    } catch {}
    if (this.sessions.get(ptyId) === instance) {
      this.sessions.delete(ptyId);
    }
    void this.cleanupWindowsPromptMarker(instance).catch(() => {});
    instance.exitCallbacks.forEach((callback) => {
      try {
        callback(code);
      } catch {
        // Keep notifying the rest of the subscribers.
      }
    });
  }

  async spawn(config: TerminalConfig): Promise<string> {
    if (!isSshConnectionConfig(config)) {
      throw new Error("SSHBackend only supports ssh connections");
    }
    const sshConfig: SSHConnectionConfig = config;

    const client = new ssh2.Client();

    const instance: SSHInstance = {
      client,
      sshConfig,
      dataCallbacks: new Set(),
      exitCallbacks: new Set(),
      requestedCols: config.cols,
      requestedRows: config.rows,
      isInitializing: true,
      buffer: "",
      commandProtocolToken: randomBytes(16).toString("hex"),
      forwardServers: [],
      remoteForwards: [],
      remoteForwardHandlerInstalled: false,
      initializationState: "initializing",
      systemInfoRetryCount: 0,
      streamDecoder: new StringDecoder('utf8'),
    };
    this.sessions.set(config.id, instance);

    // Start connection process in background so we can return the ID immediately
    // and allow TerminalService to register data listeners.
    (async () => {
      const emit = (data: string) => {
        instance.dataCallbacks.forEach((cb) => cb(data));
      };
      const emitExit = (code: number) => {
        this.emitExitOnce(config.id, instance, code);
      };

      client.on("ready", async () => {
        emit("\x1b[2J\x1b[H\x1b[32m✔ Connection established.\x1b[0m\r\n");
        console.log(
          `[SSH] Connection ready for ${sshConfig.host}:${sshConfig.port}`,
        );
        try {
          emit("\x1b[36m▹ Setting up port forwards...\x1b[0m\r\n");
          console.log(`[SSH] Setting up port forwards...`);
          await this.setupPortForwards(instance, sshConfig);
        } catch (e: any) {
          console.error(`[SSH] Port forward setup failed:`, e);
          emit(`\x1b[31m✘ Port forward failed: ${e.message}\x1b[0m\r\n`);
          // We continue anyway to allow shell access
        }

        try {
          emit("\x1b[36m▹ Detecting remote OS...\x1b[0m\r\n");
          console.log(`[SSH] Detecting remote OS...`);
          const ver = await this.execCollect(client, "cmd.exe /c ver");
          const v = (ver.stdout || ver.stderr || "").toLowerCase();
          if (v.includes("windows")) instance.remoteOs = "windows";
        } catch {
          // ignore
        }
        if (!instance.remoteOs) {
          try {
            const uname = await this.execCollect(client, "uname -s");
            const u = (uname.stdout || uname.stderr || "").toLowerCase();
            if (u.includes("linux") || u.includes("darwin")) {
              instance.remoteOs = "unix";
            }
          } catch {
            // ignore
          }
        }
        if (!instance.remoteOs) instance.remoteOs = "unix";
        console.log(`[SSH] Remote OS detected: ${instance.remoteOs}`);

        instance.commandShellFamily = await this.detectCommandShellFamily(
          instance,
        );
        console.log(
          `[SSH] Command shell family detected: ${instance.commandShellFamily}`,
        );

        try {
          emit("\x1b[36m▹ Initializing SFTP channel...\x1b[0m\r\n");
          await this.initializeSftp(instance);
          emit("\x1b[32m✔ SFTP channel ready.\x1b[0m\r\n");
        } catch (error: any) {
          const message =
            error instanceof Error ? error.message : String(error);
          instance.sftpInitError = message;
          // Keep interactive shell usable even when SFTP is unavailable.
          emit(
            `\x1b[33m⚠ SFTP unavailable: ${message}. File panel features may be limited.\x1b[0m\r\n`,
          );
        }

        if (instance.commandShellFamily === "powershell") {
          try {
            await this.bootstrapWindowsSession(instance);
          } catch {
            instance.commandTrackingMode = "shell-integration";
          }
        }

        emit("\x1b[36m▹ Opening interactive shell...\x1b[0m\r\n");
        console.log(`[SSH] Opening interactive shell...`);
        const initialWindowSize = this.resolveRequestedWindowSize(instance, {
          cols: config.cols,
          rows: config.rows,
        });
        client.shell(
          {
            term: "xterm-256color",
            cols: initialWindowSize.cols,
            rows: initialWindowSize.rows,
          },
          {
            // Fix for Chinese characters rendering issues in packaged apps
            // Setting LC_ALL and LANG to UTF-8 ensures the remote shell uses UTF-8 encoding
            env: {
              LC_ALL: "en_US.UTF-8",
              LANG: "en_US.UTF-8",
            },
          },
          (err, stream) => {
            if (err) {
              console.error(`[SSH] Failed to open shell:`, err);
              instance.initializationState = "failed";
              instance.isInitializing = false;
              emit(`\x1b[31m✘ Failed to open shell: ${err.message}\x1b[0m\r\n`);
              emitExit(-1);
              return;
            }
            instance.stream = stream;
            this.applyRequestedWindowSize(instance);
            emit("\x1b[36m▹ Initializing shell integration...\x1b[0m\r\n");
            console.log(
              `[SSH] Shell stream opened. Starting robust initialization...`,
            );

            let retryCount = 0;
            const maxRetries = 3;
            let isReadySent = false;
            const initializationReadyMarker = buildInitializationReadyMarker(
              instance.commandProtocolToken,
            );

            const attemptInjection = () => {
              if (!instance.stream || isReadySent || !instance.isInitializing)
                return;

              console.log(`[SSH] Injection attempt ${retryCount + 1}...`);
              if (
                instance.commandShellFamily !== "powershell" ||
                retryCount > 0
              ) {
                instance.stream.write("\x03\n\n");
              }

              setTimeout(() => {
                if (!instance.stream || isReadySent || !instance.isInitializing)
                  return;
                if (instance.commandShellFamily === "powershell") {
                  instance.stream.write(
                    `${this.buildWindowsPowerShellLaunchCommand(instance)}\r`,
                  );
                } else {
                  const script = this.getUnixInjectionScript(
                    instance.commandProtocolToken,
                  );
                  const b64 = Buffer.from(script).toString("base64");
                  const injection = `  eval "$(printf '%s' '${b64}' | base64 -d 2>/dev/null || printf '%s' '${b64}' | base64 --decode 2>/dev/null)"\n`;

                  const CHUNK_SIZE = 256;
                  for (let i = 0; i < injection.length; i += CHUNK_SIZE) {
                    instance.stream.write(injection.slice(i, i + CHUNK_SIZE));
                  }
                }
              }, 500);
            };

            setTimeout(attemptInjection, 1000);

            const watchdogInterval = setInterval(() => {
              if (instance.isInitializing) {
                retryCount++;
                if (retryCount >= maxRetries) {
                  instance.initializationState = "failed";
                  instance.isInitializing = false;
                  emit(
                    "\x1b[31m✘ Initialization failed. Entering fallback mode.\x1b[0m\r\n",
                  );
                  console.error(
                    `[SSH] Initialization FAILED after ${maxRetries} attempts for ${config.id}.`,
                  );
                  clearInterval(watchdogInterval);
                  return;
                }
                emit(
                  `\x1b[33m⚠ Initialization timeout, retrying (${retryCount}/${maxRetries})...\x1b[0m\r\n`,
                );
                attemptInjection();
              } else {
                clearInterval(watchdogInterval);
              }
            }, this.getShellInitRetryIntervalMs(instance.commandShellFamily));

            stream.on("data", (data: Buffer) => {
              const chunk = instance.streamDecoder.write(data);
              if (instance.isInitializing) {
                instance.buffer += chunk;
                const postInitializationData = consumeInitializationReadyMarker(
                  instance.buffer,
                  initializationReadyMarker,
                );
                if (postInitializationData !== undefined) {
                  emit("\x1b[2J\x1b[H"); // Clear screen
                  isReadySent = true;
                  clearInterval(watchdogInterval);
                  const sawContinuation =
                    /(?:\r?\n)>>\s*\r?\n/.test(instance.buffer) ||
                    instance.buffer.trimEnd().endsWith("\n>>") ||
                    instance.buffer.trimEnd().endsWith("\r\n>>");
                  instance.initializationState = "ready";
                  instance.isInitializing = false;
                  instance.commandProtocolAvailable =
                    instance.commandShellFamily === "powershell"
                      ? this.hasReliableWindowsCommandProtocol(instance)
                      : instance.buffer.includes(
                          "__GYSHELL_COMMAND_PROTOCOL__=verified",
                        );
                  const realContent = postInitializationData.trimStart();
                  if (realContent) emit(realContent);
                  instance.buffer = "";
                  if (
                    sawContinuation &&
                    instance.commandShellFamily === "powershell" &&
                    instance.stream
                  ) {
                    setTimeout(() => {
                      try {
                        instance.stream?.write("\r");
                      } catch {}
                    }, 50);
                  }
                }
              } else {
                emit(chunk);
              }
            });

            stream.on("close", async (code: number) => {
              const remaining = instance.streamDecoder.end();
              if (remaining) {
                if (instance.isInitializing) {
                  instance.buffer += remaining;
                } else {
                  emit(remaining);
                }
              }
              emitExit(typeof code === "number" ? code : 0);
            });
          },
        );
      });

      client.on("error", (err) => {
        console.error(`[SSH] Client error:`, err);
        instance.initializationState = "failed";
        instance.isInitializing = false;
        emit(`\x1b[31m✘ SSH Error: ${err.message}\x1b[0m\r\n`);
        emitExit(-1);
      });

      client.on("end", () => {
        emitExit(-1);
      });

      client.on("close", () => {
        emitExit(-1);
      });

      const connectConfig = this.buildBaseConnectConfig(sshConfig);
      connectConfig.hostVerifier = (hostKey: Buffer) => {
        instance.observedHostKey = Buffer.from(hostKey);
        return true;
      };

      if (sshConfig.authMethod === "password") {
        connectConfig.password = sshConfig.password;
      } else if (sshConfig.authMethod === "privateKey") {
        if (sshConfig.privateKey) {
          connectConfig.privateKey = sshConfig.privateKey;
        } else if (sshConfig.privateKeyPath) {
          try {
            connectConfig.privateKey = fs.readFileSync(
              sshConfig.privateKeyPath,
            );
          } catch (e: any) {
            emit(
              `\x1b[31m✘ Failed to read private key: ${e.message}\x1b[0m\r\n`,
            );
          }
        }
        if (sshConfig.passphrase) {
          connectConfig.passphrase = sshConfig.passphrase;
        }
      }

      try {
        // Give TerminalService a tiny bit of time to register the listener
        await new Promise((r) => setTimeout(r, 50));

        emit(
          `\x1b[36m▹ Connecting to ${sshConfig.host}:${sshConfig.port}...\x1b[0m\r\n`,
        );
        console.log(
          `[SSH] Attempting to connect to ${sshConfig.host}:${sshConfig.port}...`,
        );
        const sock = await this.buildConnectSocketIfNeeded(sshConfig, emit);
        if (sock) {
          console.log(
            `[SSH] SUCCESS: Connection to ${sshConfig.host} will be tunneled through sock (Jump Host/Proxy).`,
          );
          emit(
            "\x1b[36m▹ [Final] Using tunnel socket for target connection...\x1b[0m\r\n",
          );
          connectConfig.sock = sock;
        } else {
          console.log(
            `[SSH] DIRECT: No jump host or proxy, connecting directly to ${sshConfig.host}.`,
          );
        }
        client.connect(connectConfig);
      } catch (e: any) {
        const errMsg = e instanceof Error ? e.message : String(e);
        instance.initializationState = "failed";
        instance.isInitializing = false;
        emit(`\x1b[31m✘ Connection failed: ${errMsg}\x1b[0m\r\n`);
        emitExit(-1);
      }
    })();

    return config.id;
  }

  write(ptyId: string, data: string): void {
    const instance = this.sessions.get(ptyId);
    if (instance && instance.stream) {
      instance.stream.write(data);
    }
  }

  resize(ptyId: string, cols: number, rows: number): void {
    const instance = this.sessions.get(ptyId);
    if (instance) {
      const size = this.updateRequestedWindowSize(instance, cols, rows);
      if (size && instance.stream) {
        try {
          instance.stream.setWindow(size.rows, size.cols, 0, 0);
        } catch {
          // Keep the requested size cached for any later retry path.
        }
      }
    }
  }

  kill(ptyId: string): void {
    const instance = this.sessions.get(ptyId);
    if (instance) {
      this.clearSystemInfoRetry(instance);
      void this.cleanupWindowsPromptMarker(instance);
      this.closeChunkSessionsForPty(ptyId);
      for (const s of instance.forwardServers) {
        try {
          s.close();
        } catch {}
      }
      for (const rf of instance.remoteForwards) {
        try {
          instance.client.unforwardIn(rf.host, rf.port);
        } catch {}
      }
      try {
        instance.sftp?.end?.();
      } catch {}
      instance.client.end();
      this.sessions.delete(ptyId);
    }
  }

  onData(ptyId: string, callback: (data: string) => void): void {
    const instance = this.sessions.get(ptyId);
    if (instance) {
      instance.dataCallbacks.add(callback);
    }
  }

  onExit(ptyId: string, callback: (code: number) => void): void {
    const instance = this.sessions.get(ptyId);
    if (instance) {
      instance.exitCallbacks.add(callback);
    }
  }

  getCwd(ptyId: string): string | undefined {
    return this.sessions.get(ptyId)?.cwd;
  }

  getRemoteOs(ptyId: string): "unix" | "windows" | undefined {
    return this.sessions.get(ptyId)?.remoteOs;
  }

  getInitializationState(
    ptyId: string,
  ): "initializing" | "ready" | "failed" | undefined {
    return this.sessions.get(ptyId)?.initializationState;
  }

  private async waitForRemoteOs(
    instance: SSHInstance,
    timeoutMs = 4000,
  ): Promise<"unix" | "windows" | undefined> {
    if (instance.remoteOs) {
      return instance.remoteOs;
    }
    const deadline = Date.now() + timeoutMs;
    while (
      !instance.remoteOs &&
      instance.initializationState === "initializing" &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return instance.remoteOs;
  }

  private buildWindowsSystemInfoCommand(): string {
    const script = [
      "$utf8=[System.Text.UTF8Encoding]::new($false)",
      "[Console]::OutputEncoding=$utf8",
      "$OutputEncoding=$utf8",
      "$os=Get-CimInstance Win32_OperatingSystem",
      "$json=([pscustomobject]@{Version=$os.Version;CSName=$os.CSName;Arch=$(if([Environment]::Is64BitOperatingSystem){'x64'}else{'x86'})}|ConvertTo-Json -Compress)",
      "$bytes=$utf8.GetBytes($json)",
      "[Console]::OpenStandardOutput().Write($bytes,0,$bytes.Length)",
    ].join(";");
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    return `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${encoded}`;
  }

  async getSystemInfo(ptyId: string): Promise<any> {
    const instance = this.sessions.get(ptyId);
    if (!instance) return undefined;
    if (instance.systemInfo) {
      return instance.systemInfo;
    }
    if (instance.systemInfoPromise) {
      return await instance.systemInfoPromise;
    }

    const client = instance.client;
    instance.systemInfoPromise = (async () => {
      const remoteOs = await this.waitForRemoteOs(instance);
      if (!remoteOs) {
        return undefined;
      }
      const isWindows = remoteOs === "windows";

      if (isWindows) {
        try {
          const info = await this.execCollect(
            client,
            this.buildWindowsSystemInfoCommand(),
            10000,
          );
          const parsed = JSON.parse(info.stdout || "{}");
          const next = {
            os: "Windows",
            platform: "win32",
            release: parsed.Version || "",
            arch: parsed.Arch || "",
            hostname: parsed.CSName || "",
            isRemote: true,
            shell: "powershell.exe",
          };
          this.clearSystemInfoRetry(instance);
          instance.systemInfo = next;
          return next;
        } catch {
          return undefined;
        }
      }

      try {
        const [uname, osRelease, hostname] = await Promise.all([
          this.execCollect(client, "uname -a", 8000),
          this.execCollect(
            client,
            "cat /etc/os-release 2>/dev/null || cat /usr/lib/os-release 2>/dev/null",
            8000,
          ),
          this.execCollect(client, "hostname", 8000),
        ]);

        let os = "unix";
        const releaseMatch = osRelease.stdout.match(/^ID=(.*)$/m);
        if (releaseMatch) {
          os = releaseMatch[1].replace(/"/g, "");
        } else {
          const unameS = uname.stdout.split(" ")[0].toLowerCase();
          os = unameS || "unix";
        }
        const unameS = uname.stdout.split(" ")[0].toLowerCase();
        const platform = unameS.includes("darwin")
          ? "darwin"
          : unameS.includes("linux")
            ? "linux"
            : "unix";

        const parts = uname.stdout.split(" ");
        const next = {
          os,
          platform,
          release: parts[2] || "",
          arch: parts[parts.length - 2] || "",
          hostname: hostname.stdout.trim() || parts[1] || "",
          isRemote: true,
          shell: "/bin/sh",
        };
        this.clearSystemInfoRetry(instance);
        instance.systemInfo = next;
        return next;
      } catch {
        return undefined;
      }
    })();

    let result: any;
    try {
      result = await instance.systemInfoPromise;
    } finally {
      instance.systemInfoPromise = undefined;
    }
    if (!result) {
      this.scheduleSystemInfoRetry(ptyId);
    }
    return result;
  }

  private normalizeRemotePath(filePath: string): string {
    return filePath.replace(/\\/g, "/");
  }

  private isAbsoluteRemotePath(remotePath: string): boolean {
    return remotePath.startsWith("/") || /^[A-Za-z]:\//.test(remotePath);
  }

  private formatSftpError(error: unknown): string {
    if (
      error instanceof Error &&
      typeof error.message === "string" &&
      error.message.trim().length > 0
    ) {
      const code = (error as any)?.code;
      return code !== undefined
        ? `${error.message} (code: ${String(code)})`
        : error.message;
    }
    if (typeof error === "string" && error.trim().length > 0) {
      return error;
    }
    return "Unknown SFTP error";
  }

  private async initializeSftp(
    instance: SSHInstance,
  ): Promise<ssh2.SFTPWrapper> {
    if (instance.sftp) return instance.sftp;
    if (!instance.sftpInitPromise) {
      instance.sftpInitPromise = new Promise<ssh2.SFTPWrapper>(
        (resolve, reject) => {
          instance.client.sftp((err, sftpClient) => {
            if (err || !sftpClient) {
              reject(err || new Error("Failed to initialize SFTP"));
              return;
            }
            resolve(sftpClient);
          });
        },
      );
    }
    const sftp = await instance.sftpInitPromise;
    instance.sftp = sftp;
    instance.sftpInitError = undefined;
    return sftp;
  }

  private getUnixInjectionScript(runtimeToken: string): string {
    // Minified script to reduce payload size and potential TTY buffer issues
    const commandMarkerPrefix = buildCommandProtocolMarkerPrefix(runtimeToken);
    const privateIdentifierPrefix = `__gyshell_${runtimeToken}`;
    const protocolName = `${privateIdentifierPrefix}_command_protocol`;
    const inCommandName = `${privateIdentifierPrefix}_in_command`;
    const commandSequenceName = `${privateIdentifierPrefix}_command_seq`;
    const commandNonceName = `${privateIdentifierPrefix}_command_nonce`;
    const dispatchActiveName = `${privateIdentifierPrefix}_dispatch_active`;
    const dispatchCompletionReadyName = `${privateIdentifierPrefix}_dispatch_completion_ready`;
    const debugPriorName = `${privateIdentifierPrefix}_debug_prior`;
    const dispatcherName = `${privateIdentifierPrefix}_dispatch`;
    const completionName = `${dispatcherName}_complete`;
    const savedPromptEolName = `${privateIdentifierPrefix}_saved_prompt_eol_mark`;
    const preexecHookName = `${privateIdentifierPrefix}_preexec`;
    const precmdBeginHookName = `${privateIdentifierPrefix}_precmd_begin`;
    const precmdHookName = `${privateIdentifierPrefix}_precmd`;
    const savedExitName = `${privateIdentifierPrefix}_command_exit`;
    const cleanPromptCommandsName = `${privateIdentifierPrefix}_prompt_commands`;
    const promptCommandItemName = `${privateIdentifierPrefix}_prompt_command_item`;
    const script = `
if [ -n "$ZSH_VERSION" ]; then
  ${protocolName}=verified
  typeset -gi ${commandSequenceName}=0
  typeset -g ${commandNonceName}=
  typeset -gi ${inCommandName}=0
  typeset -gi ${dispatchActiveName}=0
  typeset -gi ${dispatchCompletionReadyName}=0
  typeset -g ${savedPromptEolName}=
  typeset -gi ${savedExitName}=0
  ${preexecHookName}() { if [[ "\${1-}" == ${dispatcherName}\\ * ]]; then return 0; fi; (( ${commandSequenceName} += 1 )); ${inCommandName}=1; ${savedPromptEolName}=\${PROMPT_EOL_MARK-}; builtin printf -v ${commandNonceName} "%04x%04x%04x%04x%04x%04x%04x%04x" "$RANDOM" "$RANDOM" "$RANDOM" "$RANDOM" "$RANDOM" "$RANDOM" "$RANDOM" "$RANDOM"; PROMPT_EOL_MARK="$(builtin printf "\\033]1337;${commandMarkerPrefix}preend;seq=%s;nonce=%s\\007" "$${commandSequenceName}" "$${commandNonceName}")$${savedPromptEolName}"; builtin printf "\\033]1337;${commandMarkerPrefix}preexec;seq=%s;nonce=%s\\007" "$${commandSequenceName}" "$${commandNonceName}"; }
  ${precmdBeginHookName}() { local prior=$?; if [ "\${${dispatchCompletionReadyName}-0}" != 1 ]; then ${savedExitName}=$prior; fi; builtin printf "\\033]1337;${commandMarkerPrefix}preend;seq=%s;nonce=%s\\007" "$${commandSequenceName}" "$${commandNonceName}"; }
  ${precmdHookName}() { local ec=$${savedExitName} cwd_b64 home_b64; cwd_b64=$(printf "%s" "$PWD" | base64 | tr -d "\\n"); home_b64=$(printf "%s" "$HOME" | base64 | tr -d "\\n"); builtin printf "\\033]1337;${commandMarkerPrefix}precmd;seq=%s;nonce=%s;ec=%s;cwd_b64=%s;home_b64=%s\\007" "$${commandSequenceName}" "$${commandNonceName}" "$ec" "$cwd_b64" "$home_b64"; PROMPT_EOL_MARK=$${savedPromptEolName}; ${dispatchCompletionReadyName}=0; ${inCommandName}=0; ${dispatchActiveName}=0; return "$ec"; }
  ${buildUnixCommandDispatcherScript(runtimeToken)}
  autoload -Uz add-zsh-hook 2>/dev/null || true
  add-zsh-hook preexec ${preexecHookName}
  precmd_functions=(${precmdBeginHookName} \${precmd_functions:#${precmdBeginHookName}})
  precmd_functions=(\${precmd_functions:#${precmdHookName}} ${precmdHookName})
elif [ -n "$BASH_VERSION" ]; then
  ${protocolName}=verified
  ${inCommandName}=0
  ${commandSequenceName}=0
  ${commandNonceName}=
  ${savedExitName}=0
  ${dispatchActiveName}=0
  ${dispatchCompletionReadyName}=0
  ${preexecHookName}() {
    local ${debugPriorName}=$?
    if shopt -q extdebug; then builtin trap - DEBUG; return 0; fi
    if [ "\${${dispatchActiveName}-0}" = 1 ]; then
      return 0
    fi
    case "$BASH_COMMAND" in
      ${dispatcherName}*|${completionName}*|${precmdBeginHookName}*|${precmdHookName}*|${preexecHookName}* ) return "$${debugPriorName}" ;;
    esac
    case "\${FUNCNAME[1]-}" in ${dispatcherName}|${completionName}) return "$${debugPriorName}" ;; esac
    if [ "$${inCommandName}" = "0" ]; then
      ${inCommandName}=1
      ${commandSequenceName}=$(($${commandSequenceName} + 1))
      printf -v ${commandNonceName} "%04x%04x%04x%04x%04x%04x%04x%04x" "$RANDOM" "$RANDOM" "$RANDOM" "$RANDOM" "$RANDOM" "$RANDOM" "$RANDOM" "$RANDOM"
      builtin printf "\\033]1337;${commandMarkerPrefix}preexec;seq=%s;nonce=%s\\007" "$${commandSequenceName}" "$${commandNonceName}"
    fi
    return "$${debugPriorName}"
  }
  ${buildUnixCommandDispatcherScript(runtimeToken)}
  if ! shopt -q extdebug; then trap '${preexecHookName}' DEBUG; fi
  ${precmdBeginHookName}() {
    local ${debugPriorName}=$?
    if [ "\${${dispatchCompletionReadyName}-0}" != 1 ]; then ${savedExitName}="$${debugPriorName}"; fi
    ${inCommandName}=1
    builtin printf "\\033]1337;${commandMarkerPrefix}preend;seq=%s;nonce=%s\\007" "$${commandSequenceName}" "$${commandNonceName}"
  }
  ${precmdHookName}() {
    local ec="$${savedExitName}"
    local cwd_b64 home_b64
    cwd_b64=$(printf "%s" "$PWD" | base64 | tr -d "\\n")
    home_b64=$(printf "%s" "$HOME" | base64 | tr -d "\\n")
    builtin printf "\\033]1337;${commandMarkerPrefix}precmd;seq=%s;nonce=%s;ec=%s;cwd_b64=%s;home_b64=%s\\007" "$${commandSequenceName}" "$${commandNonceName}" "$ec" "$cwd_b64" "$home_b64"
    ${dispatchCompletionReadyName}=0
    ${inCommandName}=0
    ${dispatchActiveName}=0
    return "$ec"
  }
  if [[ "$(declare -p PROMPT_COMMAND 2>/dev/null)" == "declare -a"* ]]; then
    ${cleanPromptCommandsName}=()
    for ${promptCommandItemName} in "\${PROMPT_COMMAND[@]}"; do
      case "$${promptCommandItemName}" in
        ${precmdBeginHookName}|${precmdHookName}) ;;
        *) ${cleanPromptCommandsName}+=("$${promptCommandItemName}") ;;
      esac
    done
    PROMPT_COMMAND=(${precmdBeginHookName} "\${${cleanPromptCommandsName}[@]}" ${precmdHookName})
    unset ${cleanPromptCommandsName} ${promptCommandItemName}
  else
    ${cleanPromptCommandsName}="\${PROMPT_COMMAND-}"
    while [[ "$${cleanPromptCommandsName}" == "${precmdBeginHookName}; "* ]]; do
      ${cleanPromptCommandsName}="\${${cleanPromptCommandsName}#${precmdBeginHookName}; }"
    done
    while [[ "$${cleanPromptCommandsName}" == *"; ${precmdHookName}" ]]; do
      ${cleanPromptCommandsName}="\${${cleanPromptCommandsName}%; ${precmdHookName}}"
    done
    [ "$${cleanPromptCommandsName}" = "${precmdBeginHookName}" ] && ${cleanPromptCommandsName}=
    [ "$${cleanPromptCommandsName}" = "${precmdHookName}" ] && ${cleanPromptCommandsName}=
    PROMPT_COMMAND="${precmdBeginHookName}\${${cleanPromptCommandsName}:+; $${cleanPromptCommandsName}}; ${precmdHookName}"
    unset ${cleanPromptCommandsName}
  fi
fi
echo "__GYSHELL_COMMAND_PROTOCOL__=\${${protocolName}:-unsupported}"
echo "${buildInitializationReadyMarker(runtimeToken)}"
`.trim();
    return script;
  }

  async getHomeDir(ptyId: string): Promise<string | undefined> {
    const instance = this.sessions.get(ptyId);
    if (!instance) return undefined;
    if (instance.homeDir) return instance.homeDir;
    try {
      const sftp = await this.getSftp(ptyId);
      const resolvedPath = await this.sftpRealpath(sftp, ".");
      instance.homeDir = resolvedPath;
      if (!instance.cwd) {
        instance.cwd = resolvedPath;
      }
      return resolvedPath;
    } catch {
      return instance.homeDir;
    }
  }

  applyCommandProtocolMetadata(
    ptyId: string,
    metadata: TerminalCommandProtocolMetadata,
  ): void {
    const instance = this.sessions.get(ptyId);
    if (!instance) return;
    if (metadata.cwd !== undefined) {
      const normalized = this.normalizeDecodedRemotePath(metadata.cwd);
      if (normalized) instance.cwd = normalized;
    }
    if (metadata.homeDir !== undefined) {
      const normalized = this.normalizeDecodedRemotePath(metadata.homeDir);
      if (normalized) instance.homeDir = normalized;
    }
  }

  getCommandProtocolAvailability(ptyId: string): boolean | undefined {
    return this.sessions.get(ptyId)?.commandProtocolAvailable;
  }

  getCommandProtocolToken(ptyId: string): string | undefined {
    const instance = this.sessions.get(ptyId);
    return instance?.remoteOs ? instance.commandProtocolToken : undefined;
  }

  private async getSftp(ptyId: string): Promise<ssh2.SFTPWrapper> {
    const instance = this.sessions.get(ptyId);
    if (!instance) {
      throw new Error(`SSH session ${ptyId} not found`);
    }
    if (instance.sftp) return instance.sftp;
    if (instance.sftpInitError) {
      throw new Error(
        `SFTP unavailable for session ${ptyId}: ${instance.sftpInitError}`,
      );
    }
    if (!instance.sftpInitPromise) {
      throw new Error(
        `SFTP channel has not been initialized for session ${ptyId}`,
      );
    }
    try {
      const sftp = await instance.sftpInitPromise;
      instance.sftp = sftp;
      return sftp;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      instance.sftpInitError = message;
      throw new Error(`SFTP unavailable for session ${ptyId}: ${message}`);
    }
  }

  private async createDedicatedSftp(ptyId: string): Promise<ssh2.SFTPWrapper> {
    const instance = this.sessions.get(ptyId);
    if (!instance) {
      throw new Error(`No SSH session found for ${ptyId}`);
    }
    return await new Promise<ssh2.SFTPWrapper>((resolve, reject) => {
      instance.client.sftp((err, sftpClient) => {
        if (err || !sftpClient) {
          reject(err || new Error("Failed to open dedicated SFTP channel."));
          return;
        }
        resolve(sftpClient);
      });
    });
  }

  private getTransferEndpointKey(ptyId: string): string {
    const instance = this.sessions.get(ptyId);
    if (!instance) {
      return `pty:${ptyId}`;
    }
    const cfg = instance.sshConfig;
    if (!cfg) {
      return `pty:${ptyId}`;
    }
    const username =
      typeof cfg.username === "string" && cfg.username.length > 0
        ? cfg.username
        : "unknown-user";
    const host =
      typeof cfg.host === "string" && cfg.host.length > 0
        ? cfg.host
        : "unknown-host";
    const port = Number.isFinite(cfg.port) ? Number(cfg.port) : 22;
    return `${username}@${host}:${port}`;
  }

  private selectAdaptiveFastTransferProfile(
    ptyId: string,
    direction: SftpTransferDirection,
  ): { endpointKey: string; profile: SftpTransferProfile } {
    const endpointKey = this.getTransferEndpointKey(ptyId);
    const profile = this.transferTuner.selectProfile(endpointKey, direction);
    return { endpointKey, profile };
  }

  private getFastTransferTimeoutMs(totalBytes: number): number {
    const sizeInMb = Math.max(
      1,
      Math.ceil(Math.max(0, Number(totalBytes) || 0) / (1024 * 1024)),
    );
    const timeoutBySize = sizeInMb * SSHBackend.FAST_TRANSFER_TIMEOUT_PER_MB_MS;
    return Math.max(
      SSHBackend.FAST_TRANSFER_TIMEOUT_MIN_MS,
      Math.min(SSHBackend.FAST_TRANSFER_TIMEOUT_MAX_MS, timeoutBySize),
    );
  }

  private joinRemotePath(basePath: string, childName: string): string {
    if (!basePath) return childName;
    if (basePath === "/") return `/${childName}`;
    if (/^[A-Za-z]:\/$/.test(basePath)) return `${basePath}${childName}`;
    return `${basePath.replace(/\/+$/, "")}/${childName}`;
  }

  private getChunkSessionKey(
    kind: "write",
    ptyId: string,
    normalizedPath: string,
  ): string {
    return `${kind}:${ptyId}:${normalizedPath}`;
  }

  private refreshWriteSessionCleanupTimer(
    key: string,
    session: SftpChunkWriteSession,
  ): void {
    if (session.cleanupTimer) {
      clearTimeout(session.cleanupTimer);
    }
    session.cleanupTimer = setTimeout(() => {
      void this.disposeWriteSession(key);
    }, SSHBackend.CHUNK_SESSION_IDLE_MS);
  }

  private async disposeWriteSession(key: string): Promise<void> {
    const session = this.chunkWriteSessions.get(key);
    if (!session) return;
    this.chunkWriteSessions.delete(key);
    if (session.cleanupTimer) {
      clearTimeout(session.cleanupTimer);
    }
    await this.sftpClose(session.sftp, session.handle).catch(() => {});
  }

  private closeChunkSessionsForPty(ptyId: string): void {
    const writeKeys = Array.from(this.chunkWriteSessions.keys()).filter((key) =>
      key.startsWith(`write:${ptyId}:`),
    );
    writeKeys.forEach((key) => {
      void this.disposeWriteSession(key);
    });
  }

  private async closeChunkSessionsForPath(
    ptyId: string,
    normalizedPath: string,
  ): Promise<void> {
    const writeKey = this.getChunkSessionKey("write", ptyId, normalizedPath);
    await this.disposeWriteSession(writeKey);
  }

  private async sftpOpen(
    sftp: ssh2.SFTPWrapper,
    normalizedPath: string,
    flags: ssh2.OpenMode,
  ): Promise<Buffer> {
    return await new Promise<Buffer>((resolve, reject) => {
      sftp.open(normalizedPath, flags, (err, handle) => {
        if (err || !handle) {
          reject(err || new Error(`Failed to open path: ${normalizedPath}`));
          return;
        }
        resolve(handle);
      });
    });
  }

  private async sftpClose(
    sftp: ssh2.SFTPWrapper,
    handle: Buffer,
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      sftp.close(handle, (err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  }

  private async sftpWrite(
    sftp: ssh2.SFTPWrapper,
    handle: Buffer,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      sftp.write(handle, buffer, offset, length, position, (err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  }

  /**
   * Low-level: read bytes from an already-open SFTP handle at a given position.
   * Returns the number of bytes actually read (may be less than requested at EOF).
   */
  private async sftpReadDirect(
    sftp: ssh2.SFTPWrapper,
    handle: Buffer,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): Promise<number> {
    return await new Promise<number>((resolve, reject) => {
      sftp.read(handle, buffer, offset, length, position, (err, bytesRead) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(bytesRead);
      });
    });
  }

  /**
   * Reads one bounded file prefix through a small pipeline of disjoint SFTP
   * requests. A sequential 16 MiB read can otherwise cost hundreds of SSH
   * round trips and outlive exec_command's wait window even on a healthy
   * host. The returned length is always the contiguous prefix actually read;
   * later ranges are never exposed across an unexpected short read.
   */
  private async sftpReadRangeConcurrent(
    sftp: ssh2.SFTPWrapper,
    handle: Buffer,
    buffer: Buffer,
    bufferOffset: number,
    length: number,
    position: number,
  ): Promise<number> {
    const safeBufferOffset = Math.max(
      0,
      Math.min(buffer.length, Math.floor(bufferOffset)),
    );
    const safePosition = Math.max(0, Math.floor(position));
    const safeLength = Math.max(
      0,
      Math.min(Math.floor(length), buffer.length - safeBufferOffset),
    );
    if (safeLength <= 0) {
      return 0;
    }

    const requestBytes = SSHBackend.MAX_SFTP_READ_REQUEST_BYTES;
    const rangeCount = Math.ceil(safeLength / requestBytes);
    const rangeLengths = Array.from({ length: rangeCount }, (_, index) =>
      Math.min(requestBytes, safeLength - index * requestBytes),
    );
    const actualLengths = new Array<number>(rangeCount).fill(0);
    let nextRangeIndex = 0;
    let stopRequested = false;

    const worker = async (): Promise<void> => {
      while (!stopRequested) {
        const rangeIndex = nextRangeIndex;
        nextRangeIndex += 1;
        if (rangeIndex >= rangeCount) {
          return;
        }

        const relativeOffset = rangeIndex * requestBytes;
        const rangeLength = rangeLengths[rangeIndex];
        let rangeRead = 0;
        try {
          while (rangeRead < rangeLength) {
            const partRead = await this.sftpReadDirect(
              sftp,
              handle,
              buffer,
              safeBufferOffset + relativeOffset + rangeRead,
              rangeLength - rangeRead,
              safePosition + relativeOffset + rangeRead,
            );
            if (partRead <= 0) {
              break;
            }
            rangeRead += partRead;
          }
        } catch (error) {
          stopRequested = true;
          throw error;
        }
        actualLengths[rangeIndex] = rangeRead;
        if (rangeRead < rangeLength) {
          stopRequested = true;
          return;
        }
      }
    };

    const concurrency = Math.min(
      rangeCount,
      SSHBackend.MAX_SFTP_READ_CONCURRENCY,
    );
    const settlements = await Promise.allSettled(
      Array.from({ length: concurrency }, () => worker()),
    );
    const rejection = settlements.find(
      (settlement): settlement is PromiseRejectedResult =>
        settlement.status === "rejected",
    );
    if (rejection) {
      throw rejection.reason;
    }

    let contiguousBytes = 0;
    for (let index = 0; index < rangeCount; index += 1) {
      contiguousBytes += actualLengths[index];
      if (actualLengths[index] < rangeLengths[index]) {
        break;
      }
    }
    return contiguousBytes;
  }

  private async sftpStat(
    sftp: ssh2.SFTPWrapper,
    normalizedPath: string,
  ): Promise<ssh2.Stats> {
    return await new Promise<ssh2.Stats>((resolve, reject) => {
      sftp.stat(normalizedPath, (err, stats) => {
        if (err || !stats) {
          reject(err || new Error(`Failed to stat path: ${normalizedPath}`));
          return;
        }
        resolve(stats);
      });
    });
  }

  private async sftpLstat(
    sftp: ssh2.SFTPWrapper,
    normalizedPath: string,
  ): Promise<ssh2.Stats> {
    return await new Promise<ssh2.Stats>((resolve, reject) => {
      sftp.lstat(normalizedPath, (err, stats) => {
        if (err || !stats) {
          reject(err || new Error(`Failed to lstat path: ${normalizedPath}`));
          return;
        }
        resolve(stats);
      });
    });
  }

  private async sftpReaddir(
    sftp: ssh2.SFTPWrapper,
    normalizedPath: string,
  ): Promise<ssh2.FileEntry[]> {
    return await new Promise<ssh2.FileEntry[]>((resolve, reject) => {
      sftp.readdir(normalizedPath, (err, list) => {
        if (err || !list) {
          reject(
            err || new Error(`Failed to read directory: ${normalizedPath}`),
          );
          return;
        }
        resolve(list);
      });
    });
  }

  private async sftpRealpath(
    sftp: ssh2.SFTPWrapper,
    normalizedPath: string,
  ): Promise<string> {
    return await new Promise<string>((resolve, reject) => {
      sftp.realpath(normalizedPath, (err, absolutePath) => {
        if (
          err ||
          typeof absolutePath !== "string" ||
          absolutePath.length === 0
        ) {
          reject(
            err ||
              new Error(`Failed to resolve remote path: ${normalizedPath}`),
          );
          return;
        }
        resolve(this.normalizeRemotePath(absolutePath));
      });
    });
  }

  private async sftpMkdir(
    sftp: ssh2.SFTPWrapper,
    normalizedPath: string,
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      sftp.mkdir(normalizedPath, (err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  }

  private async sftpRmdir(
    sftp: ssh2.SFTPWrapper,
    normalizedPath: string,
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      sftp.rmdir(normalizedPath, (err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  }

  private async sftpUnlink(
    sftp: ssh2.SFTPWrapper,
    normalizedPath: string,
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      sftp.unlink(normalizedPath, (err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  }

  private async sftpRename(
    sftp: ssh2.SFTPWrapper,
    sourcePath: string,
    targetPath: string,
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      sftp.rename(sourcePath, targetPath, (err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  }

  private async sftpWriteFile(
    sftp: ssh2.SFTPWrapper,
    normalizedPath: string,
    content: Buffer,
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      sftp.writeFile(normalizedPath, content, (err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  }

  private async removePathRecursive(
    sftp: ssh2.SFTPWrapper,
    normalizedPath: string,
  ): Promise<void> {
    const stats = await this.sftpLstat(sftp, normalizedPath);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      await this.sftpUnlink(sftp, normalizedPath);
      return;
    }

    const list = await this.sftpReaddir(sftp, normalizedPath);
    const children = list.filter(
      (item) => item.filename !== "." && item.filename !== "..",
    );
    for (const child of children) {
      const childPath = this.joinRemotePath(normalizedPath, child.filename);
      await this.removePathRecursive(sftp, childPath);
    }
    await this.sftpRmdir(sftp, normalizedPath);
  }

  async statFile(ptyId: string, filePath: string): Promise<FileStatInfo> {
    const sftp = await this.getSftp(ptyId);
    const normalizedPath = this.normalizeRemotePath(filePath);
    try {
      const stat = await this.sftpStat(sftp, normalizedPath);
      const isDirectory = stat.isDirectory();
      return {
        exists: true,
        isDirectory,
        size: isDirectory ? undefined : stat.size,
      };
    } catch (err: any) {
      if (err?.code === 2 || err?.code === "ENOENT") {
        return { exists: false, isDirectory: false };
      }
      throw err;
    }
  }

  async listDirectory(
    ptyId: string,
    dirPath: string,
  ): Promise<FileSystemEntry[]> {
    const sftp = await this.getSftp(ptyId);
    const normalizedPath = this.normalizeRemotePath(dirPath);
    const resolvedPath = this.isAbsoluteRemotePath(normalizedPath)
      ? normalizedPath
      : await this.sftpRealpath(sftp, normalizedPath);
    let list: ssh2.FileEntry[];
    try {
      list = await this.sftpReaddir(sftp, resolvedPath);
    } catch (error) {
      throw new Error(
        `Failed to list remote directory "${resolvedPath}": ${this.formatSftpError(error)}`,
      );
    }
    const mapped = list
      .filter((item) => item.filename !== "." && item.filename !== "..")
      .map((item) => {
        const attrs = item.attrs;
        const modeValue = typeof attrs?.mode === "number" ? attrs.mode : 0;
        const typeBits = modeValue & 0o170000;
        const isDirectory =
          typeBits === 0o040000 || item.longname?.startsWith("d") === true;
        const isSymbolicLink =
          typeBits === 0o120000 || item.longname?.startsWith("l") === true;
        const mode =
          typeof attrs?.mode === "number"
            ? `0${(attrs.mode & 0o777).toString(8)}`
            : undefined;
        const modifiedAt =
          typeof attrs?.mtime === "number"
            ? new Date(attrs.mtime * 1000).toISOString()
            : undefined;
        return {
          name: item.filename,
          path: this.joinRemotePath(resolvedPath, item.filename),
          isDirectory,
          isSymbolicLink,
          size: typeof attrs?.size === "number" ? attrs.size : 0,
          mode,
          modifiedAt,
        } satisfies FileSystemEntry;
      });

    return mapped.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, {
        numeric: true,
        sensitivity: "base",
      });
    });
  }

  async createDirectory(ptyId: string, dirPath: string): Promise<void> {
    const sftp = await this.getSftp(ptyId);
    const normalizedPath = this.normalizeRemotePath(dirPath);
    await this.sftpMkdir(sftp, normalizedPath);
  }

  async createFile(ptyId: string, filePath: string): Promise<void> {
    const sftp = await this.getSftp(ptyId);
    const normalizedPath = this.normalizeRemotePath(filePath);
    await this.closeChunkSessionsForPath(ptyId, normalizedPath);
    try {
      await this.sftpLstat(sftp, normalizedPath);
      throw new Error(`Path already exists: ${normalizedPath}`);
    } catch (error: any) {
      if (!(error?.code === 2 || error?.code === "ENOENT")) {
        throw error;
      }
    }
    await this.sftpWriteFile(sftp, normalizedPath, Buffer.alloc(0));
  }

  async deletePath(
    ptyId: string,
    targetPath: string,
    options?: { recursive?: boolean },
  ): Promise<void> {
    const sftp = await this.getSftp(ptyId);
    const normalizedPath = this.normalizeRemotePath(targetPath);
    await this.closeChunkSessionsForPath(ptyId, normalizedPath);
    const stats = await this.sftpLstat(sftp, normalizedPath);
    if (stats.isDirectory() && !stats.isSymbolicLink()) {
      if (options?.recursive) {
        await this.removePathRecursive(sftp, normalizedPath);
        return;
      }
      await this.sftpRmdir(sftp, normalizedPath);
      return;
    }
    await this.sftpUnlink(sftp, normalizedPath);
  }

  async renamePath(
    ptyId: string,
    sourcePath: string,
    targetPath: string,
  ): Promise<void> {
    const sftp = await this.getSftp(ptyId);
    const normalizedSource = this.normalizeRemotePath(sourcePath);
    const normalizedTarget = this.normalizeRemotePath(targetPath);
    await this.closeChunkSessionsForPath(ptyId, normalizedSource);
    await this.closeChunkSessionsForPath(ptyId, normalizedTarget);
    await this.sftpRename(sftp, normalizedSource, normalizedTarget);
  }

  async readFile(ptyId: string, filePath: string): Promise<Buffer> {
    const sftp = await this.getSftp(ptyId);
    const normalizedPath = this.normalizeRemotePath(filePath);
    const data = await new Promise<Buffer>((resolve, reject) => {
      sftp.readFile(normalizedPath, (err, buf) => {
        if (err || !buf) {
          reject(err || new Error("Failed to read file"));
          return;
        }
        resolve(buf as Buffer);
      });
    });
    return data;
  }

  async downloadFileToLocalPath(
    ptyId: string,
    sourcePath: string,
    targetLocalPath: string,
    options?: {
      onProgress?: (progress: {
        bytesTransferred: number;
        totalBytes: number;
        eof: boolean;
      }) => void;
      signal?: AbortSignal;
    },
  ): Promise<{ totalBytes: number }> {
    const createAbortError = (): Error => {
      const error = new Error("Transfer cancelled by user.");
      (error as Error & { name: string }).name = "AbortError";
      return error;
    };

    const normalizedPath = this.normalizeRemotePath(sourcePath);
    const statSftp = await this.getSftp(ptyId);
    const totalBytes = Math.max(
      0,
      Number((await this.sftpStat(statSftp, normalizedPath)).size) || 0,
    );
    await fs.promises.mkdir(dirname(targetLocalPath), { recursive: true });

    const runStreamFallback = async (): Promise<void> => {
      const fallbackSftp = await this.createDedicatedSftp(ptyId);
      const readStream = fallbackSftp.createReadStream(normalizedPath, {
        autoClose: true,
        highWaterMark: 512 * 1024,
      });
      const writeStream = fs.createWriteStream(targetLocalPath, { flags: "w" });
      let bytesTransferred = 0;
      readStream.on("data", (chunk: Buffer | string) => {
        const byteLength = Buffer.isBuffer(chunk)
          ? chunk.length
          : Buffer.byteLength(chunk);
        bytesTransferred += byteLength;
        options?.onProgress?.({
          bytesTransferred,
          totalBytes,
          eof: bytesTransferred >= totalBytes,
        });
      });

      let abortListener: (() => void) | undefined;
      if (options?.signal) {
        const abortError = createAbortError();
        abortListener = () => {
          readStream.destroy(abortError);
          writeStream.destroy();
          try {
            fallbackSftp.end?.();
          } catch {}
        };
        if (options.signal.aborted) {
          abortListener();
        } else {
          options.signal.addEventListener("abort", abortListener, {
            once: true,
          });
        }
      }

      try {
        await pipeline(readStream, writeStream);
      } finally {
        if (abortListener && options?.signal) {
          options.signal.removeEventListener("abort", abortListener);
        }
        try {
          fallbackSftp.end?.();
        } catch {}
      }
    };

    if (options?.signal?.aborted) {
      throw createAbortError();
    }

    const { endpointKey, profile } = this.selectAdaptiveFastTransferProfile(
      ptyId,
      "download",
    );
    const fastStartedAt = Date.now();
    const fastTimeoutMs = this.getFastTransferTimeoutMs(totalBytes);
    const transferSftp = await this.createDedicatedSftp(ptyId);
    let aborted = false;
    let abortListener: (() => void) | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (error?: unknown): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timeoutTimer);
          if (error) {
            reject(error);
            return;
          }
          resolve();
        };
        const timeoutTimer = setTimeout(() => {
          finish(new Error(`SFTP fastGet timed out after ${fastTimeoutMs}ms`));
        }, fastTimeoutMs);

        if (options?.signal) {
          abortListener = () => {
            aborted = true;
            try {
              transferSftp.end?.();
            } catch {}
            finish(createAbortError());
          };
          options.signal.addEventListener("abort", abortListener, {
            once: true,
          });
        }

        transferSftp.fastGet(
          normalizedPath,
          targetLocalPath,
          {
            concurrency: profile.concurrency,
            chunkSize: profile.chunkSize,
            step: (totalTransferred: number, _chunk: number, total: number) => {
              const transferred = Math.max(0, Number(totalTransferred) || 0);
              options?.onProgress?.({
                bytesTransferred: transferred,
                totalBytes: Math.max(
                  totalBytes,
                  Math.max(0, Number(total) || 0),
                ),
                eof: transferred >= totalBytes,
              });
            },
          },
          (error) => {
            finish(error);
          },
        );
      });
      this.transferTuner.reportSuccess(
        endpointKey,
        "download",
        profile.id,
        totalBytes,
        Date.now() - fastStartedAt,
      );
    } catch (error) {
      if (abortListener && options?.signal) {
        options.signal.removeEventListener("abort", abortListener);
      }
      try {
        transferSftp.end?.();
      } catch {}
      if (aborted || options?.signal?.aborted) {
        await fs.promises.unlink(targetLocalPath).catch(() => {});
        throw createAbortError();
      }
      this.transferTuner.reportFailure(endpointKey, "download", profile.id);
      await runStreamFallback();
      options?.onProgress?.({
        bytesTransferred: totalBytes,
        totalBytes,
        eof: true,
      });
      return { totalBytes };
    }

    if (abortListener && options?.signal) {
      options.signal.removeEventListener("abort", abortListener);
    }
    try {
      transferSftp.end?.();
    } catch {}
    options?.onProgress?.({
      bytesTransferred: totalBytes,
      totalBytes,
      eof: true,
    });
    return { totalBytes };
  }

  async uploadFileFromLocalPath(
    ptyId: string,
    sourceLocalPath: string,
    targetPath: string,
    options?: {
      onProgress?: (progress: {
        bytesTransferred: number;
        totalBytes: number;
        eof: boolean;
      }) => void;
      signal?: AbortSignal;
    },
  ): Promise<{ totalBytes: number }> {
    const createAbortError = (): Error => {
      const error = new Error("Transfer cancelled by user.");
      (error as Error & { name: string }).name = "AbortError";
      return error;
    };

    const normalizedTargetPath = this.normalizeRemotePath(targetPath);
    const totalBytes = Math.max(
      0,
      Number((await fs.promises.stat(sourceLocalPath)).size) || 0,
    );
    await this.closeChunkSessionsForPath(ptyId, normalizedTargetPath);

    const runStreamFallback = async (): Promise<void> => {
      const fallbackSftp = await this.createDedicatedSftp(ptyId);
      const readStream = fs.createReadStream(sourceLocalPath, {
        highWaterMark: 512 * 1024,
      });
      const writeStream = fallbackSftp.createWriteStream(normalizedTargetPath, {
        flags: "w",
        autoClose: true,
      });
      let bytesTransferred = 0;
      readStream.on("data", (chunk: Buffer | string) => {
        const byteLength = Buffer.isBuffer(chunk)
          ? chunk.length
          : Buffer.byteLength(chunk);
        bytesTransferred += byteLength;
        options?.onProgress?.({
          bytesTransferred,
          totalBytes,
          eof: bytesTransferred >= totalBytes,
        });
      });

      let abortListener: (() => void) | undefined;
      if (options?.signal) {
        const abortError = createAbortError();
        abortListener = () => {
          readStream.destroy(abortError);
          writeStream.destroy();
          try {
            fallbackSftp.end?.();
          } catch {}
        };
        if (options.signal.aborted) {
          abortListener();
        } else {
          options.signal.addEventListener("abort", abortListener, {
            once: true,
          });
        }
      }

      try {
        await pipeline(readStream, writeStream);
      } finally {
        if (abortListener && options?.signal) {
          options.signal.removeEventListener("abort", abortListener);
        }
        try {
          fallbackSftp.end?.();
        } catch {}
      }
    };

    if (options?.signal?.aborted) {
      throw createAbortError();
    }

    const { endpointKey, profile } = this.selectAdaptiveFastTransferProfile(
      ptyId,
      "upload",
    );
    const fastStartedAt = Date.now();
    const fastTimeoutMs = this.getFastTransferTimeoutMs(totalBytes);
    const transferSftp = await this.createDedicatedSftp(ptyId);
    let aborted = false;
    let abortListener: (() => void) | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (error?: unknown): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timeoutTimer);
          if (error) {
            reject(error);
            return;
          }
          resolve();
        };
        const timeoutTimer = setTimeout(() => {
          finish(new Error(`SFTP fastPut timed out after ${fastTimeoutMs}ms`));
        }, fastTimeoutMs);

        if (options?.signal) {
          abortListener = () => {
            aborted = true;
            try {
              transferSftp.end?.();
            } catch {}
            finish(createAbortError());
          };
          options.signal.addEventListener("abort", abortListener, {
            once: true,
          });
        }

        transferSftp.fastPut(
          sourceLocalPath,
          normalizedTargetPath,
          {
            concurrency: profile.concurrency,
            chunkSize: profile.chunkSize,
            step: (totalTransferred: number, _chunk: number, total: number) => {
              const transferred = Math.max(0, Number(totalTransferred) || 0);
              options?.onProgress?.({
                bytesTransferred: transferred,
                totalBytes: Math.max(
                  totalBytes,
                  Math.max(0, Number(total) || 0),
                ),
                eof: transferred >= totalBytes,
              });
            },
          },
          (error) => {
            finish(error);
          },
        );
      });
      this.transferTuner.reportSuccess(
        endpointKey,
        "upload",
        profile.id,
        totalBytes,
        Date.now() - fastStartedAt,
      );
    } catch (error) {
      if (abortListener && options?.signal) {
        options.signal.removeEventListener("abort", abortListener);
      }
      try {
        transferSftp.end?.();
      } catch {}
      if (aborted || options?.signal?.aborted) {
        throw createAbortError();
      }
      this.transferTuner.reportFailure(endpointKey, "upload", profile.id);
      await runStreamFallback();
      options?.onProgress?.({
        bytesTransferred: totalBytes,
        totalBytes,
        eof: true,
      });
      return { totalBytes };
    }

    if (abortListener && options?.signal) {
      options.signal.removeEventListener("abort", abortListener);
    }
    try {
      transferSftp.end?.();
    } catch {}
    options?.onProgress?.({
      bytesTransferred: totalBytes,
      totalBytes,
      eof: true,
    });
    return { totalBytes };
  }

  async readFileChunk(
    ptyId: string,
    filePath: string,
    offset: number,
    chunkSize: number,
    options?: { totalSizeHint?: number },
  ): Promise<{
    chunk: Buffer;
    bytesRead: number;
    totalSize: number;
    nextOffset: number;
    eof: boolean;
  }> {
    const sftp = await this.getSftp(ptyId);
    const normalizedPath = this.normalizeRemotePath(filePath);
    const safeOffset =
      Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0;
    const safeChunkSize =
      Number.isFinite(chunkSize) && chunkSize > 0
        ? Math.floor(chunkSize)
        : 256 * 1024;
    const hintedTotalSize =
      Number.isFinite(options?.totalSizeHint) &&
      (options?.totalSizeHint || 0) >= 0
        ? Math.floor(options!.totalSizeHint as number)
        : null;
    const totalSize =
      hintedTotalSize !== null
        ? hintedTotalSize
        : Math.max(
            0,
            Number((await this.sftpStat(sftp, normalizedPath)).size) || 0,
          );
    if (safeOffset >= totalSize) {
      return {
        chunk: Buffer.alloc(0),
        bytesRead: 0,
        totalSize,
        nextOffset: safeOffset,
        eof: true,
      };
    }

    const targetSize = Math.max(
      1,
      Math.min(safeChunkSize, totalSize - safeOffset),
    );

    // Open the file handle once and issue multiple sftp.read calls, avoiding the
    // per-sub-request OPEN+READ+CLOSE round trips that sftp.createReadStream incurs.
    const handle = await this.sftpOpen(sftp, normalizedPath, "r");
    try {
      const chunks: Buffer[] = [];
      let bytesRead = 0;
      while (bytesRead < targetSize) {
        const requestBytes = Math.min(
          SSHBackend.MAX_SFTP_READ_REQUEST_BYTES,
          targetSize - bytesRead,
        );
        const buf = Buffer.allocUnsafe(requestBytes);
        const partRead = await this.sftpReadDirect(
          sftp,
          handle,
          buf,
          0,
          requestBytes,
          safeOffset + bytesRead,
        );
        if (partRead <= 0) {
          break;
        }
        chunks.push(buf.subarray(0, partRead));
        bytesRead += partRead;
      }

      const chunk =
        chunks.length > 0 ? Buffer.concat(chunks, bytesRead) : Buffer.alloc(0);
      const nextOffset = safeOffset + bytesRead;
      const eof = nextOffset >= totalSize;

      return {
        chunk,
        bytesRead,
        totalSize,
        nextOffset,
        eof,
      };
    } finally {
      await this.sftpClose(sftp, handle).catch(() => {});
    }
  }

  async writeFileChunk(
    ptyId: string,
    filePath: string,
    offset: number,
    content: Buffer,
    options?: { truncate?: boolean; close?: boolean },
  ): Promise<{ writtenBytes: number; nextOffset: number }> {
    const sftp = await this.getSftp(ptyId);
    const normalizedPath = this.normalizeRemotePath(filePath);
    const safeOffset =
      Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0;
    const payload = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const sessionKey = this.getChunkSessionKey("write", ptyId, normalizedPath);
    const shouldTruncateAtStart =
      options?.truncate === true && safeOffset === 0;

    const existingSession = this.chunkWriteSessions.get(sessionKey);
    if (
      existingSession &&
      (existingSession.sftp !== sftp ||
        shouldTruncateAtStart ||
        existingSession.expectedOffset !== safeOffset)
    ) {
      await this.disposeWriteSession(sessionKey);
    }

    let session = this.chunkWriteSessions.get(sessionKey);
    if (!session) {
      let handle: Buffer;
      try {
        const openFlags: ssh2.OpenMode = shouldTruncateAtStart ? "w" : "r+";
        handle = await this.sftpOpen(sftp, normalizedPath, openFlags);
      } catch (error: any) {
        if (
          !(error?.code === 2 || error?.code === "ENOENT") ||
          safeOffset !== 0
        ) {
          throw error;
        }
        handle = await this.sftpOpen(sftp, normalizedPath, "w");
      }

      session = {
        sftp,
        handle,
        expectedOffset: safeOffset,
      };
      this.chunkWriteSessions.set(sessionKey, session);
    }
    this.refreshWriteSessionCleanupTimer(sessionKey, session);

    try {
      if (payload.length > 0) {
        await this.sftpWrite(
          session.sftp,
          session.handle,
          payload,
          0,
          payload.length,
          safeOffset,
        );
      }
      session.expectedOffset = safeOffset + payload.length;
      if (options?.close === true) {
        await this.disposeWriteSession(sessionKey);
      }
    } catch (error) {
      await this.disposeWriteSession(sessionKey);
      throw error;
    }

    return {
      writtenBytes: payload.length,
      nextOffset: safeOffset + payload.length,
    };
  }

  async writeFile(
    ptyId: string,
    filePath: string,
    content: string,
  ): Promise<void> {
    await this.writeFileBytes(ptyId, filePath, Buffer.from(content, "utf8"));
  }

  async writeFileBytes(
    ptyId: string,
    filePath: string,
    content: Buffer,
  ): Promise<void> {
    const sftp = await this.getSftp(ptyId);
    const normalizedPath = this.normalizeRemotePath(filePath);
    await this.closeChunkSessionsForPath(ptyId, normalizedPath);
    await this.sftpWriteFile(sftp, normalizedPath, content);
  }

  private normalizeDecodedRemotePath(decodedPath: string): string | null {
    if (typeof decodedPath !== "string" || decodedPath.length === 0) {
      return null;
    }
    const sanitized = decodedPath.replace(/[\u0000-\u001f\u007f]/g, "");
    return sanitized.length > 0 ? sanitized : null;
  }
}
