import { SSHBackend } from "./SSHBackend";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { COMMAND_CAPTURE_MAX_UTF8_BYTES } from "@gyshell/shared";
import { buildInitializationReadyMarker } from "./terminal/CommandStreamProtocol";

const assertEqual = <T>(actual: T, expected: T, message: string): void => {
  if (actual !== expected) {
    throw new Error(
      `${message}. expected=${String(expected)} actual=${String(actual)}`,
    );
  }
};

const assertCondition = (condition: unknown, message: string): void => {
  if (!condition) {
    throw new Error(message);
  }
};

const runCase = async (
  name: string,
  fn: () => Promise<void> | void,
): Promise<void> => {
  await fn();
  console.log(`PASS ${name}`);
};

const createSession = () =>
  ({
    client: {},
    dataCallbacks: new Set(),
    exitCallbacks: new Set(),
    isInitializing: true,
    buffer: "",
    oscBuffer: "",
    forwardServers: [],
    remoteForwards: [],
    remoteForwardHandlerInstalled: false,
    initializationState: "initializing",
  }) as any;

class StalledJumpClient extends EventEmitter {
  ends = 0;
  forwardCallback:
    | ((error: Error | undefined, stream?: EventEmitter) => void)
    | null = null;

  connect(): void {
    queueMicrotask(() => this.emit("ready"));
  }

  forwardOut(
    _sourceHost: string,
    _sourcePort: number,
    _targetHost: string,
    _targetPort: number,
    callback: (error: Error | undefined, stream?: EventEmitter) => void,
  ): void {
    this.forwardCallback = callback;
  }

  end(): void {
    this.ends += 1;
  }
}

class PendingSshClient extends EventEmitter {
  ends = 0;

  connect(): void {}

  end(): void {
    this.ends += 1;
  }
}

