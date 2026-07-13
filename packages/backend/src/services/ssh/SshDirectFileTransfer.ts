import { randomUUID } from "node:crypto";
import type * as ssh2 from "ssh2";
import type {
  PeerFileTransferFallbackReason,
  PeerFileTransferOptions,
  PeerFileTransferResult,
  SSHConnectionConfig,
} from "../../types";
import {
  SshScpTransferAttempt,
  type AgentExecutorClientFactory,
  type PeerTransferSide,
  type SshTransferEndpoint,
} from "./SshScpTransferAttempt";

export type { PeerTransferSide } from "./SshScpTransferAttempt";

const SFTP_OPEN_TIMEOUT_MS = 3_000;
const SFTP_STAT_TIMEOUT_MS = 2_000;
const SFTP_UNLINK_TIMEOUT_MS = 2_000;
const SFTP_CLEANUP_TIMEOUT_MS = 750;
const SFTP_COMMIT_TIMEOUT_MS = 5_000;
const SFTP_COMMIT_ABORT_GRACE_MS = 500;

class SshDirectCommitIndeterminateError extends Error {
  constructor() {
    super("The remote commit result is indeterminate.");
    this.name = "SshDirectCommitIndeterminateError";
  }
}

export interface SshDirectFileTransferRequest {
  sourceClient: ssh2.Client;
  sourceConfig: SSHConnectionConfig;
  sourceObservedHostKey: Buffer;
  sourcePath: string;
  targetClient: ssh2.Client;
  targetConfig: SSHConnectionConfig;
  targetObservedHostKey: Buffer;
  targetPath: string;
  openAgentExecutorClient: AgentExecutorClientFactory;
  options: PeerFileTransferOptions;
}

export interface SshDirectFileTransferOptions {
  commitTimeoutMs?: number;
  commitAbortGraceMs?: number;
}

const createAbortError = (): Error => {
  const error = new Error("Transfer cancelled by user.");
  error.name = "AbortError";
  return error;
};

const isAbortError = (error: unknown): boolean =>
  (error as { name?: unknown } | null)?.name === "AbortError";

const isCommitIndeterminateError = (error: unknown): boolean =>
  (error as { name?: unknown } | null)?.name ===
  "SshDirectCommitIndeterminateError";

const ensureNotAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw createAbortError();
};

const openSftp = async (
  client: ssh2.Client,
  signal?: AbortSignal,
): Promise<ssh2.SFTPWrapper> =>
  await new Promise<ssh2.SFTPWrapper>((resolve, reject) => {
    let settled = false;
    const finish = (sftp?: ssh2.SFTPWrapper, error?: Error): void => {
      if (settled) {
        if (sftp) closeSftp(sftp);
        return;
      }
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (error || !sftp) reject(error || new Error("Unable to open SFTP."));
      else resolve(sftp);
    };
    const onAbort = (): void => finish(undefined, createAbortError());
    const timer = setTimeout(
      () => finish(undefined, new Error("Timed out while opening SFTP.")),
      SFTP_OPEN_TIMEOUT_MS,
    );
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    client.sftp((error, sftp) => {
      finish(sftp, error || undefined);
    });
  });

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

