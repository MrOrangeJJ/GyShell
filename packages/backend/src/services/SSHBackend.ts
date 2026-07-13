import * as ssh2 from "ssh2";
import * as fs from "fs";
import * as net from "net";
import { dirname } from "node:path";
import { pipeline } from "node:stream/promises";
import { SocksClient } from "socks";
import {
  isSshConnectionConfig,
  type TerminalCommandTrackingToken,
  type TerminalCommandTrackingUpdate,
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
  buildWindowsPowerShellEncodedCommand,
  WINDOWS_POWERSHELL_COMMAND_OUTPUT_FILE_PREFIX,
  escapePowerShellSingleQuotedString,
  parseWindowsBuildNumber,
  parseWindowsPromptMarkerLine,
  shouldUseWindowsPowerShellSidecar,
  WINDOWS_POWERSHELL_COMMAND_REQUEST_FILE_PREFIX,
  WINDOWS_POWERSHELL_REMOTE_SIDECAR_DIR_NAME,
  WINDOWS_POWERSHELL_SIDECAR_RETENTION_MS,
  type WindowsCommandTrackingMode,
  type WindowsPromptMarkerState,
} from "./windowsPowerShellTracking";

const GYSHELL_READY_MARKER = "__GYSHELL_READY__";
const SSH_CONNECT_READY_TIMEOUT_MS = 20_000;
const SSH_KEEPALIVE_INTERVAL_MS = 30_000;
const SSH_KEEPALIVE_COUNT_MAX = 3;
const SSH_DIRECT_CONTROL_READY_TIMEOUT_MS = 4_000;

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
  oscBuffer: string;
  cwd?: string;
  homeDir?: string;
  remoteOs?: "unix" | "windows";
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
  windowsPromptMarkerState?: WindowsPromptMarkerState;
  forwardServers: net.Server[];
  remoteForwards: Array<{ host: string; port: number }>;
  remoteForwardHandlerInstalled: boolean;
  initializationState: "initializing" | "ready" | "failed";
  exitEmitted?: boolean;
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
    const cachedSnapshot = instance.windowsPromptMarkerState || null;
    let snapshot: WindowsPromptMarkerState | null = null;
    try {
      snapshot = await this.refreshWindowsPromptMarkerState(instance, {
        allowCachedFallback: false,
      });
    } catch {
      snapshot = null;
    }
    if (!snapshot && !cachedSnapshot) {
      const resetOk = await this.resetWindowsPromptMarker(instance);
      return {
        mode: "windows-powershell-sidecar",
        baselineSequence: 0,
        awaitingInitialFreshMarker: !resetOk,
        dispatchMode: instance.windowsCommandRequestPath
          ? "prompt-file"
          : undefined,
        displayMode: instance.windowsCommandRequestPath
          ? "synthetic-transcript"
          : undefined,
        commandRequestPath: instance.windowsCommandRequestPath,
        commandOutputPath: instance.windowsCommandOutputPath,
      };
    }
    const resolvedSnapshot = snapshot || cachedSnapshot;
    if (!resolvedSnapshot) {
      return undefined;
    }
    return {
      mode: "windows-powershell-sidecar",
      baselineSequence: resolvedSnapshot.sequence,
      awaitingInitialFreshMarker: !snapshot && !!cachedSnapshot,
      dispatchMode: instance.windowsCommandRequestPath
        ? "prompt-file"
        : undefined,
      displayMode: instance.windowsCommandRequestPath
        ? "synthetic-transcript"
        : undefined,
      commandRequestPath: instance.windowsCommandRequestPath,
      commandOutputPath: instance.windowsCommandOutputPath,
    };
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
    const snapshot = token.awaitingInitialFreshMarker
      ? await this.refreshWindowsPromptMarkerStateViaExec(instance, {
          allowCachedFallback: false,
        })
      : await this.refreshWindowsPromptMarkerState(instance);
    if (!snapshot || snapshot.sequence <= token.baselineSequence) {
      return undefined;
    }
    const preferExecOutputRead = Boolean(token.awaitingInitialFreshMarker);
    if (token.awaitingInitialFreshMarker) {
      const dispatchedAtMs = token.dispatchedAtMs || 0;
      if (
        snapshot.modifiedAtMs !== undefined &&
        snapshot.modifiedAtMs <= dispatchedAtMs
      ) {
        token.baselineSequence = snapshot.sequence;
        return undefined;
      }
      token.awaitingInitialFreshMarker = false;
    }
    const output = await this.readWindowsCommandOutputBestEffort(
      instance,
      token.commandOutputPath || instance.windowsCommandOutputPath,
      { preferExec: preferExecOutputRead },
    );
    return {
      mode: "windows-powershell-sidecar",
      sequence: snapshot.sequence,
      exitCode: snapshot.exitCode,
      cwd: snapshot.cwd,
      homeDir: snapshot.homeDir,
      output,
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

  private stripReadyMarker(chunk: string): string {
    if (!chunk.includes(GYSHELL_READY_MARKER)) return chunk;
    return chunk.replace(/__GYSHELL_READY__/g, "");
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
          stdout += d.toString("utf8");
        });
        stream.stderr.on("data", (d: Buffer) => {
          stderr += d.toString("utf8");
        });
        stream.on("close", () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
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

  private buildWindowsBootstrapInfoCommand(): string {
    const script = [
      "$utf8=[System.Text.UTF8Encoding]::new($false)",
      "[Console]::OutputEncoding=$utf8",
      "$OutputEncoding=$utf8",
      "$json=([pscustomobject]@{Version=[Environment]::OSVersion.Version.ToString();CSName=$env:COMPUTERNAME;Arch=$(if([Environment]::Is64BitOperatingSystem){'x64'}else{'x86'});TempPath=[IO.Path]::GetTempPath();PSVersionMajor=$PSVersionTable.PSVersion.Major}|ConvertTo-Json -Compress)",
      "$bytes=$utf8.GetBytes($json)",
      "[Console]::OpenStandardOutput().Write($bytes,0,$bytes.Length)",
    ].join(";");
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    return `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${encoded}`;
  }

  private shouldUseWindowsPowerShellSidecar(instance: SSHInstance): boolean {
    return shouldUseWindowsPowerShellSidecar({
      buildNumber: instance.windowsBuildNumber,
      shell: String(instance.systemInfo?.shell || "powershell.exe"),
      trackingChannelAvailable: !instance.sftpInitError,
    });
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
  }): string {
    return buildWindowsPowerShellEncodedCommand({
      readyMarker: GYSHELL_READY_MARKER,
      commandTrackingMode: options?.commandTrackingMode || "shell-integration",
      promptMarkerPath: options?.promptMarkerPath,
      commandRequestPath: options?.commandRequestPath,
      commandOutputPath: options?.commandOutputPath,
    });
  }

  private getShellInitRetryIntervalMs(
    remoteOs: SSHInstance["remoteOs"],
  ): number {
    return remoteOs === "windows"
      ? SSHBackend.WINDOWS_SHELL_INIT_RETRY_INTERVAL_MS
      : SSHBackend.SHELL_INIT_RETRY_INTERVAL_MS;
  }

  private async bootstrapWindowsSession(instance: SSHInstance): Promise<void> {
    try {
      const info = await this.execCollect(
        instance.client,
        this.buildWindowsBootstrapInfoCommand(),
        10000,
      );
      const parsed = JSON.parse(info.stdout || "{}") as WindowsBootstrapInfo;
      const release = String(parsed.Version || "").trim();
      const tempPath = String(parsed.TempPath || "").trim();
      const nextSystemInfo = {
        os: "Windows",
        platform: "win32",
        release,
        arch: String(parsed.Arch || "").trim(),
        hostname: String(parsed.CSName || "").trim(),
        isRemote: true,
        shell: "powershell.exe",
      };
      instance.systemInfo = nextSystemInfo;
      instance.windowsBuildNumber = parseWindowsBuildNumber(release);
      instance.commandTrackingMode = this.shouldUseWindowsPowerShellSidecar(
        instance,
      )
        ? "windows-powershell-sidecar"
        : "shell-integration";
      if (instance.commandTrackingMode === "windows-powershell-sidecar") {
        const fallbackTempPath = tempPath || "C:/Windows/Temp";
        await this.cleanupStaleWindowsPromptMarkers(instance, fallbackTempPath);
        instance.windowsPromptMarkerPath = this.buildWindowsPromptMarkerPath(
          fallbackTempPath,
          instance.sshConfig?.id || "ssh",
        );
        instance.windowsCommandRequestPath =
          this.buildWindowsCommandRequestPath(
            fallbackTempPath,
            instance.sshConfig?.id || "ssh",
          );
        instance.windowsCommandOutputPath = this.buildWindowsCommandOutputPath(
          fallbackTempPath,
          instance.sshConfig?.id || "ssh",
        );
      } else {
        instance.windowsPromptMarkerPath = undefined;
        instance.windowsCommandRequestPath = undefined;
        instance.windowsCommandOutputPath = undefined;
      }
      instance.windowsPromptMarkerState = undefined;
    } catch {
      instance.commandTrackingMode = "shell-integration";
      instance.windowsPromptMarkerPath = undefined;
      instance.windowsCommandRequestPath = undefined;
      instance.windowsCommandOutputPath = undefined;
    }
  }

  private async cleanupStaleWindowsPromptMarkers(
    instance: SSHInstance,
    tempPath: string,
  ): Promise<void> {
    const markerDir = this.buildWindowsPromptMarkerDirectory(tempPath).replace(
      /\//g,
      "\\",
    );
    const cutoffDays = Math.floor(
      WINDOWS_POWERSHELL_SIDECAR_RETENTION_MS / (24 * 60 * 60 * 1000),
    );
    const script = [
      `$__gyshell_marker_dir='${escapePowerShellSingleQuotedString(markerDir)}'`,
      `if(Test-Path -LiteralPath $__gyshell_marker_dir){Get-ChildItem -LiteralPath $__gyshell_marker_dir -File -ErrorAction SilentlyContinue|Where-Object{($_.Name -like 'gyshell-prompt-*.log' -or $_.Name -like '${WINDOWS_POWERSHELL_COMMAND_REQUEST_FILE_PREFIX}*.b64' -or $_.Name -like '${WINDOWS_POWERSHELL_COMMAND_OUTPUT_FILE_PREFIX}*.txt') -and $_.LastWriteTimeUtc -lt (Get-Date).ToUniversalTime().AddDays(-${cutoffDays})}|Remove-Item -Force -ErrorAction SilentlyContinue}`,
    ].join(";");
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    try {
      await this.execCollect(
        instance.client,
        `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${encoded}`,
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
    const markerPath = this.normalizeRemotePath(
      instance.windowsPromptMarkerPath,
    ).replace(/\//g, "\\");
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
        `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${encoded}`,
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
  ): Promise<WindowsPromptMarkerState | null> {
    if (!instance.windowsPromptMarkerPath) {
      return null;
    }
    const sftp = await this.initializeSftp(instance);
    const normalizedPath = this.normalizeRemotePath(
      instance.windowsPromptMarkerPath,
    );
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
      return null;
    }

    const readSize = Math.min(
      totalSize,
      SSHBackend.WINDOWS_PROMPT_MARKER_TAIL_BYTES,
    );
    const startOffset = Math.max(0, totalSize - readSize);
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
        return null;
      }
      const text = buffer.subarray(0, bytesRead).toString("utf8");
      const lines = text.split(/\r?\n/);
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const parsed = parseWindowsPromptMarkerLine(lines[index] || "");
        if (parsed) {
          return {
            sequence: parsed.sequence,
            exitCode: parsed.exitCode,
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
    options?: { allowCachedFallback?: boolean },
  ): Promise<WindowsPromptMarkerState | null> {
    let next: WindowsPromptMarkerState | null = null;
    try {
      next = await this.readWindowsPromptMarkerState(instance);
    } catch (error) {
      next = await this.readWindowsPromptMarkerStateViaExec(instance).catch(
        () => {
          throw error;
        },
      );
    }
    return this.applyWindowsPromptMarkerState(instance, next, options);
  }

  private async refreshWindowsPromptMarkerStateViaExec(
    instance: SSHInstance,
    options?: { allowCachedFallback?: boolean },
  ): Promise<WindowsPromptMarkerState | null> {
    const next = await this.readWindowsPromptMarkerStateViaExec(instance);
    return this.applyWindowsPromptMarkerState(instance, next, options);
  }

  private applyWindowsPromptMarkerState(
    instance: SSHInstance,
    next: WindowsPromptMarkerState | null,
    options?: { allowCachedFallback?: boolean },
  ): WindowsPromptMarkerState | null {
    if (!next) {
      if (options?.allowCachedFallback === false) {
        return null;
      }
      return instance.windowsPromptMarkerState || null;
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
  ): Promise<WindowsPromptMarkerState | null> {
    if (!instance.windowsPromptMarkerPath) {
      return null;
    }
    const markerPath = this.normalizeRemotePath(
      instance.windowsPromptMarkerPath,
    ).replace(/\//g, "\\");
    const script = [
      "$__gyshell_utf8=[Text.UTF8Encoding]::new($false)",
      "[Console]::OutputEncoding=$__gyshell_utf8",
      "$OutputEncoding=$__gyshell_utf8",
      `$__gyshell_marker_path='${escapePowerShellSingleQuotedString(markerPath)}'`,
      "if(Test-Path -LiteralPath $__gyshell_marker_path){$__gyshell_item=Get-Item -LiteralPath $__gyshell_marker_path -ErrorAction SilentlyContinue;$__gyshell_line=Get-Content -LiteralPath $__gyshell_marker_path -Tail 1 -ErrorAction SilentlyContinue;if($null -ne $__gyshell_line){$__gyshell_json=([pscustomobject]@{line=[string]$__gyshell_line;modifiedAtMs=[int64]([DateTimeOffset]$__gyshell_item.LastWriteTimeUtc).ToUnixTimeMilliseconds()}|ConvertTo-Json -Compress);$__gyshell_bytes=$__gyshell_utf8.GetBytes($__gyshell_json);[Console]::OpenStandardOutput().Write($__gyshell_bytes,0,$__gyshell_bytes.Length)}}",
    ].join(";");
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    const result = await this.execCollect(
      instance.client,
      `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${encoded}`,
      6000,
    );
    const text = String(result.stdout || "").trim();
    if (!text) {
      return null;
    }
    try {
      const parsedJson = JSON.parse(text) as {
        line?: string;
        modifiedAtMs?: number;
      };
      const parsed = parseWindowsPromptMarkerLine(
        String(parsedJson.line || ""),
      );
      if (!parsed) {
        return null;
      }
      return {
        sequence: parsed.sequence,
        exitCode: parsed.exitCode,
        cwd: parsed.cwd
          ? this.normalizeDecodedRemotePath(parsed.cwd) || undefined
          : undefined,
        homeDir: parsed.homeDir
          ? this.normalizeDecodedRemotePath(parsed.homeDir) || undefined
          : undefined,
        modifiedAtMs: Number.isFinite(Number(parsedJson.modifiedAtMs))
          ? Number(parsedJson.modifiedAtMs)
          : undefined,
      };
    } catch {
      const lines = text.split(/\r?\n/);
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const parsed = parseWindowsPromptMarkerLine(lines[index] || "");
        if (parsed) {
          return {
            sequence: parsed.sequence,
            exitCode: parsed.exitCode,
            cwd: parsed.cwd
              ? this.normalizeDecodedRemotePath(parsed.cwd) || undefined
              : undefined,
            homeDir: parsed.homeDir
              ? this.normalizeDecodedRemotePath(parsed.homeDir) || undefined
              : undefined,
          };
        }
      }
    }
    return null;
  }

  private async readWindowsCommandOutput(
    instance: SSHInstance,
    outputPath: string,
  ): Promise<string | undefined> {
    const sftp = await this.initializeSftp(instance);
    const normalizedPath = this.normalizeRemotePath(outputPath);
    try {
      const data = await new Promise<Buffer>((resolve, reject) => {
        sftp.readFile(normalizedPath, (err, buf) => {
          if (err || !buf) {
            reject(
              err || new Error("Failed to read Windows sidecar output file"),
            );
            return;
          }
          resolve(buf as Buffer);
        });
      });
      return data.toString("utf8").replace(/^\ufeff/, "");
    } catch (error: any) {
      if (error?.code === 2 || error?.code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  }

  private async readWindowsCommandOutputViaExec(
    instance: SSHInstance,
    outputPath: string,
  ): Promise<string | undefined> {
    const normalizedPath = this.normalizeRemotePath(outputPath).replace(
      /\//g,
      "\\",
    );
    const script = [
      "$__gyshell_utf8=[Text.UTF8Encoding]::new($false)",
      "[Console]::OutputEncoding=$__gyshell_utf8",
      "$OutputEncoding=$__gyshell_utf8",
      `$__gyshell_output_path='${escapePowerShellSingleQuotedString(normalizedPath)}'`,
      "if(Test-Path -LiteralPath $__gyshell_output_path){$__gyshell_text=[IO.File]::ReadAllText($__gyshell_output_path,$__gyshell_utf8);$__gyshell_bytes=$__gyshell_utf8.GetBytes($__gyshell_text);[Console]::OpenStandardOutput().Write($__gyshell_bytes,0,$__gyshell_bytes.Length)}",
    ].join(";");
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    const result = await this.execCollect(
      instance.client,
      `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${encoded}`,
      6000,
    );
    const stdout = String(result.stdout || "");
    return stdout ? stdout.replace(/^\ufeff/, "") : undefined;
  }

  private async readWindowsCommandOutputBestEffort(
    instance: SSHInstance,
    outputPath: string | undefined,
    options?: { preferExec?: boolean },
  ): Promise<string | undefined> {
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
    if (!markerPath) {
      instance.windowsCommandRequestPath = undefined;
      instance.windowsCommandOutputPath = undefined;
      return;
    }
    const sftp = instance.sftp;
    if (!sftp) {
      instance.windowsPromptMarkerPath = undefined;
      instance.windowsCommandRequestPath = undefined;
      instance.windowsCommandOutputPath = undefined;
      instance.windowsPromptMarkerState = undefined;
      return;
    }
    try {
      await this.sftpUnlink(sftp, this.normalizeRemotePath(markerPath));
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
      const markerDir = this.normalizeRemotePath(dirname(markerPath));
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
    this.sessions.delete(ptyId);
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
      oscBuffer: "",
      forwardServers: [],
      remoteForwards: [],
      remoteForwardHandlerInstalled: false,
      initializationState: "initializing",
      systemInfoRetryCount: 0,
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
          const uname = await this.execCollect(client, "uname -s");
          const u = (uname.stdout || uname.stderr || "").toLowerCase();
          if (u.includes("linux") || u.includes("darwin")) {
            instance.remoteOs = "unix";
          }
        } catch {
          // ignore
        }
        if (!instance.remoteOs) {
          try {
            const ver = await this.execCollect(client, "cmd.exe /c ver");
            const v = (ver.stdout || ver.stderr || "").toLowerCase();
            if (v.includes("windows")) instance.remoteOs = "windows";
          } catch {
            // ignore
          }
        }
        if (!instance.remoteOs) instance.remoteOs = "unix";
        console.log(`[SSH] Remote OS detected: ${instance.remoteOs}`);

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

        if (instance.remoteOs === "windows") {
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

            const attemptInjection = () => {
              if (!instance.stream || isReadySent || !instance.isInitializing)
                return;

              console.log(`[SSH] Injection attempt ${retryCount + 1}...`);
              if (instance.remoteOs !== "windows" || retryCount > 0) {
                instance.stream.write("\x03\n\n");
              }

              setTimeout(() => {
                if (!instance.stream || isReadySent || !instance.isInitializing)
                  return;
                if (instance.remoteOs === "windows") {
                  const b64 = this.buildWindowsPowerShellEncodedCommand({
                    commandTrackingMode: instance.commandTrackingMode,
                    promptMarkerPath: instance.windowsPromptMarkerPath,
                    commandRequestPath: instance.windowsCommandRequestPath,
                    commandOutputPath: instance.windowsCommandOutputPath,
                  });
                  instance.stream.write(
                    `powershell.exe -NoLogo -NoProfile -NoExit -EncodedCommand ${b64}\r`,
                  );
                } else {
                  const script = this.getUnixInjectionScript();
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
            }, this.getShellInitRetryIntervalMs(instance.remoteOs));

            stream.on("data", (data: Buffer) => {
              const chunk = data.toString();
              if (instance.isInitializing) {
                instance.buffer += chunk;
                if (instance.buffer.includes(GYSHELL_READY_MARKER)) {
                  emit("\x1b[2J\x1b[H"); // Clear screen
                  isReadySent = true;
                  clearInterval(watchdogInterval);
                  const sawContinuation =
                    /(?:\r?\n)>>\s*\r?\n/.test(instance.buffer) ||
                    instance.buffer.trimEnd().endsWith("\n>>") ||
                    instance.buffer.trimEnd().endsWith("\r\n>>");
                  instance.initializationState = "ready";
                  instance.isInitializing = false;
                  const parts = instance.buffer.split(GYSHELL_READY_MARKER);
                  if (parts.length > 1) {
                    const realContent = this.stripReadyMarker(
                      parts.slice(1).join(GYSHELL_READY_MARKER),
                    ).trimStart();
                    if (realContent) emit(realContent);
                  }
                  instance.buffer = "";
                  if (
                    sawContinuation &&
                    instance.remoteOs === "windows" &&
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
                const sanitizedChunk = this.stripReadyMarker(chunk);
                this.consumeOscMarkers(instance, sanitizedChunk);
                if (sanitizedChunk) {
                  emit(sanitizedChunk);
                }
              }
            });

            stream.on("close", async (code: number) => {
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

  private getUnixInjectionScript(): string {
    // Minified script to reduce payload size and potential TTY buffer issues
    const script = `
if [ -n "$ZSH_VERSION" ]; then
  gyshell_preexec() { builtin printf "\\033]1337;gyshell_preexec\\007"; }
  gyshell_precmd() { local ec=$? cwd_b64 home_b64; cwd_b64=$(printf "%s" "$PWD" | base64 | tr -d "\\n"); home_b64=$(printf "%s" "$HOME" | base64 | tr -d "\\n"); builtin printf "\\033]1337;gyshell_precmd;ec=%s;cwd_b64=%s;home_b64=%s\\007" "$ec" "$cwd_b64" "$home_b64"; }
  autoload -Uz add-zsh-hook 2>/dev/null || true
  add-zsh-hook preexec gyshell_preexec
  add-zsh-hook precmd gyshell_precmd
elif [ -n "$BASH_VERSION" ]; then
  __gyshell_in_command=0
  __gyshell_preexec() {
    case "$BASH_COMMAND" in
      __gyshell_precmd*|__gyshell_preexec* ) return ;;
    esac
    if [ "$__gyshell_in_command" = "0" ]; then
      __gyshell_in_command=1
      builtin printf "\\033]1337;gyshell_preexec\\007"
    fi
  }
  trap '__gyshell_preexec' DEBUG
  __gyshell_precmd() {
    local ec=$?
    local cwd_b64 home_b64
    __gyshell_in_command=0
    cwd_b64=$(printf "%s" "$PWD" | base64 | tr -d "\\n")
    home_b64=$(printf "%s" "$HOME" | base64 | tr -d "\\n")
    builtin printf "\\033]1337;gyshell_precmd;ec=%s;cwd_b64=%s;home_b64=%s\\007" "$ec" "$cwd_b64" "$home_b64"
  }
  PROMPT_COMMAND="__gyshell_precmd\${PROMPT_COMMAND:+; \$PROMPT_COMMAND}"
fi
echo "__GYSHELL_READY__"
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

  private consumeOscMarkers(instance: SSHInstance, chunk: string): void {
    instance.oscBuffer += chunk;
    const prefix = "\x1b]1337;gyshell_precmd";
    const suffix = "\x07";

    while (true) {
      const start = instance.oscBuffer.indexOf(prefix);
      if (start === -1) break;
      const end = instance.oscBuffer.indexOf(suffix, start);
      if (end === -1) break;

      const marker = instance.oscBuffer.slice(start, end);
      const cwdMatch = marker.match(/cwd_b64=([^;]+)/);
      if (cwdMatch && cwdMatch[1]) {
        try {
          const decoded = Buffer.from(cwdMatch[1], "base64").toString("utf8");
          const normalized = this.normalizeDecodedRemotePath(decoded);
          if (normalized) instance.cwd = normalized;
        } catch {}
      }

      const homeMatch = marker.match(/home_b64=([^;]+)/);
      if (homeMatch && homeMatch[1]) {
        try {
          const decoded = Buffer.from(homeMatch[1], "base64").toString("utf8");
          const normalized = this.normalizeDecodedRemotePath(decoded);
          if (normalized) instance.homeDir = normalized;
        } catch {}
      }

      instance.oscBuffer = instance.oscBuffer.slice(end + suffix.length);
    }

    if (instance.oscBuffer.length > 8192) {
      instance.oscBuffer = instance.oscBuffer.slice(-4096);
    }
  }

  private normalizeDecodedRemotePath(decodedPath: string): string | null {
    if (typeof decodedPath !== "string" || decodedPath.length === 0) {
      return null;
    }
    const sanitized = decodedPath.replace(/[\u0000-\u001f\u007f]/g, "");
    return sanitized.length > 0 ? sanitized : null;
  }
}