const run = async (): Promise<void> => {
  await runCase(
    "peer transfer passes only active Unix SSH session descriptors",
    async () => {
      const backend = new SSHBackend() as any;
      const source = createSession();
      const target = createSession();
      source.remoteOs = "unix";
      target.remoteOs = "unix";
      source.observedHostKey = Buffer.from("source-host-key");
      target.observedHostKey = Buffer.from("target-host-key");
      source.sshConfig = {
        type: "ssh",
        id: "source",
        title: "Source",
        cols: 80,
        rows: 24,
        host: "source.example.test",
        port: 22,
        username: "source-user",
        authMethod: "password",
        password: "source-password",
      };
      target.sshConfig = {
        type: "ssh",
        id: "target",
        title: "Target",
        cols: 80,
        rows: 24,
        host: "target.example.test",
        port: 22,
        username: "target-user",
        authMethod: "password",
        password: "target-password",
      };
      backend.sessions.set("source-pty", source);
      backend.sessions.set("target-pty", target);

      let captured: any = null;
      backend.directFileTransfer.tryTransfer = async (request: any) => {
        captured = request;
        return { status: "transferred", transferredBytes: 99 };
      };
      const result = await backend.tryPeerFileTransfer(
        "source-pty",
        "/src/file.bin",
        "target-pty",
        "/dst/file.bin",
        { expectedBytes: 99 },
      );

      assertEqual(
        result.status,
        "transferred",
        "eligible sessions should reach direct service",
      );
      assertEqual(
        captured.sourceClient,
        source.client,
        "source client should come from active tab",
      );
      assertEqual(
        captured.targetClient,
        target.client,
        "target client should come from active tab",
      );
      assertCondition(
        captured.targetObservedHostKey.equals(target.observedHostKey),
        "target host pin should be the active session key",
      );
    },
  );

  await runCase(
    "peer transfer fails closed for Windows or unobserved host keys",
    async () => {
      const backend = new SSHBackend() as any;
      const source = createSession();
      const target = createSession();
      source.remoteOs = "unix";
      target.remoteOs = "windows";
      backend.sessions.set("source-pty", source);
      backend.sessions.set("target-pty", target);

      const windowsResult = await backend.tryPeerFileTransfer(
        "source-pty",
        "/src/file.bin",
        "target-pty",
        "C:/dst/file.bin",
        { expectedBytes: 99 },
      );
      assertEqual(
        windowsResult.status,
        "fallback",
        "Windows target should use relay",
      );
      assertEqual(
        (windowsResult as any).reason,
        "unsupported-os",
        "Windows fallback should be typed",
      );

      target.remoteOs = "unix";
      const missingKeyResult = await backend.tryPeerFileTransfer(
        "source-pty",
        "/src/file.bin",
        "target-pty",
        "/dst/file.bin",
        { expectedBytes: 99 },
      );
      assertEqual(
        missingKeyResult.status,
        "fallback",
        "missing host key should use relay",
      );
      assertEqual(
        (missingKeyResult as any).reason,
        "missing-host-key",
        "missing host key fallback should be typed",
      );
    },
  );

  await runCase(
    "base ssh connect config enables protocol keepalive for direct connections",
    () => {
      const backend = new SSHBackend() as any;
      const connectConfig = backend.buildBaseConnectConfig({
        type: "ssh",
        id: "direct-keepalive",
        title: "Direct Keepalive",
        host: "example.test",
        port: 22,
        username: "tester",
        authMethod: "password",
        password: "secret",
        cols: 80,
        rows: 24,
      });

      assertEqual(
        connectConfig.keepaliveInterval,
        30_000,
        "direct SSH connections should send encrypted keepalive probes",
      );
      assertEqual(
        connectConfig.keepaliveCountMax,
        3,
        "direct SSH connections should keep ssh2's bounded keepalive failure threshold",
      );
      assertEqual(
        connectConfig.readyTimeout,
        20_000,
        "direct SSH connections should preserve the existing ready timeout",
      );
    },
  );

  await runCase(
    "base ssh connect config keeps protocol keepalive for tunneled jump connections",
    () => {
      const backend = new SSHBackend() as any;
      const sock = new EventEmitter();
      const connectConfig = backend.buildBaseConnectConfig(
        {
          type: "ssh",
          id: "jump-keepalive",
          title: "Jump Keepalive",
          host: "jump.example.test",
          port: 2222,
          username: "jumper",
          authMethod: "privateKey",
          privateKey: "key",
          cols: 80,
          rows: 24,
        },
        sock,
      );

      assertEqual(
        connectConfig.keepaliveInterval,
        30_000,
        "jump SSH connections should send encrypted keepalive probes",
      );
      assertEqual(
        connectConfig.keepaliveCountMax,
        3,
        "jump SSH connections should keep ssh2's bounded keepalive failure threshold",
      );
      assertEqual(
        connectConfig.sock,
        sock,
        "jump SSH connections should preserve the tunnel socket",
      );
    },
  );

  await runCase(
    "direct key control route reuses jump ingress with a short timeout",
    async () => {
      const backend = new SSHBackend() as any;
      const socket = new EventEmitter();
      let capturedTimeout = 0;
      backend.buildConnectSocketIfNeeded = async (
        _config: unknown,
        _emit: unknown,
        options: { readyTimeoutMs: number },
      ) => {
        capturedTimeout = options.readyTimeoutMs;
        return socket;
      };

      const result = await backend.openDirectControlRouteSocket({
        type: "ssh",
        id: "private-endpoint",
        title: "Private Endpoint",
        host: "10.0.0.2",
        port: 22,
        username: "endpoint-user",
        authMethod: "privateKey",
        privateKey: "key",
        cols: 80,
        rows: 24,
        jumpHost: {
          type: "ssh",
          id: "jump",
          title: "Jump",
          host: "jump.example.test",
          port: 22,
          username: "jump-user",
          authMethod: "password",
          password: "secret",
          cols: 80,
          rows: 24,
        },
      });

      assertEqual(
        result,
        socket,
        "direct control should use the routed socket",
      );
      assertEqual(
        capturedTimeout,
        4_000,
        "direct control jump setup should use the short ready timeout",
      );
    },
  );

  await runCase(
    "cancelled direct control route destroys a late jump socket",
    async () => {
      const backend = new SSHBackend() as any;
      let resolveRoute!: (socket: unknown) => void;
      backend.buildConnectSocketIfNeeded = () =>
        new Promise((resolve) => {
          resolveRoute = resolve;
        });
      const controller = new AbortController();
      const pending = backend.openDirectControlRouteSocket(
        {
          type: "ssh",
          id: "private-endpoint",
          title: "Private Endpoint",
          host: "10.0.0.2",
          port: 22,
          username: "endpoint-user",
          authMethod: "privateKey",
          privateKey: "key",
          cols: 80,
          rows: 24,
        },
        controller.signal,
      );
      controller.abort();
      let caught: Error | null = null;
      try {
        await pending;
      } catch (error) {
        caught = error as Error;
      }
      assertEqual(caught?.name, "AbortError", "cancelled route should reject");

      let destroys = 0;
      resolveRoute({
        destroy: () => {
          destroys += 1;
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      assertEqual(destroys, 1, "late route socket should be destroyed once");
    },
  );

  await runCase(
    "cancelled private-key executor connection rejects and closes the client",
    async () => {
      const backend = new SSHBackend() as any;
      const client = new EventEmitter() as EventEmitter & {
        connect: () => void;
        end: () => void;
      };
      let ends = 0;
      client.connect = () => undefined;
      client.end = () => {
        ends += 1;
      };
      backend.createSshClient = () => client;
      const instance = createSession();
      instance.observedHostKey = Buffer.from("executor-host-key");
      instance.sshConfig = {
        type: "ssh",
        id: "executor",
        title: "Executor",
        host: "executor.example.test",
        port: 22,
        username: "executor-user",
        authMethod: "privateKey",
        privateKey: "private-key",
        cols: 80,
        rows: 24,
      };
      const controller = new AbortController();
      const pending = backend.openAgentExecutorClient(
        instance,
        "/tmp/gyshell-test-agent.sock",
        controller.signal,
      );
      controller.abort();

      let caught: Error | null = null;
      try {
        await pending;
      } catch (error) {
        caught = error as Error;
      }
      assertEqual(
        caught?.name,
        "AbortError",
        "cancelled executor connection should reject",
      );
      assertCondition(ends >= 1, "cancelled executor client should close");
    },
  );

  await runCase(
    "executor client retains its error sink after a failed handshake settles",
    async () => {
      const backend = new SSHBackend() as any;
      const client = new PendingSshClient();
      backend.createSshClient = () => client;
      const instance = createSession();
      instance.observedHostKey = Buffer.from("executor-host-key");
      instance.sshConfig = {
        type: "ssh",
        id: "executor-double-error",
        title: "Executor Double Error",
        host: "executor.example.test",
        port: 22,
        username: "executor-user",
        authMethod: "privateKey",
        privateKey: "private-key",
        cols: 80,
        rows: 24,
      };

      const pending = backend.openAgentExecutorClient(
        instance,
        "/tmp/gyshell-test-agent.sock",
      );
      client.emit("error", new Error("simulated socket reset"));
      assertEqual(
        await pending,
        null,
        "the first executor error should settle as unavailable",
      );
      assertEqual(
        client.listenerCount("error"),
        1,
        "the executor error sink must survive settlement",
      );

      let secondError: Error | null = null;
      try {
        client.emit("error", new Error("Connection lost before handshake"));
      } catch (error) {
        secondError = error as Error;
      }
      assertEqual(
        secondError,
        null,
        "a second executor handshake error must remain handled",
      );
    },
  );

  await runCase(
    "jump client retains its error sink after route setup rejects",
    async () => {
      const backend = new SSHBackend() as any;
      const jumpClient = new PendingSshClient();
      backend.createSshClient = () => jumpClient;
      const pending = backend.buildConnectSocketIfNeeded(
        {
          type: "ssh",
          id: "private-endpoint-double-error",
          title: "Private Endpoint Double Error",
          host: "10.0.0.2",
          port: 22,
          username: "endpoint-user",
          authMethod: "password",
          password: "endpoint-secret",
          cols: 80,
          rows: 24,
          jumpHost: {
            type: "ssh",
            id: "jump-double-error",
            title: "Jump Double Error",
            host: "jump.example.test",
            port: 22,
            username: "jump-user",
            authMethod: "password",
            password: "jump-secret",
            cols: 80,
            rows: 24,
          },
        },
        () => {},
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      jumpClient.emit("error", new Error("simulated socket reset"));

      let firstError: Error | null = null;
      try {
        await pending;
      } catch (error) {
        firstError = error as Error;
      }
      assertEqual(
        firstError?.message,
        "simulated socket reset",
        "the first jump error should reject route setup",
      );
      assertEqual(
        jumpClient.listenerCount("error"),
        1,
        "the jump error sink must survive settlement",
      );

      let secondError: Error | null = null;
      try {
        jumpClient.emit("error", new Error("Connection lost before handshake"));
      } catch (error) {
        secondError = error as Error;
      }
      assertEqual(
        secondError,
        null,
        "a second jump handshake error must remain handled",
      );
    },
  );

  await runCase(
    "jump forward timeout closes the route and any late stream",
    async () => {
      const backend = new SSHBackend() as any;
      const jumpClient = new StalledJumpClient();
      backend.createSshClient = () => jumpClient;
      const startedAt = Date.now();
      let caught: Error | null = null;
      try {
        await backend.buildConnectSocketIfNeeded(
          {
            type: "ssh",
            id: "private-endpoint",
            title: "Private Endpoint",
            host: "10.0.0.2",
            port: 22,
            username: "endpoint-user",
            authMethod: "password",
            password: "endpoint-secret",
            cols: 80,
            rows: 24,
            jumpHost: {
              type: "ssh",
              id: "jump",
              title: "Jump",
              host: "jump.example.test",
              port: 22,
              username: "jump-user",
              authMethod: "password",
              password: "jump-secret",
              cols: 80,
              rows: 24,
            },
          },
          () => {},
          { readyTimeoutMs: 50, forwardTimeoutMs: 20 },
        );
      } catch (error) {
        caught = error as Error;
      }

      assertCondition(!!caught, "stalled forward should reject");
      assertCondition(
        Date.now() - startedAt < 500,
        "stalled forward should respect its short deadline",
      );
      assertCondition(jumpClient.ends >= 1, "timeout should close jump client");

      let lateCloses = 0;
      const lateStream = new EventEmitter() as EventEmitter & {
        close: () => void;
      };
      lateStream.close = () => {
        lateCloses += 1;
      };
      jumpClient.forwardCallback?.(undefined, lateStream);
      assertEqual(lateCloses, 1, "late forward stream should close once");
    },
  );

  await runCase(
    "jump forward cancellation closes the underlying jump client",
    async () => {
      const backend = new SSHBackend() as any;
      const jumpClient = new StalledJumpClient();
      backend.createSshClient = () => jumpClient;
      const controller = new AbortController();
      const pending = backend.buildConnectSocketIfNeeded(
        {
          type: "ssh",
          id: "private-endpoint",
          title: "Private Endpoint",
          host: "10.0.0.2",
          port: 22,
          username: "endpoint-user",
          authMethod: "password",
          password: "endpoint-secret",
          cols: 80,
          rows: 24,
          jumpHost: {
            type: "ssh",
            id: "jump",
            title: "Jump",
            host: "jump.example.test",
            port: 22,
            username: "jump-user",
            authMethod: "password",
            password: "jump-secret",
            cols: 80,
            rows: 24,
          },
        },
        () => {},
        {
          signal: controller.signal,
          readyTimeoutMs: 1_000,
          forwardTimeoutMs: 1_000,
        },
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      controller.abort();
      let caught: Error | null = null;
      try {
        await pending;
      } catch (error) {
        caught = error as Error;
      }

      assertEqual(
        caught?.name,
        "AbortError",
        "route cancellation should abort",
      );
      assertCondition(jumpClient.ends >= 1, "abort should close jump client");
    },
  );

  await runCase(
    "windows in-band fallback keeps the existing OSC prompt path for supported builds",
    async () => {
      const backend = new SSHBackend();
      const runtimeToken = "0123456789abcdef0123456789abcdef";
      const privatePrefix = `__gyshell_${runtimeToken}`;
      const encoded = (backend as any).buildWindowsPowerShellEncodedCommand({
        commandTrackingMode: "shell-integration",
        commandProtocolToken: runtimeToken,
      }) as string;
      const decoded = Buffer.from(encoded, "base64").toString("utf16le");

      assertCondition(
        decoded.includes(
          `[Console]::InputEncoding=$${privatePrefix}_utf8;[Console]::OutputEncoding=$${privatePrefix}_utf8;$OutputEncoding=$${privatePrefix}_utf8`,
        ),
        "modern Windows SSH shells must use UTF-8 for input, output, and native pipelines",
      );
      assertCondition(
        decoded.includes(buildInitializationReadyMarker(runtimeToken)),
        "the Windows SSH bootstrap completion marker must be scoped to this runtime",
      );
      assertCondition(
        decoded.includes(
          `Write-Host -NoNewline "$([char]27)]1337;gyshell_${runtimeToken}_precmd;seq=$($global:${privatePrefix}_prompt_seq)$${privatePrefix}_ec_field;cwd_b64=$${privatePrefix}_cwd_b64;home_b64=$${privatePrefix}_home_b64$([char]7)"`,
        ),
        "windows init script should collision-harden the precmd marker and omit an untrustworthy exit code",
      );
      assertCondition(
          decoded.includes(`$${privatePrefix}_ok=$?;$${privatePrefix}_native=$LASTEXITCODE`) &&
          decoded.includes(`$${privatePrefix}_has_native_error=$${privatePrefix}_has_new_error -and (([string]$${privatePrefix}_error_ref.FullyQualifiedErrorId) -like 'NativeCommandError*')`) &&
          decoded.includes(`$${privatePrefix}_outcome_known=$true;$${privatePrefix}_ec=if($${privatePrefix}_ok){0}elseif($${privatePrefix}_has_native_error){$${privatePrefix}_outcome_known=$false;if($${privatePrefix}_native -is [int]){$${privatePrefix}_native}else{1}}elseif($${privatePrefix}_native -is [int] -and $${privatePrefix}_native -ne 0){$${privatePrefix}_outcome_known=$false;$${privatePrefix}_native}else{1}`) &&
          decoded.includes(`$${privatePrefix}_ec_field=if($${privatePrefix}_outcome_known){';ec='+$${privatePrefix}_ec}else{''}`),
        "modern prompt outcome logic should report native attribution and stale-native ambiguity conservatively",
      );
      assertCondition(
        decoded.includes(`$global:${privatePrefix}_prompt_seq`) &&
          !decoded.includes("$global:__gyshell_prompt_seq"),
        "windows init helper state should use the same private runtime namespace",
      );
      assertCondition(
        !decoded.includes("__GYSHELL_TASK_FINISH__::ec=$ec"),
        "windows init script should avoid visible finish markers that skew the rendered cursor position",
      );
      assertCondition(
        decoded.includes(';"PS $($PWD.Path)> "} -Force -Options \'AllScope,ReadOnly\''),
        "windows init script should keep visible prompt text separate and protect its managed hook",
      );
      assertCondition(
        !decoded.includes('return "$oscPS $($PWD.Path)> "'),
        "windows init script should not smuggle the OSC marker through the prompt return value",
      );
      assertCondition(
        !decoded.includes("\n"),
        "windows init script should stay minified to avoid slow cmd-shell echo during SSH bootstrap",
      );
    },
  );

  await runCase(
    "windows sidecar init script combines hidden stream capture with request-bound raw frames",
    async () => {
      const backend = new SSHBackend();
      const encoded = (backend as any).buildWindowsPowerShellEncodedCommand({
        commandTrackingMode: "windows-powershell-sidecar",
        promptMarkerPath:
          "C:/Windows/Temp/GyShell/prompt-markers/gyshell-prompt-ssh-1.log",
        commandRequestPath:
          "C:/Windows/Temp/GyShell/prompt-markers/exec-request.b64",
        commandOutputPath:
          "C:/Windows/Temp/GyShell/prompt-markers/exec-output.txt",
      }) as string;
      const decoded = Buffer.from(encoded, "base64").toString("utf16le");

      assertCondition(
        decoded.includes(
          "[Console]::InputEncoding=$__gyshell_utf8;[Console]::OutputEncoding=$__gyshell_utf8;$OutputEncoding=$__gyshell_utf8",
        ),
        "Windows SSH sidecars must share the UTF-8 console contract",
      );
      assertCondition(
        decoded.includes(
          "[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($global:__gyshell_marker_path))|Out-Null",
        ),
        "sidecar init should ensure the temp marker directory exists before writing the hidden file",
      );
      assertCondition(
        decoded.includes(
          "[IO.File]::WriteAllText($global:__gyshell_marker_path,'',$__gyshell_utf8)",
        ),
        "sidecar init should truncate the hidden marker file before first prompt",
      );
      assertCondition(
        decoded.includes(
          "[IO.File]::AppendAllText($global:__gyshell_marker_path,$__line+[Environment]::NewLine,$__gyshell_utf8)",
        ),
        "sidecar init should journal prompt states so a later unrelated prompt cannot erase a matching completion",
      );
      assertCondition(
        decoded.includes("Set-Item -Path Function:\\Global:prompt") &&
          decoded.includes("-Options 'AllScope,ReadOnly'"),
        "the sidecar should protect its managed prompt from accidental replacement",
      );
      assertCondition(
        decoded.includes(
          "[IO.File]::WriteAllText($global:__gyshell_request_path,'',$__gyshell_utf8)",
        ),
        "sidecar init should initialize the hidden command request file for prompt-file dispatch",
      );
      assertCondition(
        decoded.includes(
          "[IO.File]::WriteAllText($global:__gyshell_output_path,'',$__gyshell_utf8)",
        ),
        "sidecar init should initialize the hidden command output file for prompt-file dispatch",
      );
      assertCondition(
        (decoded.match(/\[scriptblock\]::Create\(\$__gyshell_instrumented_cmd\)/g) || [])
          .length === 1,
        "sidecar init must contain exactly one user-command invocation",
      );
      assertCondition(
        decoded.includes("Out-String -Stream -Width 2147483647") &&
          decoded.includes(
            `$global:__gyshell_output_max_bytes=[int64]${COMMAND_CAPTURE_MAX_UTF8_BYTES}`,
          ) &&
          decoded.includes('$global:__gyshell_output_observed=[int64]$global:__gyshell_output_observed+[int64]$__gyshell_bytes.Length;if($global:__gyshell_output_truncated){return}'),
        "sidecar output should flow through a strict-prefix bounded streaming writer",
      );
      assertCondition(
        decoded.includes("Set-Variable -Scope Global -Name '__GyShell_InternalRecordOutcome'") &&
          decoded.includes(';& $global:__GyShell_InternalRecordOutcome ([bool]$?)') &&
          decoded.includes('$__GyShell_InternalUserCommandBlock=[scriptblock]::Create(') &&
          decoded.includes('$global:__gyshell_user_outcome_sampled=$true') &&
          !decoded.includes('if($_ -is [Management.Automation.ErrorRecord]){[string]$_}else{$_}') &&
          decoded.includes('$global:__gyshell_user_exception | Microsoft.PowerShell.Utility\\Out-String'),
        "sidecar status sampling must use a stable diagnostic entry while preserving structured PowerShell error details",
      );
      assertCondition(
        decoded.includes(
          "[Management.Automation.Language.Parser]::ParseInput($__gyshell_cmd",
        ) &&
          decoded.indexOf(
            "[Management.Automation.Language.Parser]::ParseInput($__gyshell_cmd",
          ) <
          decoded.indexOf(
              "[scriptblock]::Create($__gyshell_instrumented_cmd)",
            ),
        "sidecar init must reject malformed source before applying ordinary or named-block instrumentation",
      );
      assertCondition(
        decoded.includes("@('DynamicParamBlock','BeginBlock','ProcessBlock','EndBlock','CleanBlock')") &&
          decoded.includes('$__gyshell_named_block.Extent.EndOffset-1'),
        "named-block scripts must receive their outcome probe inside the last executed block",
      );
      assertCondition(
        decoded.includes(
          "$__has_native_error=$__has_new_error -and (([string]$__error_ref.FullyQualifiedErrorId) -like 'NativeCommandError*')",
        ) &&
          decoded.includes(
            "$__returned_without_sample=$__gyshell_has_request -and -not $global:__gyshell_user_outcome_sampled -and -not $__user_threw",
          ) &&
          decoded.includes('if($__returned_without_sample){$__outcome_known=$false;1}elseif($__ok){0}elseif($__user_threw){1}elseif($__has_native_error){$__outcome_known=$false;') &&
          decoded.includes('elseif($__native -is [int] -and $__native -ne 0){$__outcome_known=$false;$__native}else{1}') &&
          decoded.includes('$global:__gyshell_user_ok=$false;$global:__gyshell_user_native=$LASTEXITCODE') &&
          !decoded.includes('$global:__gyshell_user_ok=$?'),
        "only sampled non-native status should remain exact while native attribution and unsampled control flow are reported conservatively",
      );
      assertCondition(
        decoded.includes("__gyshell_emit_raw_boundary 'preexec' $__gyshell_request_id") &&
          decoded.includes("__gyshell_emit_raw_boundary 'preend' $__gyshell_request_id") &&
          decoded.includes("finally{__gyshell_emit_raw_boundary 'preend' $__gyshell_request_id}") &&
          decoded.includes("nonce=00000000000000000000000000000000"),
        "sidecar dispatch should close raw console framing in finally and synchronize away the dispatcher echo before the real request boundary",
      );
      assertCondition(
        decoded.includes("';request_id='") &&
          decoded.includes("';outcome_known='") &&
          decoded.includes("';output_bytes='") &&
          decoded.includes("';retained_bytes='") &&
          decoded.includes("';output_truncated='"),
        "sidecar prompt markers should publish request identity and verifiable output metadata",
      );
      assertCondition(
        decoded.includes("$__gyshell_request_raw.Substring(33,1) -match '^[pc]$'") &&
          decoded.includes("$global:__gyshell_completed_request_kind=$__gyshell_request_kind") &&
          decoded.includes("if(-not $__gyshell_has_request -or $__gyshell_request_kind -eq 'c')") &&
          decoded.includes('$global:__gyshell_logical_user_ok=[bool]$__ok') &&
          decoded.includes("Write-Error 'GyShell status restoration sentinel' -ErrorAction Ignore"),
        "a hidden probe must preserve the logical PowerShell status restored for the real user request",
      );
      assertCondition(
        !decoded.includes("__gyshell_should_native_fallback") &&
          !decoded.includes("cmd.exe /q /d /s /c") &&
          !decoded.includes("$__gyshell_capture_path") &&
          !decoded.includes("Get-Content -LiteralPath $__gyshell_capture_path -Raw"),
        "sidecar init must not replay commands or create an unbounded intermediate capture",
      );
      assertCondition(
        decoded.includes("$global:__gyshell_last_error_count=@($Error).Count"),
        "sidecar init should track PowerShell error state without mutating LASTEXITCODE",
      );
      assertCondition(
        !decoded.includes("$global:LASTEXITCODE=0"),
        "sidecar init should preserve the user-visible LASTEXITCODE variable",
      );
      assertCondition(
        !decoded.includes("__GYSHELL_TASK_FINISH__::ec=$ec"),
        "sidecar init should not emit the visible task-finish marker in the terminal stream",
      );
      assertCondition(
        decoded.includes("'PS '+$PWD.Path+'> '"),
        "sidecar init should preserve the standard PowerShell prompt text",
      );
    },
  );

  await runCase(
    "unix SSH integration declares whether command boundaries were installed",
    () => {
      const backend = new SSHBackend() as any;
      const runtimeToken = "0123456789abcdef0123456789abcdef";
      const script = backend.getUnixInjectionScript(runtimeToken) as string;

      assertCondition(
        script.includes("__GYSHELL_COMMAND_PROTOCOL__="),
        "the hidden bootstrap should report command protocol capability before readiness",
      );
      assertCondition(
        script.includes(`__gyshell_${runtimeToken}_command_protocol=verified`),
        "bash and zsh branches should declare verified boundaries in a private namespace",
      );
      assertCondition(
        script.includes(`gyshell_${runtimeToken}_preexec`) &&
          script.includes(`__gyshell_${runtimeToken}_command_seq`),
        "SSH markers and hook state should share the runtime-derived namespace",
      );
      assertCondition(
        !script.includes("__gyshell_command_seq") &&
          !script.includes("gyshell_precmd()"),
        "tokenized SSH scripts must not retain public fixed state or hook names",
      );
      assertCondition(
        script.includes(`__gyshell_${runtimeToken}_precmd_begin`) &&
          script.includes(`__gyshell_${runtimeToken}_prompt_commands=()`) &&
          script.includes(
            `PROMPT_COMMAND=(__gyshell_${runtimeToken}_precmd_begin "\${__gyshell_${runtimeToken}_prompt_commands[@]}" __gyshell_${runtimeToken}_precmd)`,
          ),
        "SSH Bash integration must deduplicate and bracket existing prompt hooks",
      );
      assertCondition(
        script.includes(`typeset -gi __gyshell_${runtimeToken}_command_exit=0`) &&
          script.includes(`__gyshell_${runtimeToken}_precmd_begin() { local prior=$?;`) &&
          script.includes(
            `if [ "\${__gyshell_${runtimeToken}_dispatch_completion_ready-0}" != 1 ]; then __gyshell_${runtimeToken}_command_exit=$prior; fi;`,
          ) &&
          script.includes(`gyshell_${runtimeToken}_preend;seq=%s;nonce=%s`) &&
          script.includes(
            `precmd_functions=(__gyshell_${runtimeToken}_precmd_begin \${precmd_functions:#__gyshell_${runtimeToken}_precmd_begin})`,
          ) &&
          script.includes(
            `precmd_functions=(\${precmd_functions:#__gyshell_${runtimeToken}_precmd} __gyshell_${runtimeToken}_precmd)`,
          ),
        "SSH zsh integration must freeze the exit code first and publish its marker last",
      );
      assertCondition(
        script.includes("unsupported"),
        "other remote shells should explicitly fail closed",
      );
    },
  );

  await runCase(
    "repeated SSH Bash integration preserves a failing command exit code",
    () => {
      const backend = new SSHBackend() as any;
      const runtimeToken = "2123456789abcdef2123456789abcdef";
      const script = backend.getUnixInjectionScript(runtimeToken) as string;
      const beginHook = `__gyshell_${runtimeToken}_precmd_begin`;
      const endHook = `__gyshell_${runtimeToken}_precmd`;
      const result = spawnSync("/bin/bash", ["--noprofile", "--norc"], {
        input: [
          "PROMPT_COMMAND=':'",
          script,
          script,
          "trap - DEBUG",
          'printf "PROMPT_LINE=%s\\n" "$PROMPT_COMMAND"',
          "false",
          'eval "$PROMPT_COMMAND"',
        ].join("\n"),
        encoding: "utf8",
      });

      assertEqual(
        result.status,
        1,
        `the completed prompt hook should return the preserved failing status: ${result.stderr}`,
      );
      assertCondition(
        result.stdout.includes(`PROMPT_LINE=${beginHook}; :; ${endHook}`),
        "repeated injection must retain exactly one begin/end hook pair",
      );
      assertCondition(
        result.stdout.includes(";ec=1;"),
        "the first prompt hook must preserve false's exit status across reinjection",
      );
    },
  );

  await runCase(
    "SSH command shell detection is independent from the remote host OS",
    async () => {
      const backend = new SSHBackend() as any;
      const unixPowerShell = createSession();
      unixPowerShell.remoteOs = "unix";
      unixPowerShell.commandProtocolToken =
        "0123456789abcdef0123456789abcdef";
      backend.execCollect = async (_client: unknown, command: string) => ({
        stdout: command.includes("$PSVersionTable")
          ? "__GYSHELL_SHELL_POWERSHELL__0123456789abcdef0123456789abcdef"
          : "",
        stderr: "",
      });

      assertEqual(
        await backend.detectCommandShellFamily(unixPowerShell),
        "powershell",
        "a Unix host with a pwsh login shell must select PowerShell lifecycle semantics",
      );
      assertEqual(
        unixPowerShell.powerShellExecutable,
        "pwsh",
        "Unix-hosted PowerShell must launch through pwsh",
      );
      assertEqual(
        unixPowerShell.remoteOs,
        "unix",
        "shell detection must not alter Unix filesystem semantics",
      );

      const windowsBash = createSession();
      windowsBash.remoteOs = "windows";
      windowsBash.commandProtocolToken =
        "fedcba9876543210fedcba9876543210";
      backend.execCollect = async (_client: unknown, command: string) => ({
        stdout: command.includes("BASH_VERSION")
          ? "__GYSHELL_SHELL_UNIX__fedcba9876543210fedcba9876543210"
          : "",
        stderr: "",
      });
      assertEqual(
        await backend.detectCommandShellFamily(windowsBash),
        "unix",
        "a Windows host with a Bash login shell must select Unix lifecycle semantics",
      );
      assertEqual(
        windowsBash.remoteOs,
        "windows",
        "Unix shell detection must not alter Windows filesystem semantics",
      );
    },
  );

  await runCase(
    "Unix-hosted pwsh receives a Unix-path PowerShell sidecar",
    async () => {
      const backend = new SSHBackend() as any;
      const session = createSession();
      session.remoteOs = "unix";
      session.commandShellFamily = "powershell";
      session.powerShellExecutable = "pwsh";
      session.commandProtocolToken =
        "1234567890abcdef1234567890abcdef";
      session.sftp = {};
      const invocations: string[] = [];
      backend.execCollect = async (_client: unknown, command: string) => {
        invocations.push(command);
        return invocations.length === 1
          ? {
              stdout: JSON.stringify({
                Version: "6.8.0",
                TempPath: "/tmp/",
                Arch: "x64",
                PSVersionMajor: 7,
              }),
              stderr: "",
            }
          : { stdout: "", stderr: "" };
      };
      backend.cleanupStaleWindowsPromptMarkers = async () => {};
      backend.initializeSftp = async () => session.sftp;
      let uploadedPath = "";
      backend.sftpWriteFile = async (
        _sftp: unknown,
        remotePath: string,
        _data: Buffer,
      ) => {
        uploadedPath = remotePath;
      };

      await backend.bootstrapWindowsSession(session);

      assertEqual(
        session.commandTrackingMode,
        "windows-powershell-sidecar",
        "Unix pwsh should use the same exact sidecar lifecycle as Windows PowerShell",
      );
      assertCondition(
        session.windowsPromptMarkerPath.startsWith("/tmp/GyShell/") &&
          session.windowsCommandRequestPath.startsWith("/tmp/GyShell/") &&
          session.windowsCommandOutputPath.startsWith("/tmp/GyShell/") &&
          uploadedPath.startsWith("/tmp/GyShell/"),
        "Unix pwsh sidecar paths must retain Unix separators",
      );
      assertCondition(
        invocations.every((command) => command.startsWith("pwsh ")),
        "every remote PowerShell helper must use pwsh on a Unix host",
      );
      const launchCommand = backend.buildWindowsPowerShellLaunchCommand(
        session,
      ) as string;
      const loaderEncoded = launchCommand.split("-EncodedCommand ")[1] || "";
      const loader = Buffer.from(loaderEncoded, "base64").toString("utf16le");
      const encodedBootstrapPath =
        loader.match(/FromBase64String\('([^']+)'\)/)?.[1] || "";
      const decodedBootstrapPath = Buffer.from(
        encodedBootstrapPath,
        "base64",
      ).toString("utf8");
      assertCondition(
        launchCommand.startsWith("pwsh ") &&
          !launchCommand.includes("-ExecutionPolicy") &&
          decodedBootstrapPath.startsWith("/tmp/GyShell/prompt-markers/") &&
          !decodedBootstrapPath.includes("\\tmp\\GyShell"),
        "interactive Unix pwsh bootstrap must use pwsh and a native Unix path",
      );
    },
  );

  await runCase(
    "windows powershell prefers sidecar tracking whenever its private channel is available and falls back safely",
    async () => {
      const backend = new SSHBackend();

      const sidecarSession = createSession();
      sidecarSession.sftp = {} as any;
      sidecarSession.sshConfig = { id: "ssh-2016" } as any;
      sidecarSession.systemInfo = { shell: "powershell.exe" };
      sidecarSession.windowsBuildNumber = 14393;
      assertEqual(
        (backend as any).shouldUseWindowsPowerShellSidecar(sidecarSession),
        true,
        "downlevel Windows PowerShell should opt into the sidecar route",
      );
      sidecarSession.commandTrackingMode = "windows-powershell-sidecar";
      sidecarSession.windowsPromptMarkerPath = "C:/Temp/prompt.log";
      sidecarSession.windowsCommandRequestPath = "C:/Temp/request.b64";
      sidecarSession.windowsCommandOutputPath = "C:/Temp/output.txt";
      sidecarSession.windowsPowerShellBootstrapPath = "C:/Temp/bootstrap.ps1";
      assertEqual(
        (backend as any).hasReliableWindowsCommandProtocol(sidecarSession),
        true,
        "sidecar mode should advertise exec_command only after every private channel exists",
      );

      const modernSession = createSession();
      modernSession.sftp = {} as any;
      modernSession.sshConfig = { id: "ssh-2022" } as any;
      modernSession.systemInfo = { shell: "powershell.exe" };
      modernSession.windowsBuildNumber = 17763;
      assertEqual(
        (backend as any).shouldUseWindowsPowerShellSidecar(modernSession),
        true,
        "modern Windows PowerShell should prefer exact sidecar capture when SFTP is available",
      );
      modernSession.commandTrackingMode = "windows-powershell-sidecar";
      modernSession.windowsPromptMarkerPath = "C:/Temp/modern-prompt.log";
      modernSession.windowsCommandRequestPath = "C:/Temp/modern-request.b64";
      modernSession.windowsCommandOutputPath = "C:/Temp/modern-output.txt";
      modernSession.windowsPowerShellBootstrapPath = "C:/Temp/modern-bootstrap.ps1";
      assertEqual(
        (backend as any).hasReliableWindowsCommandProtocol(modernSession),
        true,
        "modern sidecar mode should be command-capable after all private paths are installed",
      );

      const modernFallbackSession = createSession();
      modernFallbackSession.systemInfo = { shell: "powershell.exe" };
      modernFallbackSession.windowsBuildNumber = 17763;
      modernFallbackSession.sftpInitError = "unavailable";
      modernFallbackSession.commandTrackingMode = "shell-integration";
      assertEqual(
        (backend as any).shouldUseWindowsPowerShellSidecar(modernFallbackSession),
        false,
        "a missing private channel should select the in-band fallback",
      );
      assertEqual(
        (backend as any).hasReliableWindowsCommandProtocol(modernFallbackSession),
        true,
        "a known modern build should retain the existing in-band command fallback",
      );

      const noSftpSession = createSession();
      noSftpSession.systemInfo = { shell: "powershell.exe" };
      noSftpSession.windowsBuildNumber = 14393;
      noSftpSession.sftpInitError = "unavailable";
      noSftpSession.commandTrackingMode = "shell-integration";
      assertEqual(
        (backend as any).shouldUseWindowsPowerShellSidecar(noSftpSession),
        false,
        "the sidecar route should stay disabled when the hidden marker channel is unavailable",
      );
      assertEqual(
        (backend as any).hasReliableWindowsCommandProtocol(noSftpSession),
        false,
        "downlevel Windows without SFTP must fail closed instead of advertising shell integration",
      );

      const unknownBuildSession = createSession();
      unknownBuildSession.sftp = {} as any;
      unknownBuildSession.commandTrackingMode = "windows-powershell-sidecar";
      unknownBuildSession.windowsPromptMarkerPath = "C:/Temp/unknown-prompt.log";
      unknownBuildSession.windowsCommandRequestPath = "C:/Temp/unknown-request.b64";
      unknownBuildSession.windowsCommandOutputPath = "C:/Temp/unknown-output.txt";
      unknownBuildSession.windowsPowerShellBootstrapPath = "C:/Temp/unknown-bootstrap.ps1";
      assertEqual(
        (backend as any).hasReliableWindowsCommandProtocol(unknownBuildSession),
        true,
        "a fully installed sidecar protocol should not depend on OS build detection",
      );
      unknownBuildSession.commandTrackingMode = "shell-integration";
      assertEqual(
        (backend as any).hasReliableWindowsCommandProtocol(unknownBuildSession),
        false,
        "unknown Windows builds must not assume that the in-band fallback is available",
      );
    },
  );

  await runCase(
    "reconnected SSH runtimes receive distinct Windows sidecar paths",
    async () => {
      const backend = new SSHBackend() as any;
      backend.execCollect = async () => ({
        stdout: JSON.stringify({
          Version: "10.0.14393.0",
          TempPath: "C:/Windows/Temp",
          Arch: "x64",
          CSName: "host",
        }),
        stderr: "",
      });
      backend.cleanupStaleWindowsPromptMarkers = async () => {};
      backend.initializeSftp = async () => ({});
      const uploaded = new Map<string, Buffer>();
      backend.sftpWriteFile = async (_sftp: unknown, remotePath: string, data: Buffer) => {
        uploaded.set(remotePath, data);
      };
      const first = createSession();
      const second = createSession();
      first.sshConfig = second.sshConfig = { id: "stable-public-id" } as any;
      first.commandProtocolToken = "0123456789abcdef0123456789abcdef";
      second.commandProtocolToken = "fedcba9876543210fedcba9876543210";

      await backend.bootstrapWindowsSession(first);
      await backend.bootstrapWindowsSession(second);

      assertCondition(
        first.windowsCommandRequestPath.includes(first.commandProtocolToken) &&
          second.windowsCommandRequestPath.includes(second.commandProtocolToken),
        "each request path should be scoped by the random runtime protocol token",
      );
      assertCondition(
        first.windowsCommandRequestPath !== second.windowsCommandRequestPath &&
          first.windowsPromptMarkerPath !== second.windowsPromptMarkerPath &&
          first.windowsCommandOutputPath !== second.windowsCommandOutputPath &&
          first.windowsPowerShellBootstrapPath !==
            second.windowsPowerShellBootstrapPath,
        "a reconnect must never reuse marker, request, output, or bootstrap files from the abandoned runtime",
      );
      const firstBootstrap = uploaded.get(first.windowsPowerShellBootstrapPath);
      assertCondition(
        firstBootstrap?.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) &&
          firstBootstrap
            .subarray(3)
            .toString("utf8")
            .includes(`gyshell_${first.commandProtocolToken}_preexec`),
        "bootstrap should be uploaded as BOM-tagged UTF-8 and scoped to the runtime token",
      );
      const launchCommand = backend.buildWindowsPowerShellLaunchCommand(first) as string;
      const loaderEncoded = launchCommand.split("-EncodedCommand ")[1] || "";
      const loader = Buffer.from(loaderEncoded, "base64").toString("utf16le");
      assertCondition(
        launchCommand.length < 8_191 &&
          launchCommand.includes("-ExecutionPolicy Bypass") &&
          loader.includes("[Convert]::FromBase64String") &&
          loader.includes(". $__gyshell_bootstrap_path") &&
          !loader.includes("Out-String -Stream"),
        "SSH startup should pass cmd.exe a short path loader, never the full sidecar program",
      );
    },
  );

  await runCase(
    "prepareCommandTracking rejects cached marker state when the live read and reset both fail",
    async () => {
      const backend = new SSHBackend() as any;
      const session = createSession();
      session.commandTrackingMode = "windows-powershell-sidecar";
      session.windowsPromptMarkerState = { sequence: 7, exitCode: 0 };
      session.windowsCommandRequestPath =
        "C:/Windows/Temp/GyShell/prompt-markers/exec-request.b64";
      backend.sessions.set("pty-prepare-fallback", session);
      backend.refreshWindowsPromptMarkerState = async () => {
        throw new Error("temporary sftp failure");
      };
      backend.resetWindowsPromptMarker = async () => false;

      const outcome = await Promise.allSettled([
        backend.prepareCommandTracking("pty-prepare-fallback"),
      ]);

      assertEqual(
        outcome[0]?.status,
        "rejected",
        "cached state must never authorize dispatch when no live baseline can be established",
      );
    },
  );

  await runCase(
    "prepareCommandTracking resets an unreadable marker before using sequence zero",
    async () => {
      const backend = new SSHBackend() as any;
      const session = createSession();
      session.commandTrackingMode = "windows-powershell-sidecar";
      session.windowsCommandRequestPath =
        "C:/Windows/Temp/GyShell/prompt-markers/exec-request.b64";
      session.windowsCommandOutputPath =
        "C:/Windows/Temp/GyShell/prompt-markers/exec-output.txt";
      backend.sessions.set("pty-await-fresh", session);
      backend.refreshWindowsPromptMarkerState = async () => {
        throw new Error("temporary sftp failure");
      };
      backend.resetWindowsPromptMarker = async () => true;

      const token = await backend.prepareCommandTracking("pty-await-fresh");

      assertEqual(
        token?.baselineSequence,
        0,
        "missing marker baselines should start from sequence zero",
      );
      assertEqual(
        token?.awaitingInitialFreshMarker,
        undefined,
        "a successful reset should not need a cross-machine wall-clock freshness mode",
      );
      assertEqual(
        token?.dispatchMode,
        "prompt-file",
        "sidecar SSH tokens should opt into prompt-file dispatch",
      );
      assertEqual(
        token?.displayMode,
        "synthetic-transcript",
        "downlevel SSH prompt-file dispatch should opt into synthetic transcript rendering",
      );
      assertEqual(
        token?.commandOutputPath,
        session.windowsCommandOutputPath,
        "downlevel SSH prompt-file dispatch should carry the hidden output file path",
      );
    },
  );

  await runCase(
    "prepareCommandTracking bounds a readable SSH marker journal after taking its baseline",
    async () => {
      const backend = new SSHBackend() as any;
      const session = createSession();
      session.commandTrackingMode = "windows-powershell-sidecar";
      session.windowsCommandRequestPath =
        "C:/Windows/Temp/GyShell/prompt-markers/request.b64";
      backend.sessions.set("pty-readable-journal", session);
      backend.refreshWindowsPromptMarkerState = async () => ({
        sequence: 7,
        exitCode: 0,
      });
      let resetCount = 0;
      backend.resetWindowsPromptMarker = async () => {
        resetCount += 1;
        return true;
      };

      const token = await backend.prepareCommandTracking("pty-readable-journal");

      assertEqual(token?.baselineSequence, 7, "preparation should keep the live monotonic sequence");
      assertEqual(resetCount, 1, "every command should truncate the append-only journal after reading it");
    },
  );

  await runCase(
    "prepareCommandTracking clears the remote marker file when no baseline could be read",
    async () => {
      const backend = new SSHBackend() as any;
      const session = createSession();
      session.commandTrackingMode = "windows-powershell-sidecar";
      session.windowsPromptMarkerPath =
        "C:/Windows/Temp/GyShell/prompt-markers/gyshell-prompt-ssh-reset.log";
      backend.sessions.set("pty-reset-marker", session);
      backend.refreshWindowsPromptMarkerState = async () => null;
      backend.resetWindowsPromptMarker = async (current: unknown) => {
        assertEqual(
          current,
          session,
          "prepare should reset the marker file on the active SSH session",
        );
        return true;
      };

      const token = await backend.prepareCommandTracking("pty-reset-marker");

      assertEqual(
        token?.baselineSequence,
        0,
        "marker resets should restart the sequence baseline",
      );
      assertEqual(
        token?.awaitingInitialFreshMarker,
        undefined,
        "successful marker resets should avoid the legacy fresh-marker wait path",
      );
    },
  );

  await runCase(
    "pollCommandTracking falls back to exec-based marker reads when SFTP marker reads fail",
    async () => {
      const backend = new SSHBackend() as any;
      const session = createSession();
      session.client = {};
      session.commandTrackingMode = "windows-powershell-sidecar";
      session.windowsCommandOutputPath =
        "C:/Windows/Temp/GyShell/prompt-markers/exec-output.txt";
      backend.sessions.set("pty-poll-fallback", session);
      backend.readWindowsPromptMarkerState = async () => {
        throw Object.assign(new Error("sftp channel reset"), { code: "EIO" });
      };
      backend.readWindowsPromptMarkerStateViaExec = async () => ({
        sequence: 5,
        exitCode: 0,
        outputObservedUtf8Bytes: 33554432,
        outputRetainedUtf8Bytes: 17,
        outputTruncated: true,
        cwd: "C:/Windows",
        homeDir: "C:/Users/Administrator",
      });
      backend.readWindowsCommandOutputViaExec = async () =>
        ({
          text: "fallback-output\r\n",
          observedUtf8Bytes: 17,
          truncated: false,
        });

      const update = await backend.pollCommandTracking("pty-poll-fallback", {
        mode: "windows-powershell-sidecar",
        baselineSequence: 4,
        commandOutputPath: session.windowsCommandOutputPath,
      });

      assertEqual(
        update?.sequence,
        5,
        "poll should still complete through the exec fallback path",
      );
      assertEqual(
        update?.cwd,
        "C:/Windows",
        "poll fallback should preserve cwd updates",
      );
      assertEqual(
        update?.output,
        "fallback-output\r\n",
        "poll fallback should also recover the hidden rendered output",
      );
      assertEqual(
        update?.outputObservedUtf8Bytes,
        33554432,
        "poll fallback should prefer the generator-observed byte count over the retained file size",
      );
      assertEqual(
        update?.outputTruncated,
        true,
        "poll fallback should propagate generator-side truncation",
      );
    },
  );

  await runCase(
    "large Windows sidecar output is read through a bounded concurrent SFTP pipeline",
    async () => {
      const backend = new SSHBackend() as any;
      const session = createSession();
      const source = Buffer.from("0123456789abcdef".repeat(40_000), "utf8");
      let activeReads = 0;
      let maxActiveReads = 0;
      backend.initializeSftp = async () => ({});
      backend.sftpStat = async () => ({ size: source.length });
      backend.sftpOpen = async () => Buffer.from("handle");
      backend.sftpClose = async () => {};
      backend.sftpReadDirect = async (
        _sftp: unknown,
        _handle: Buffer,
        target: Buffer,
        targetOffset: number,
        length: number,
        position: number,
      ) => {
        activeReads += 1;
        maxActiveReads = Math.max(maxActiveReads, activeReads);
        await Promise.resolve();
        const bytesRead = Math.max(
          0,
          Math.min(length, source.length - position),
        );
        if (bytesRead > 0) {
          source.copy(
            target,
            targetOffset,
            position,
            position + bytesRead,
          );
        }
        activeReads -= 1;
        return bytesRead;
      };

      const output = await backend.readWindowsCommandOutput(
        session,
        "C:/Windows/Temp/GyShell/output.txt",
      );

      assertEqual(
        output?.text,
        source.toString("utf8"),
        "concurrent ranges must reassemble in file order without gaps",
      );
      assertEqual(
        output?.observedUtf8Bytes,
        source.length,
        "concurrent output reads should preserve the exact remote byte count",
      );
      assertCondition(
        maxActiveReads > 1 && maxActiveReads <= 16,
        "large reads should pipeline several bounded requests without unbounded concurrency",
      );
    },
  );

  await runCase(
    "failed concurrent SFTP reads settle before their shared handle is closed",
    async () => {
      const backend = new SSHBackend() as any;
      const sourceLength = 2 * 1024 * 1024;
      let activeReads = 0;
      let startedReads = 0;
      let closeActiveReads = -1;
      let releasePendingReads: (() => void) | undefined;
      let reportAllStarted: (() => void) | undefined;
      const pendingReadsReleased = new Promise<void>((resolve) => {
        releasePendingReads = resolve;
      });
      const allStarted = new Promise<void>((resolve) => {
        reportAllStarted = resolve;
      });

      backend.initializeSftp = async () => ({});
      backend.sftpStat = async () => ({ size: sourceLength });
      backend.sftpOpen = async () => Buffer.from("handle");
      backend.sftpClose = async () => {
        closeActiveReads = activeReads;
      };
      backend.sftpReadDirect = async (
        _sftp: unknown,
        _handle: Buffer,
        target: Buffer,
        targetOffset: number,
        length: number,
        position: number,
      ) => {
        activeReads += 1;
        startedReads += 1;
        if (startedReads === 16) {
          reportAllStarted?.();
        }
        await allStarted;
        if (position === 0) {
          setTimeout(() => releasePendingReads?.(), 20);
          activeReads -= 1;
          throw new Error("synthetic SFTP read failure");
        }
        await pendingReadsReleased;
        target.fill(0x52, targetOffset, targetOffset + length);
        activeReads -= 1;
        return length;
      };

      const outcome = await Promise.allSettled([
        backend.readWindowsCommandOutput(
          createSession(),
          "C:/Windows/Temp/GyShell/output.txt",
        ),
      ]);

      assertEqual(
        outcome[0]?.status,
        "rejected",
        "the original SFTP read failure must propagate",
      );
      assertEqual(
        closeActiveReads,
        0,
        "the shared handle must remain open until every in-flight range has settled",
      );
    },
  );

  await runCase(
    "a short SFTP prefix read fails before completion can be consumed",
    async () => {
      const backend = new SSHBackend() as any;
      let readCount = 0;
      let closeCount = 0;
      backend.initializeSftp = async () => ({});
      backend.sftpStat = async () => ({ size: 128 });
      backend.sftpOpen = async () => Buffer.from("handle");
      backend.sftpClose = async () => {
        closeCount += 1;
      };
      backend.sftpReadDirect = async (
        _sftp: unknown,
        _handle: Buffer,
        target: Buffer,
        targetOffset: number,
        length: number,
      ) => {
        readCount += 1;
        if (readCount > 1) return 0;
        const bytesRead = Math.min(64, length);
        target.fill(0x53, targetOffset, targetOffset + bytesRead);
        return bytesRead;
      };

      const outcome = await Promise.allSettled([
        backend.readWindowsCommandOutput(
          createSession(),
          "C:/Windows/Temp/GyShell/output.txt",
        ),
      ]);
      assertEqual(
        outcome[0]?.status,
        "rejected",
        "stat-length output must never be accepted after an early EOF",
      );
      assertEqual(closeCount, 1, "the failed short-read handle should still close once");
    },
  );

  await runCase(
    "a leading U+FEFF remains verified Windows sidecar output",
    async () => {
      const backend = new SSHBackend() as any;
      const source = Buffer.from("\ufeffVISIBLE", "utf8");
      backend.initializeSftp = async () => ({});
      backend.sftpStat = async () => ({ size: source.length });
      backend.sftpOpen = async () => Buffer.from("handle");
      backend.sftpClose = async () => {};
      backend.sftpReadDirect = async (
        _sftp: unknown,
        _handle: Buffer,
        target: Buffer,
        targetOffset: number,
        length: number,
        position: number,
      ) => {
        const bytesRead = Math.min(length, source.length - position);
        source.copy(target, targetOffset, position, position + bytesRead);
        return bytesRead;
      };

      const output = await backend.readWindowsCommandOutput(
        createSession(),
        "C:/Windows/Temp/GyShell/output.txt",
      );
      assertEqual(output?.text, "\ufeffVISIBLE", "U+FEFF must not be stripped as a BOM");
      assertEqual(
        output?.observedUtf8Bytes,
        source.length,
        "U+FEFF must remain in sidecar byte accounting",
      );
    },
  );

  await runCase(
    "exec-based Windows sidecar reads propagate bounded-output metadata",
    async () => {
      const backend = new SSHBackend() as any;
      const session = createSession();
      let decodedScript = "";
      backend.execCollect = async (_client: unknown, command: string) => {
        const encoded = command.split(" ").at(-1) || "";
        decodedScript = Buffer.from(encoded, "base64").toString("utf16le");
        return {
          stdout: "😀",
          stderr:
            "__GYSHELL_OUTPUT_BYTES__=4\r\n__GYSHELL_OUTPUT_READ__=4\r\n",
        };
      };

      const output = await backend.readWindowsCommandOutputViaExec(
        session,
        "C:/Windows/Temp/GyShell/output.txt",
      );

      assertEqual(output?.text, "😀", "exec fallback should preserve Unicode output");
      assertEqual(
        output?.observedUtf8Bytes,
        4,
        "exec fallback should preserve the remote file byte count",
      );
      assertEqual(
        output?.truncated,
        false,
        "an exactly read remote file must not be reported as truncated",
      );
      assertCondition(
        decodedScript.includes(String(COMMAND_CAPTURE_MAX_UTF8_BYTES + 6)),
        "the remote PowerShell fallback must bound its file read before emitting stdout",
      );
      assertCondition(
        decodedScript.includes("__GYSHELL_OUTPUT_READ__") &&
          !decodedScript.includes("ReadAllText"),
        "the bounded fallback must not load the whole sidecar file into memory",
      );

      backend.execCollect = async () => ({
        stdout: "\ufeffVISIBLE",
        stderr:
          "__GYSHELL_OUTPUT_BYTES__=10\r\n__GYSHELL_OUTPUT_READ__=10\r\n",
      });
      const leadingOutput = await backend.readWindowsCommandOutputViaExec(
        session,
        "C:/Windows/Temp/GyShell/output.txt",
      );
      assertEqual(
        leadingOutput?.text,
        "\ufeffVISIBLE",
        "the exec fallback must preserve a leading U+FEFF as transcript data",
      );

      backend.execCollect = async () => ({
        stdout: "short",
        stderr:
          "__GYSHELL_OUTPUT_BYTES__=8\r\n__GYSHELL_OUTPUT_READ__=8\r\n",
      });
      const shortOutput = await backend.readWindowsCommandOutputViaExec(
        session,
        "C:/Windows/Temp/GyShell/output.txt",
      );
      assertEqual(
        shortOutput,
        undefined,
        "the exec fallback must reject a stdout payload shorter than its authenticated read count",
      );
    },
  );

  await runCase(
    "exec-based SSH marker reads use the durable request-specific completion file",
    async () => {
      const backend = new SSHBackend() as any;
      const session = createSession();
      session.windowsPromptMarkerPath =
        "C:/Windows/Temp/GyShell/prompt-markers/prompt.log";
      const cwdB64 = Buffer.from("C:/Windows", "utf8").toString("base64");
      const homeB64 = Buffer.from("C:/Users/Admin", "utf8").toString("base64");
      const expectedRequestId = "0123456789abcdef0123456789abcdef";
      let decodedScript = "";
      backend.execCollect = async (_client: unknown, command: string) => {
        decodedScript = Buffer.from(command.split(" ").at(-1) || "", "base64").toString("utf16le");
        return {
          stdout: `__GYSHELL_PROMPT__::seq=8;ec=9;request_id=${expectedRequestId};output_bytes=5;retained_bytes=5;output_truncated=0;cwd_b64=${cwdB64};home_b64=${homeB64}`,
          stderr: "",
        };
      };

      const marker = await backend.readWindowsPromptMarkerStateViaExec(
        session,
        expectedRequestId,
      );

      assertEqual(marker?.sequence, 8, "the matching completion should survive a later no-request prompt");
      assertEqual(marker?.requestId, expectedRequestId, "exec fallback must filter by expected request identity");
      assertEqual(marker?.outputRetainedUtf8Bytes, 5, "journal parsing should preserve retained byte metadata");
      assertCondition(
        decodedScript.includes(`prompt.log.${expectedRequestId}`) &&
          decodedScript.includes("ReadAllText") &&
          decodedScript.includes("__GYSHELL_REQUEST_MARKER_EXISTS__=1") &&
          !decodedScript.includes("-Tail 128") &&
          !decodedScript.includes("ToUnixTimeMilliseconds"),
        "request polling should read its immutable commit file without tail eviction or new .NET APIs",
      );
    },
  );

  await runCase(
    "exec-based request polling distinguishes a missing commit from a corrupt empty commit",
    async () => {
      const backend = new SSHBackend() as any;
      const session = createSession();
      session.windowsPromptMarkerPath =
        "C:/Windows/Temp/GyShell/prompt-markers/prompt.log";
      const requestId = "3123456789abcdef3123456789abcdef";
      backend.execCollect = async () => ({ stdout: "", stderr: "" });

      const missing = await backend.readWindowsPromptMarkerStateViaExec(
        session,
        requestId,
      );
      assertEqual(missing, null, "an absent exact marker should remain a normal pending poll");

      backend.execCollect = async () => ({
        stdout: "",
        stderr: "__GYSHELL_REQUEST_MARKER_EXISTS__=1\r\n",
      });
      const corrupt = await Promise.allSettled([
        backend.readWindowsPromptMarkerStateViaExec(session, requestId),
      ]);
      assertEqual(
        corrupt[0]?.status,
        "rejected",
        "an atomically committed but empty marker must fail closed",
      );
    },
  );

  await runCase(
    "SFTP request polling reads an immutable completion file instead of a bounded journal tail",
    async () => {
      const backend = new SSHBackend() as any;
      const session = createSession();
      const expectedRequestId = "1123456789abcdef1123456789abcdef";
      const cwdB64 = Buffer.from("C:/Windows", "utf8").toString("base64");
      const homeB64 = Buffer.from("C:/Users/Admin", "utf8").toString("base64");
      const markerText = `__GYSHELL_PROMPT__::seq=41;ec=0;request_id=${expectedRequestId};output_bytes=0;retained_bytes=0;output_truncated=0;cwd_b64=${cwdB64};home_b64=${homeB64}\n`;
      session.windowsPromptMarkerPath =
        "C:/Windows/Temp/GyShell/prompt-markers/prompt.log";
      session.sftp = {};
      let statPath = "";
      let openPath = "";
      backend.initializeSftp = async () => session.sftp;
      backend.sftpStat = async (_sftp: unknown, targetPath: string) => {
        statPath = targetPath;
        return { size: Buffer.byteLength(markerText), mtime: 1 };
      };
      backend.sftpOpen = async (_sftp: unknown, targetPath: string) => {
        openPath = targetPath;
        return Buffer.from("handle");
      };
      backend.sftpReadDirect = async (
        _sftp: unknown,
        _handle: Buffer,
        buffer: Buffer,
      ) => {
        const source = Buffer.from(markerText, "utf8");
        source.copy(buffer);
        return source.length;
      };
      backend.sftpClose = async () => {};

      const marker = await backend.readWindowsPromptMarkerState(
        session,
        expectedRequestId,
      );
      const expectedPath = `${session.windowsPromptMarkerPath}.${expectedRequestId}`;

      assertEqual(marker?.sequence, 41, "the request-specific SFTP marker should complete normally");
      assertEqual(statPath, expectedPath, "SFTP stat must target the durable request commit file");
      assertEqual(openPath, expectedPath, "SFTP read must never fall back to the shared journal tail");
    },
  );

  await runCase(
    "SFTP request polling rejects an oversized immutable completion marker",
    async () => {
      const backend = new SSHBackend() as any;
      const session = createSession();
      const requestId = "4123456789abcdef4123456789abcdef";
      session.windowsPromptMarkerPath =
        "C:/Windows/Temp/GyShell/prompt-markers/prompt.log";
      session.sftp = {};
      backend.initializeSftp = async () => session.sftp;
      backend.sftpStat = async () => ({ size: 16 * 1024 + 1, mtime: 1 });

      const outcome = await Promise.allSettled([
        backend.readWindowsPromptMarkerState(session, requestId),
      ]);
      assertEqual(
        outcome[0]?.status,
        "rejected",
        "a request commit larger than the protocol limit must not be tail-parsed",
      );
    },
  );

  await runCase(
    "SSH sidecar polling rejects a truncated marker whose retained output is short",
    async () => {
      const backend = new SSHBackend() as any;
      const session = createSession();
      session.commandTrackingMode = "windows-powershell-sidecar";
      session.windowsCommandOutputPath =
        "C:/Windows/Temp/GyShell/prompt-markers/short-output.txt";
      backend.sessions.set("pty-short-output", session);
      backend.refreshWindowsPromptMarkerState = async () => ({
        sequence: 5,
        exitCode: 0,
        outputObservedUtf8Bytes: 100000000,
        outputRetainedUtf8Bytes: 8,
        outputTruncated: true,
      });
      backend.readWindowsCommandOutputBestEffort = async () => ({
        text: "short",
        observedUtf8Bytes: 5,
        truncated: false,
      });

      const outcome = await Promise.allSettled([
        backend.pollCommandTracking("pty-short-output", {
          mode: "windows-powershell-sidecar",
          baselineSequence: 4,
          commandOutputPath: session.windowsCommandOutputPath,
          expectCommandOutput: true,
        }),
      ]);

      assertEqual(
        outcome[0]?.status,
        "rejected",
        "generator truncation must not conceal additional loss in the retained output file",
      );
    },
  );

  await runCase(
    "SSH sidecar does not delete a completion commit before decoded output validation",
    async () => {
      const backend = new SSHBackend() as any;
      const session = createSession();
      const requestId = "7123456789abcdef7123456789abcdef";
      session.commandTrackingMode = "windows-powershell-sidecar";
      session.windowsPromptMarkerPath =
        "C:/Windows/Temp/GyShell/prompt-markers/prompt.log";
      session.windowsCommandOutputPath =
        "C:/Windows/Temp/GyShell/prompt-markers/short-output.txt";
      backend.sessions.set("pty-short-decoded-output", session);
      backend.refreshWindowsPromptMarkerState = async () => ({
        sequence: 5,
        exitCode: 0,
        requestId,
        outputObservedUtf8Bytes: 8,
        outputRetainedUtf8Bytes: 8,
        outputTruncated: false,
      });
      let outputReadCount = 0;
      backend.readWindowsCommandOutputBestEffort = async () => {
        outputReadCount += 1;
        return {
          text: outputReadCount === 1 ? "short" : "12345678",
          observedUtf8Bytes: 8,
          truncated: false,
        };
      };
      let unlinkCount = 0;
      backend.initializeSftp = async () => ({});
      backend.sftpUnlink = async () => {
        unlinkCount += 1;
      };

      const token = {
        mode: "windows-powershell-sidecar",
        baselineSequence: 4,
        expectedRequestId: requestId,
        commandOutputPath: session.windowsCommandOutputPath,
        expectCommandOutput: true,
      } as const;
      const outcome = await Promise.allSettled([
        backend.pollCommandTracking("pty-short-decoded-output", token),
      ]);
      assertEqual(
        outcome[0]?.status,
        "rejected",
        "decoded output loss must fail inside the backend validation boundary",
      );
      assertEqual(
        unlinkCount,
        0,
        "a retryable completion commit must survive until output is fully validated",
      );
      const recovered = await backend.pollCommandTracking(
        "pty-short-decoded-output",
        token,
      );
      assertEqual(
        recovered?.output,
        "12345678",
        "a later complete read must recover from the same immutable completion commit",
      );
      assertEqual(
        unlinkCount,
        1,
        "the completion commit should be acknowledged exactly once after full validation",
      );
    },
  );

  await runCase(
    "SSH sidecar polling rejects a completion whose owned output file is unreadable",
    async () => {
      const backend = new SSHBackend() as any;
      const session = createSession();
      session.commandTrackingMode = "windows-powershell-sidecar";
      session.windowsCommandOutputPath =
        "C:/Windows/Temp/GyShell/prompt-markers/missing-output.txt";
      backend.sessions.set("pty-missing-output", session);
      backend.refreshWindowsPromptMarkerState = async () => ({
        sequence: 5,
        exitCode: 0,
        outputObservedUtf8Bytes: 3,
        outputRetainedUtf8Bytes: 3,
        outputTruncated: false,
      });
      backend.readWindowsCommandOutputBestEffort = async () => undefined;

      const outcome = await Promise.allSettled([
        backend.pollCommandTracking("pty-missing-output", {
          mode: "windows-powershell-sidecar",
          baselineSequence: 4,
          commandOutputPath: session.windowsCommandOutputPath,
          expectCommandOutput: true,
        }),
      ]);

      assertEqual(
        outcome[0]?.status,
        "rejected",
        "an unreadable owned output file must never become a successful empty capture",
      );
    },
  );

  await runCase(
    "pollCommandTracking accepts a greater sequence despite remote and client clock skew",
    async () => {
      const backend = new SSHBackend() as any;
      const session = createSession();
      session.commandTrackingMode = "windows-powershell-sidecar";
      backend.sessions.set("pty-stale-marker", session);

      backend.refreshWindowsPromptMarkerState = async () => {
        throw new Error(
          "the legacy compatibility path should use its explicit exec read",
        );
      };
      backend.refreshWindowsPromptMarkerStateViaExec = async () => ({
        sequence: 2,
        exitCode: 0,
        cwd: "C:/Windows",
        homeDir: "C:/Users/Administrator",
        modifiedAtMs: 1000,
      });

      const token = {
        mode: "windows-powershell-sidecar",
        baselineSequence: 1,
        awaitingInitialFreshMarker: true,
        dispatchedAtMs: 9000000000000,
      } as any;

      const fresh = await backend.pollCommandTracking(
        "pty-stale-marker",
        token,
      );

      assertEqual(
        fresh?.sequence,
        2,
        "a greater sequence should finish even when the remote mtime is far behind the client clock",
      );
    },
  );

  await runCase(
    "pollCommandTracking uses exec-based marker reads for same-second fresh-marker checks",
    async () => {
      const backend = new SSHBackend() as any;
      const session = createSession();
      session.commandTrackingMode = "windows-powershell-sidecar";
      backend.sessions.set("pty-highres-marker", session);
      backend.refreshWindowsPromptMarkerState = async () => {
        throw new Error(
          "same-second freshness checks should bypass the sftp marker path",
        );
      };
      backend.refreshWindowsPromptMarkerStateViaExec = async () => ({
        sequence: 3,
        exitCode: 0,
        cwd: "C:/Windows",
        homeDir: "C:/Users/Administrator",
        modifiedAtMs: 2500,
      });

      const token = {
        mode: "windows-powershell-sidecar",
        baselineSequence: 0,
        awaitingInitialFreshMarker: true,
        dispatchedAtMs: 2000,
      } as any;

      const update = await backend.pollCommandTracking(
        "pty-highres-marker",
        token,
      );

      assertEqual(
        update?.sequence,
        3,
        "exec-based marker reads should accept fresh same-second completions",
      );
      assertEqual(
        token.awaitingInitialFreshMarker,
        false,
        "fresh exec-based markers should clear the wait flag",
      );
    },
  );

  await runCase(
    "windows marker cleanup removes the current temp file and clears cached tracking state",
    async () => {
      const backend = new SSHBackend() as any;
      const removedPaths: string[] = [];
      const removedDirs: string[] = [];
      const session = createSession();
      session.sftp = {} as any;
      session.windowsPromptMarkerPath =
        "C:/Windows/Temp/GyShell/prompt-markers/gyshell-prompt-ssh-clean.log";
      session.windowsCommandOutputPath =
        "C:/Windows/Temp/GyShell/prompt-markers/gyshell-output-ssh-clean.txt";
      session.windowsPromptMarkerState = { sequence: 4, exitCode: 0 };

      backend.sftpUnlink = async (_sftp: unknown, normalizedPath: string) => {
        removedPaths.push(normalizedPath);
      };
      backend.sftpRmdir = async (_sftp: unknown, normalizedPath: string) => {
        removedDirs.push(normalizedPath);
      };

      await backend.cleanupWindowsPromptMarker(session);

      assertEqual(
        removedPaths[0],
        "C:/Windows/Temp/GyShell/prompt-markers/gyshell-prompt-ssh-clean.log",
        "cleanup should unlink the current marker file from the temp marker directory",
      );
      assertEqual(
        removedPaths[1],
        "C:/Windows/Temp/GyShell/prompt-markers/gyshell-output-ssh-clean.txt",
        "cleanup should unlink the hidden output file from the temp marker directory",
      );
      assertEqual(
        removedDirs[0],
        "C:/Windows/Temp/GyShell/prompt-markers",
        "cleanup should try to remove the prompt-marker temp directory when it becomes empty",
      );
      assertEqual(
        removedDirs[1],
        "C:/Windows/Temp/GyShell",
        "cleanup should also try to prune the parent GyShell temp directory when empty",
      );
      assertEqual(
        session.windowsPromptMarkerPath,
        undefined,
        "cleanup should clear the marker path from the session",
      );
      assertEqual(
        session.windowsCommandOutputPath,
        undefined,
        "cleanup should clear the output path from the session",
      );
      assertEqual(
        session.windowsPromptMarkerState,
        undefined,
        "cleanup should clear cached marker state",
      );
    },
  );

  await runCase(
    "PowerShell bootstrap waits longer before retrying on every host OS",
    async () => {
      const backend = new SSHBackend() as any;
      assertEqual(
        backend.getShellInitRetryIntervalMs("powershell"),
        20000,
        "PowerShell bootstrap should tolerate slow startup before retrying",
      );
      assertEqual(
        backend.getShellInitRetryIntervalMs("unix"),
        8000,
        "unix bootstrap should keep the existing faster retry cadence",
      );
    },
  );

  await runCase(
    "resize requests before SSH shell stream opens are cached and applied on attach",
    async () => {
      const backend = new SSHBackend() as any;
      const session = createSession();
      const windowCalls: Array<{
        rows: number;
        cols: number;
        height: number;
        width: number;
      }> = [];
      (backend as any).sessions.set("pty-window-race", session);

      backend.resize("pty-window-race", 132.9, 43.8);
      assertEqual(
        session.requestedCols,
        132,
        "pending SSH resize should store normalized cols",
      );
      assertEqual(
        session.requestedRows,
        43,
        "pending SSH resize should store normalized rows",
      );

      session.stream = {
        setWindow: (
          rows: number,
          cols: number,
          height: number,
          width: number,
        ) => {
          windowCalls.push({ rows, cols, height, width });
        },
      };
      backend.applyRequestedWindowSize(session);

      assertEqual(
        windowCalls.length,
        1,
        "attaching the stream should apply the cached window size once",
      );
      assertEqual(
        windowCalls[0]?.rows,
        43,
        "SSH setWindow should receive the cached row count",
      );
      assertEqual(
        windowCalls[0]?.cols,
        132,
        "SSH setWindow should receive the cached column count",
      );
    },
  );

  await runCase(
    "client-level disconnect notifies exit callbacks exactly once",
    async () => {
      const backend = new SSHBackend() as any;
      const session = createSession();
      let exitCount = 0;
      let exitCode: number | undefined;
      session.client = {
        endCalls: 0,
        end() {
          this.endCalls += 1;
        },
        unforwardIn() {},
      };
      session.sftp = {
        end() {},
      };
      session.exitCallbacks.add((code: number) => {
        exitCount += 1;
        exitCode = code;
      });
      backend.sessions.set("pty-disconnect-once", session);

      backend.emitExitOnce("pty-disconnect-once", session, -1);
      backend.emitExitOnce("pty-disconnect-once", session, 0);

      assertEqual(
        exitCount,
        1,
        "disconnect fan-out should only notify subscribers once",
      );
      assertEqual(
        exitCode,
        -1,
        "the first observed disconnect code should be preserved",
      );
      assertEqual(
        backend.sessions.has("pty-disconnect-once"),
        false,
        "disconnect should remove the dead SSH runtime session",
      );
    },
  );

  await runCase(
    "a delayed old SSH close cannot delete a replacement runtime with the same public id",
    async () => {
      const backend = new SSHBackend() as any;
      const oldSession = createSession();
      const replacementSession = createSession();
      oldSession.client = { end() {}, unforwardIn() {} };
      replacementSession.client = { end() {}, unforwardIn() {} };
      backend.cleanupWindowsPromptMarker = async () => {};
      backend.sessions.set("stable-pty-id", replacementSession);

      backend.emitExitOnce("stable-pty-id", oldSession, -1);

      assertEqual(
        backend.sessions.get("stable-pty-id"),
        replacementSession,
        "old runtime cleanup must use instance identity before deleting the stable map entry",
      );
    },
  );

  await runCase(
    "getSystemInfo schedules a backend retry when remote os is not ready yet",
    async () => {
      const backend = new SSHBackend();
      const session = createSession();
      (backend as any).sessions.set("pty-a", session);
      const originalSetTimeout = globalThis.setTimeout;
      const originalClearTimeout = globalThis.clearTimeout;
      const scheduled: Array<() => void> = [];

      (globalThis as any).setTimeout = (callback: () => void) => {
        scheduled.push(callback);
        return { fake: true } as any;
      };
      (globalThis as any).clearTimeout = () => {};

      let remoteOs: "windows" | undefined;
      let execCallCount = 0;
      (backend as any).waitForRemoteOs = async () => remoteOs;
      (backend as any).execCollect = async () => {
        execCallCount += 1;
        return {
          stdout: JSON.stringify({
            Version: "10.0.26200",
            CSName: "QUIET-HOST",
            Arch: "x64",
          }),
          stderr: "",
        };
      };

      try {
        const info = await backend.getSystemInfo("pty-a");

        assertEqual(
          info,
          undefined,
          "system info should stay undefined while remote os is unresolved",
        );
        assertEqual(
          session.systemInfo,
          undefined,
          "unresolved system info should not be cached",
        );
        assertEqual(
          scheduled.length,
          1,
          "backend should schedule an independent retry after a miss",
        );

        remoteOs = "windows";
        scheduled[0]?.();
        await Promise.resolve();
        await Promise.resolve();

        assertEqual(
          execCallCount,
          1,
          "scheduled retry should probe system info without more terminal output",
        );
        assertEqual(
          session.systemInfo?.hostname,
          "QUIET-HOST",
          "scheduled retry should eventually populate system info",
        );
      } finally {
        (globalThis as any).setTimeout = originalSetTimeout;
        (globalThis as any).clearTimeout = originalClearTimeout;
      }
    },
  );

  await runCase(
    "getSystemInfo retries after a temporary windows collection failure",
    async () => {
      const backend = new SSHBackend();
      const session = createSession();
      session.initializationState = "ready";
      session.remoteOs = "windows";
      (backend as any).sessions.set("pty-b", session);

      let callCount = 0;
      (backend as any).execCollect = async () => {
        callCount += 1;
        if (callCount === 1) {
          throw new Error("temporary failure");
        }
        return {
          stdout: JSON.stringify({
            Version: "10.0.26200",
            CSName: "TUOTUO-SERVER",
            Arch: "x64",
          }),
          stderr: "",
        };
      };

      const first = await backend.getSystemInfo("pty-b");
      const second = await backend.getSystemInfo("pty-b");

      assertEqual(
        first,
        undefined,
        "failed collections should not cache fallback unknown data",
      );
      assertCondition(
        second !== undefined,
        "subsequent calls should retry and return real system info",
      );
      assertEqual(
        second.hostname,
        "TUOTUO-SERVER",
        "retried collection should parse hostname",
      );
      assertEqual(
        session.systemInfo?.hostname,
        "TUOTUO-SERVER",
        "successful retry should populate the cache",
      );
    },
  );

  await runCase(
    "execOnSession writes stdin payloads to the SSH exec channel",
    async () => {
      class FakeStream extends EventEmitter {
        readonly stderr = new EventEmitter();
        endPayload: string | undefined;

        end(input?: string): this {
          this.endPayload = input;
          this.emit("data", Buffer.from("monitor-json"));
          this.emit("close");
          return this;
        }
      }

      const backend = new SSHBackend();
      const stream = new FakeStream();
      let observedCommand = "";
      const session = createSession();
      session.client = {
        exec: (
          command: string,
          callback: (err: Error | null, stream: FakeStream) => void,
        ) => {
          observedCommand = command;
          callback(null, stream);
        },
      };
      (backend as any).sessions.set("pty-c", session);

      const result = await backend.execOnSession(
        "pty-c",
        "powershell.exe -NoLogo -NoProfile -NonInteractive -Command -",
        1000,
        { stdin: "Write-Output 123\n" },
      );

      assertEqual(
        observedCommand,
        "powershell.exe -NoLogo -NoProfile -NonInteractive -Command -",
        "ssh exec should preserve the requested command verbatim",
      );
      assertEqual(
        stream.endPayload,
        "Write-Output 123\n",
        "ssh exec should stream stdin payloads to the remote process",
      );
      assertEqual(
        result?.stdout,
        "monitor-json",
        "ssh exec should still collect stdout when stdin is used",
      );
    },
  );
};

void run().catch((error) => {
  console.error(error);
  process.exit(1);
});