const tryUnlinkSftpFile = async (
  sftp: ssh2.SFTPWrapper,
  filePath: string,
  options?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<boolean> =>
  await new Promise<boolean>((resolve, reject) => {
    let settled = false;
    const finish = (completed: boolean, error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options?.signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(completed);
    };
    const onAbort = (): void => finish(false, createAbortError());
    const timer = setTimeout(
      () => finish(false),
      options?.timeoutMs ?? SFTP_UNLINK_TIMEOUT_MS,
    );
    options?.signal?.addEventListener("abort", onAbort, { once: true });
    if (options?.signal?.aborted) {
      onAbort();
      return;
    }
    sftp.unlink(filePath, (error) => {
      if (!error) {
        finish(true);
        return;
      }
      const code = (error as { code?: unknown }).code;
      finish(code === 2 || code === "ENOENT");
    });
  });

const isExplicitSftpStatusError = (error: unknown): boolean =>
  typeof (error as { code?: unknown } | null)?.code === "number";

const requestSftpRename = async (
  sftp: ssh2.SFTPWrapper,
  invoke: (callback: (error?: Error) => void) => void,
  options: {
    signal?: AbortSignal;
    timeoutMs: number;
    abortGraceMs: number;
  },
): Promise<void> => {
  ensureNotAborted(options.signal);
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let abortRequested = false;
    let timer: ReturnType<typeof setTimeout>;

    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    };
    const onTimeout = (): void => {
      closeSftp(sftp);
      finish(
        abortRequested || options.signal?.aborted
          ? createAbortError()
          : new SshDirectCommitIndeterminateError(),
      );
    };
    const scheduleTimeout = (timeoutMs: number): void => {
      clearTimeout(timer);
      timer = setTimeout(onTimeout, timeoutMs);
    };
    const onAbort = (): void => {
      // The rename request may already have reached the server. Give its
      // callback a short grace period so success is observed before reporting
      // cancellation, then close this dedicated SFTP channel if it is stuck.
      abortRequested = true;
      scheduleTimeout(options.abortGraceMs);
    };

    timer = setTimeout(onTimeout, options.timeoutMs);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    try {
      invoke((error) => finish(error));
    } catch (error) {
      finish(error as Error);
    }
  });
};

const renameSftpFile = async (
  sftp: ssh2.SFTPWrapper,
  sourcePath: string,
  targetPath: string,
  options: {
    signal?: AbortSignal;
    timeoutMs: number;
    abortGraceMs: number;
  },
): Promise<void> => {
  try {
    await requestSftpRename(
      sftp,
      (callback) => {
        sftp.ext_openssh_rename(sourcePath, targetPath, (error) => {
          callback(error || undefined);
        });
      },
      options,
    );
  } catch (error) {
    if (
      options.signal?.aborted ||
      isAbortError(error) ||
      isCommitIndeterminateError(error)
    ) {
      throw error;
    }
    // Only a server SFTP status proves that the extension request completed
    // without renaming. A channel/local error leaves the commit state unknown.
    if (!isExplicitSftpStatusError(error)) {
      throw new SshDirectCommitIndeterminateError();
    }
    ensureNotAborted(options.signal);
    try {
      await requestSftpRename(
        sftp,
        (callback) => {
          sftp.rename(sourcePath, targetPath, (renameError) => {
            callback(renameError || undefined);
          });
        },
        options,
      );
    } catch (renameError) {
      if (
        options.signal?.aborted ||
        isAbortError(renameError) ||
        isCommitIndeterminateError(renameError)
      ) {
        throw renameError;
      }
      if (!isExplicitSftpStatusError(renameError)) {
        throw new SshDirectCommitIndeterminateError();
      }
      throw renameError;
    }
  }
};

const closeSftp = (sftp: ssh2.SFTPWrapper | null): void => {
  try {
    sftp?.end?.();
  } catch {
    // Dedicated SFTP cleanup is best-effort during route fallback.
  }
};

/** Coordinates push, reverse-pull, verification, commit, and relay fallback. */
export class SshDirectFileTransfer {
  constructor(
    private readonly scpAttempt = new SshScpTransferAttempt(),
    private readonly options: SshDirectFileTransferOptions = {},
  ) {}

  async tryTransfer(
    request: SshDirectFileTransferRequest,
  ): Promise<PeerFileTransferResult> {
    ensureNotAborted(request.options.signal);
    const invalidReason = this.validateRequest(request);
    if (invalidReason) return { status: "fallback", reason: invalidReason };

    const transferId = randomUUID();
    const stagingPath = this.buildStagingPath(request.targetPath, transferId);
    const source = this.buildEndpoint("source", request);
    const target = this.buildEndpoint("target", request);
    let targetSftp: ssh2.SFTPWrapper | null = null;
    let committed = false;
    let fallbackReason: PeerFileTransferFallbackReason = "direct-copy-failed";

    try {
      targetSftp = await openSftp(request.targetClient, request.options.signal);

      const push = await this.scpAttempt.run({
        executor: source,
        remote: target,
        sourcePath: request.sourcePath,
        targetPath: stagingPath,
        direction: "push",
        targetSftp,
        expectedBytes: request.options.expectedBytes,
        hostAlias: `gyshell-peer-target-${transferId}`,
        openAgentExecutorClient: request.openAgentExecutorClient,
        signal: request.options.signal,
        onProgress: request.options.onProgress,
      });
      fallbackReason = push.reason;

      let copySucceeded = push.succeeded;
      if (this.shouldAttemptReversePull(push, request.sourcePath)) {
        const stagingCleaned = await tryUnlinkSftpFile(
          targetSftp,
          stagingPath,
          { signal: request.options.signal },
        );
        if (!stagingCleaned) {
          return { status: "fallback", reason: fallbackReason };
        }
        const pull = await this.scpAttempt.run({
          executor: target,
          remote: source,
          sourcePath: request.sourcePath,
          targetPath: stagingPath,
          direction: "pull",
          targetSftp,
          expectedBytes: request.options.expectedBytes,
          hostAlias: `gyshell-peer-source-${transferId}`,
          openAgentExecutorClient: request.openAgentExecutorClient,
          signal: request.options.signal,
          onProgress: request.options.onProgress,
        });
        copySucceeded = pull.succeeded;
        fallbackReason = pull.reason;
      }

      if (!copySucceeded) {
        return { status: "fallback", reason: fallbackReason };
      }

      const stagingStat = await statSftpFile(
        targetSftp,
        stagingPath,
        request.options.signal,
      );
      const stagingSize = Math.max(0, Number(stagingStat?.size) || 0);
      if (stagingSize !== request.options.expectedBytes) {
        return { status: "fallback", reason: "size-verification-failed" };
      }

      try {
        ensureNotAborted(request.options.signal);
        await renameSftpFile(targetSftp, stagingPath, request.targetPath, {
          signal: request.options.signal,
          timeoutMs: this.options.commitTimeoutMs ?? SFTP_COMMIT_TIMEOUT_MS,
          abortGraceMs:
            this.options.commitAbortGraceMs ?? SFTP_COMMIT_ABORT_GRACE_MS,
        });
        committed = true;
        // Cancellation observed after a confirmed commit reports cancelled,
        // but the source is preserved (especially important for move).
        ensureNotAborted(request.options.signal);
      } catch (error) {
        if (request.options.signal?.aborted || isAbortError(error)) {
          throw createAbortError();
        }
        if (isCommitIndeterminateError(error)) throw error;
        return { status: "fallback", reason: "commit-failed" };
      }
      request.options.onProgress?.(request.options.expectedBytes);
      return {
        status: "transferred",
        transferredBytes: request.options.expectedBytes,
      };
    } catch (error) {
      if (request.options.signal?.aborted || isAbortError(error)) {
        throw createAbortError();
      }
      if (isCommitIndeterminateError(error)) throw error;
      return { status: "fallback", reason: fallbackReason };
    } finally {
      if (targetSftp && !committed) {
        await tryUnlinkSftpFile(targetSftp, stagingPath, {
          timeoutMs: SFTP_CLEANUP_TIMEOUT_MS,
        }).catch(() => false);
      }
      closeSftp(targetSftp);
    }
  }

  private buildEndpoint(
    side: PeerTransferSide,
    request: SshDirectFileTransferRequest,
  ): SshTransferEndpoint {
    if (side === "source") {
      return {
        side,
        client: request.sourceClient,
        config: request.sourceConfig,
        observedHostKey: request.sourceObservedHostKey,
      };
    }
    return {
      side,
      client: request.targetClient,
      config: request.targetConfig,
      observedHostKey: request.targetObservedHostKey,
    };
  }

  private shouldAttemptReversePull(
    input: {
      succeeded: boolean;
      maxObservedBytes: number;
      reason: PeerFileTransferFallbackReason;
    },
    sourcePath: string,
  ): boolean {
    if (input.succeeded || input.maxObservedBytes !== 0) return false;
    // In SFTP-mode scp, a remote source spec is glob-expanded. Refuse reverse
    // pull when a valid Unix filename could be reinterpreted as a pattern.
    if (/[*?\[\]\\]/.test(sourcePath)) return false;
    // Do not hand the opposite credential to the other host after an auth or
    // copy failure. Reverse direction is reserved for asymmetric reachability
    // or executor-side OpenSSH/agent-forwarding capability failures.
    return (
      input.reason === "direct-connection-failed" ||
      input.reason === "remote-openssh-unsupported" ||
      input.reason === "agent-forwarding-denied"
    );
  }

  private validateRequest(
    request: SshDirectFileTransferRequest,
  ): PeerFileTransferFallbackReason | null {
    const configs = [request.sourceConfig, request.targetConfig];
    if (
      !Number.isSafeInteger(request.options.expectedBytes) ||
      request.options.expectedBytes <= 0
    ) {
      return "unsupported-route";
    }
    if (configs.some((config) => !this.isSupportedAuth(config))) {
      return "unsupported-auth";
    }
    if (
      configs.some((config) => config.proxy) ||
      !this.hasCompatiblePeerIngressRoute(
        request.sourceConfig,
        request.targetConfig,
      )
    ) {
      return "unsupported-route";
    }
    if (
      !this.isSafeAbsoluteUnixPath(request.sourcePath) ||
      !this.isSafeAbsoluteUnixPath(request.targetPath)
    ) {
      return "unsupported-route";
    }
    if (
      configs.some(
        (config) =>
          !this.isSafeHost(config.host) ||
          !this.isSafeUsername(config.username) ||
          !Number.isInteger(config.port) ||
          config.port < 1 ||
          config.port > 65_535,
      )
    ) {
      return "unsupported-route";
    }
    if (
      request.sourceObservedHostKey.length === 0 ||
      request.targetObservedHostKey.length === 0
    ) {
      return "missing-host-key";
    }
    return null;
  }

  private hasCompatiblePeerIngressRoute(
    source: SSHConnectionConfig,
    target: SSHConnectionConfig,
  ): boolean {
    if (!source.jumpHost && !target.jumpHost) return true;
    if (!source.jumpHost || !target.jumpHost) return false;
    return this.haveEquivalentSshRoute(source.jumpHost, target.jumpHost, 0);
  }

  private haveEquivalentSshRoute(
    left: SSHConnectionConfig,
    right: SSHConnectionConfig,
    depth: number,
  ): boolean {
    if (depth > 3) return false;
    if (
      left.host.trim().toLowerCase() !== right.host.trim().toLowerCase() ||
      left.port !== right.port ||
      left.username.trim() !== right.username.trim() ||
      !this.haveEquivalentProxy(left.proxy, right.proxy)
    ) {
      return false;
    }
    if (!left.jumpHost && !right.jumpHost) return true;
    if (!left.jumpHost || !right.jumpHost) return false;
    return this.haveEquivalentSshRoute(
      left.jumpHost,
      right.jumpHost,
      depth + 1,
    );
  }

  private haveEquivalentProxy(
    left: SSHConnectionConfig["proxy"],
    right: SSHConnectionConfig["proxy"],
  ): boolean {
    if (!left && !right) return true;
    if (!left || !right) return false;
    return (
      left.type === right.type &&
      left.host.trim().toLowerCase() === right.host.trim().toLowerCase() &&
      left.port === right.port &&
      (left.username || "").trim() === (right.username || "").trim()
    );
  }

  private isSupportedAuth(config: SSHConnectionConfig): boolean {
    if (config.authMethod === "password") {
      return typeof config.password === "string" && config.password.length > 0;
    }
    return !!config.privateKey || !!config.privateKeyPath;
  }

  private isSafeAbsoluteUnixPath(value: string): boolean {
    return value.startsWith("/") && !/[\0\r\n]/.test(value);
  }

  private isSafeHost(value: string): boolean {
    return value.length > 0 && !/[\0\r\n\s@]/.test(value);
  }

  private isSafeUsername(value: string): boolean {
    return value.length > 0 && !/[\0\r\n\s@:/]/.test(value);
  }

  private buildStagingPath(targetPath: string, transferId: string): string {
    const separatorIndex = targetPath.lastIndexOf("/");
    const directory =
      separatorIndex <= 0 ? "/" : targetPath.slice(0, separatorIndex);
    return `${directory.replace(/\/$/, "")}/.gyshell-peer-${transferId}.part`;
  }
}
