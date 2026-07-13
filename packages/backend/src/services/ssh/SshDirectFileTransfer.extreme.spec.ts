import { EventEmitter } from "node:events";
import type { SSHConnectionConfig } from "../../types";
import {
  SshDirectFileTransfer,
  type SshDirectFileTransferRequest,
} from "./SshDirectFileTransfer";
import { SshScpTransferAttempt } from "./SshScpTransferAttempt";

const assertEqual = <T>(actual: T, expected: T, message: string): void => {
  if (actual !== expected) {
    throw new Error(
      `${message}. expected=${String(expected)} actual=${String(actual)}`,
    );
  }
};

const assertCondition = (condition: boolean, message: string): void => {
  if (!condition) throw new Error(message);
};

const runCase = async (
  name: string,
  fn: () => Promise<void> | void,
): Promise<void> => {
  await fn();
  console.log(`PASS ${name}`);
};

const sshWireString = (value: Buffer): Buffer => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(value.length, 0);
  return Buffer.concat([length, value]);
};

const observedHostKey = Buffer.concat([
  sshWireString(Buffer.from("ssh-ed25519")),
  sshWireString(Buffer.alloc(32, 7)),
]);

const config = (
  id: string,
  authMethod: "password" | "privateKey" = "password",
): SSHConnectionConfig => ({
  type: "ssh",
  id,
  title: id,
  cols: 80,
  rows: 24,
  host: `${id}.example.test`,
  port: 22,
  username: "tester",
  authMethod,
  ...(authMethod === "password"
    ? { password: `secret-${id}` }
    : { privateKey: "not-used-by-password-tests" }),
});

const jumpConfig = (
  id: string,
  overrides: Partial<SSHConnectionConfig> = {},
): SSHConnectionConfig => ({
  ...config(id),
  host: "shared-jump.example.test",
  username: "jump-user",
  ...overrides,
});

const createSftpHarness = () => {
  let stagingSize = 0;
  let renameCount = 0;
  let standardRenameCount = 0;
  let unlinkCount = 0;
  let endCount = 0;
  let unlinkError: Error | null = null;
  let extensionRenameHandler = (callback: (error?: Error) => void): void =>
    callback();
  let standardRenameHandler = (callback: (error?: Error) => void): void =>
    callback();
  const sftp = {
    stat: (
      _path: string,
      callback: (error: Error | null, stats?: { size: number }) => void,
    ) => callback(null, { size: stagingSize }),
    unlink: (_path: string, callback: (error?: Error) => void) => {
      unlinkCount += 1;
      stagingSize = 0;
      callback(unlinkError || undefined);
    },
    ext_openssh_rename: (
      _sourcePath: string,
      _targetPath: string,
      callback: (error?: Error) => void,
    ) => {
      renameCount += 1;
      extensionRenameHandler(callback);
    },
    rename: (
      _sourcePath: string,
      _targetPath: string,
      callback: (error?: Error) => void,
    ) => {
      standardRenameCount += 1;
      standardRenameHandler(callback);
    },
    end: () => {
      endCount += 1;
    },
  };
  const client = {
    sftp: (callback: (error: Error | null, wrapper: unknown) => void) =>
      callback(null, sftp),
  };
  return {
    client,
    get stagingSize() {
      return stagingSize;
    },
    set stagingSize(value: number) {
      stagingSize = value;
    },
    get renameCount() {
      return renameCount;
    },
    get standardRenameCount() {
      return standardRenameCount;
    },
    get unlinkCount() {
      return unlinkCount;
    },
    get endCount() {
      return endCount;
    },
    set unlinkError(value: Error | null) {
      unlinkError = value;
    },
    set extensionRenameHandler(
      value: (callback: (error?: Error) => void) => void,
    ) {
      extensionRenameHandler = value;
    },
    set standardRenameHandler(
      value: (callback: (error?: Error) => void) => void,
    ) {
      standardRenameHandler = value;
    },
  };
};

const createRequest = (
  targetClient: unknown,
  expectedBytes = 64 * 1024 * 1024,
): SshDirectFileTransferRequest => ({
  sourceClient: {} as never,
  sourceConfig: config("source"),
  sourceObservedHostKey: observedHostKey,
  sourcePath: "/data/source's file.bin",
  targetClient: targetClient as never,
  targetConfig: config("target"),
  targetObservedHostKey: observedHostKey,
  targetPath: "/data/目标 file.bin",
  openAgentExecutorClient: async () => null,
  options: { expectedBytes },
});

const run = async (): Promise<void> => {
  await runCase(
    "scp command line is pinned, config-isolated, and credential-free",
    () => {
      const attempt = new SshScpTransferAttempt() as any;
      const source = {
        side: "source",
        client: {},
        config: config("source"),
        observedHostKey,
      };
      const target = {
        side: "target",
        client: {},
        config: config("target"),
        observedHostKey,
      };
      const command = attempt.buildScpCommand({
        executor: source,
        remote: target,
        sourcePath: "/data/source's file.bin",
        targetPath: "/data/目标 file.bin",
        direction: "push",
        expectedBytes: 1,
        hostAlias: "gyshell-peer-target-test",
      }) as string;

      assertCondition(
        command.includes("'scp' '-F' '/dev/null'"),
        "scp must ignore user config",
      );
      assertCondition(
        command.includes("StrictHostKeyChecking=yes"),
        "host-key checking must be strict",
      );
      assertCondition(
        command.includes("KnownHostsCommand="),
        "active-session host key must be injected",
      );
      assertCondition(
        command.includes("'--'"),
        "paths must follow the option terminator",
      );
      assertCondition(
        !command.includes("secret-target"),
        "password must never enter the command",
      );
      assertCondition(
        !command.includes(" -O "),
        "legacy SCP protocol must never be requested",
      );
      assertCondition(
        !command.includes("'-q'"),
        "connection diagnostics must remain visible for route classification",
      );
    },
  );

  await runCase(
    "scp stderr connection diagnostics enable reverse-route classification",
    async () => {
      const attempt = new SshScpTransferAttempt() as any;
      const stream = new EventEmitter() as EventEmitter & {
        stderr: EventEmitter;
        close: () => void;
        signal: () => void;
      };
      stream.stderr = new EventEmitter();
      stream.close = () => undefined;
      stream.signal = () => undefined;
      const client = {
        exec: (
          _command: string,
          _options: unknown,
          callback: (error: Error | undefined, channel: unknown) => void,
        ) => {
          callback(undefined, stream);
          queueMicrotask(() => {
            stream.stderr.emit(
              "data",
              Buffer.from(
                "ssh: connect to host target.example.test port 22: Connection refused\r\n",
              ),
            );
            stream.emit("close", 255);
          });
        },
      };

      const result = await attempt.executeScp({
        client,
        command: "scp test",
        agentForward: false,
      });
      assertEqual(
        result.connectionFailed,
        true,
        "OpenSSH connection stderr should be recognized",
      );
      assertEqual(
        attempt.classifyScpFailure(result),
        "direct-connection-failed",
        "recognized connection failure should permit reverse pull",
      );
    },
  );

  await runCase(
    "zero-byte push failure attempts reverse pull before relay",
    async () => {
      const harness = createSftpHarness();
      const directions: string[] = [];
      const attempt = {
        run: async ({ direction }: { direction: string }) => {
          directions.push(direction);
          if (directions.length === 1) {
            return {
              succeeded: false,
              maxObservedBytes: 0,
              reason: "direct-connection-failed",
            };
          }
          harness.stagingSize = 64 * 1024 * 1024;
          return {
            succeeded: true,
            maxObservedBytes: 64 * 1024 * 1024,
            reason: "direct-copy-failed",
          };
        },
      };
      const service = new SshDirectFileTransfer(attempt as never);

      const result = await service.tryTransfer(createRequest(harness.client));
      assertEqual(
        result.status,
        "transferred",
        "reverse pull should complete transfer",
      );
      assertEqual(
        directions.length,
        2,
        "both push and pull should be attempted",
      );
      assertEqual(
        directions[1],
        "pull",
        "second attempt should be reverse pull",
      );
      assertEqual(
        harness.renameCount,
        1,
        "verified staging file should commit once",
      );
    },
  );

  await runCase(
    "explicit extension rejection uses the standard rename fallback",
    async () => {
      const harness = createSftpHarness();
      harness.extensionRenameHandler = (callback) => {
        const error = new Error("unsupported extension") as Error & {
          code: number;
        };
        error.code = 8;
        callback(error);
      };
      const service = new SshDirectFileTransfer({
        run: async () => {
          harness.stagingSize = 64 * 1024 * 1024;
          return {
            succeeded: true,
            maxObservedBytes: harness.stagingSize,
            reason: "direct-copy-failed",
          };
        },
      } as never);

      const result = await service.tryTransfer(createRequest(harness.client));
      assertEqual(
        result.status,
        "transferred",
        "standard rename should commit",
      );
      assertEqual(
        harness.standardRenameCount,
        1,
        "explicit unsupported status should try standard rename once",
      );
    },
  );

  await runCase(
    "commit timeout is indeterminate and never falls through to relay",
    async () => {
      const harness = createSftpHarness();
      harness.extensionRenameHandler = () => undefined;
      const service = new SshDirectFileTransfer(
        {
          run: async () => {
            harness.stagingSize = 64 * 1024 * 1024;
            return {
              succeeded: true,
              maxObservedBytes: harness.stagingSize,
              reason: "direct-copy-failed",
            };
          },
        } as never,
        { commitTimeoutMs: 25, commitAbortGraceMs: 10 },
      );
      const startedAt = Date.now();
      let caught: Error | null = null;
      try {
        await service.tryTransfer(createRequest(harness.client));
      } catch (error) {
        caught = error as Error;
      }

      assertEqual(
        caught?.name,
        "SshDirectCommitIndeterminateError",
        "an unacknowledged commit must not authorize relay fallback",
      );
      assertEqual(
        harness.standardRenameCount,
        0,
        "an indeterminate extension request must not start another rename",
      );
      assertCondition(harness.endCount >= 1, "stuck SFTP channel should close");
      assertCondition(
        Date.now() - startedAt < 500,
        "configured commit timeout should settle promptly",
      );
    },
  );

  await runCase(
    "abort settles a commit whose rename callback never arrives",
    async () => {
      const harness = createSftpHarness();
      const controller = new AbortController();
      harness.extensionRenameHandler = () => undefined;
      const service = new SshDirectFileTransfer(
        {
          run: async () => {
            harness.stagingSize = 64 * 1024 * 1024;
            return {
              succeeded: true,
              maxObservedBytes: harness.stagingSize,
              reason: "direct-copy-failed",
            };
          },
        } as never,
        { commitTimeoutMs: 1_000, commitAbortGraceMs: 20 },
      );
      const request = createRequest(harness.client);
      request.options = {
        expectedBytes: request.options.expectedBytes,
        signal: controller.signal,
      };
      const startedAt = Date.now();
      const transfer = service.tryTransfer(request);
      setTimeout(() => controller.abort(), 10);
      let caught: Error | null = null;
      try {
        await transfer;
      } catch (error) {
        caught = error as Error;
      }

      assertEqual(caught?.name, "AbortError", "stuck commit should cancel");
      assertEqual(
        harness.standardRenameCount,
        0,
        "stuck cancelled commit must not start standard rename",
      );
      assertCondition(harness.endCount >= 1, "cancel should close SFTP");
      assertCondition(
        Date.now() - startedAt < 500,
        "commit cancellation should not wait for the normal timeout",
      );
    },
  );

  await runCase(
    "abort after extension failure never starts standard rename",
    async () => {
      const harness = createSftpHarness();
      const controller = new AbortController();
      harness.extensionRenameHandler = (callback) => {
        controller.abort();
        const error = new Error("unsupported extension") as Error & {
          code: number;
        };
        error.code = 8;
        callback(error);
      };
      const service = new SshDirectFileTransfer(
        {
          run: async () => {
            harness.stagingSize = 64 * 1024 * 1024;
            return {
              succeeded: true,
              maxObservedBytes: harness.stagingSize,
              reason: "direct-copy-failed",
            };
          },
        } as never,
        { commitTimeoutMs: 50, commitAbortGraceMs: 10 },
      );
      const request = createRequest(harness.client);
      request.options = {
        expectedBytes: request.options.expectedBytes,
        signal: controller.signal,
      };
      let caught: Error | null = null;
      try {
        await service.tryTransfer(request);
      } catch (error) {
        caught = error as Error;
      }

      assertEqual(caught?.name, "AbortError", "commit race should cancel");
      assertEqual(
        harness.standardRenameCount,
        0,
        "cancellation must suppress the standard rename fallback",
      );
    },
  );

  await runCase(
    "confirmed commit wins the race before cancellation is reported",
    async () => {
      const harness = createSftpHarness();
      const controller = new AbortController();
      harness.extensionRenameHandler = (callback) => {
        controller.abort();
        callback();
      };
      const service = new SshDirectFileTransfer(
        {
          run: async () => {
            harness.stagingSize = 64 * 1024 * 1024;
            return {
              succeeded: true,
              maxObservedBytes: harness.stagingSize,
              reason: "direct-copy-failed",
            };
          },
        } as never,
        { commitTimeoutMs: 50, commitAbortGraceMs: 10 },
      );
      const request = createRequest(harness.client);
      request.options = {
        expectedBytes: request.options.expectedBytes,
        signal: controller.signal,
      };
      let caught: Error | null = null;
      try {
        await service.tryTransfer(request);
      } catch (error) {
        caught = error as Error;
      }

      assertEqual(
        caught?.name,
        "AbortError",
        "late cancellation should report",
      );
      assertEqual(harness.renameCount, 1, "commit should be acknowledged once");
      assertEqual(
        harness.unlinkCount,
        0,
        "confirmed destination must not be deleted as staging cleanup",
      );
    },
  );

  await runCase(
    "platform-specific network errors are connection failures",
    () => {
      const attempt = new SshScpTransferAttempt() as any;
      for (const diagnostic of [
        "Network is unreachable",
        "Operation timed out",
        "Connection reset by peer",
      ]) {
        assertEqual(
          attempt.isConnectionFailureDiagnostic(diagnostic.toLowerCase()),
          true,
          `${diagnostic} should permit reverse direction`,
        );
      }
      assertEqual(
        attempt.isConnectionFailureDiagnostic("permission denied"),
        false,
        "authentication failure must not be treated as reachability",
      );
    },
  );

  await runCase("staging unlink error suppresses reverse pull", async () => {
    const harness = createSftpHarness();
    const unlinkError = new Error("permission denied") as Error & {
      code: string;
    };
    unlinkError.code = "EPERM";
    harness.unlinkError = unlinkError;
    let attempts = 0;
    const service = new SshDirectFileTransfer({
      run: async () => {
        attempts += 1;
        return {
          succeeded: false,
          maxObservedBytes: 0,
          reason: "direct-connection-failed",
        };
      },
    } as never);

    const result = await service.tryTransfer(createRequest(harness.client));
    assertEqual(result.status, "fallback", "unlink error should use relay");
    assertEqual(attempts, 1, "unlink error must not start reverse pull");
  });

  await runCase(
    "partial push failure does not repeat bytes through reverse pull",
    async () => {
      const harness = createSftpHarness();
      let attempts = 0;
      const attempt = {
        run: async () => {
          attempts += 1;
          harness.stagingSize = 4096;
          return {
            succeeded: false,
            maxObservedBytes: 4096,
            reason: "direct-copy-failed",
          };
        },
      };
      const service = new SshDirectFileTransfer(attempt as never);

      const result = await service.tryTransfer(createRequest(harness.client));
      assertEqual(
        result.status,
        "fallback",
        "partial failure should return relay fallback",
      );
      assertEqual(attempts, 1, "partial push must suppress reverse pull");
      assertEqual(
        harness.renameCount,
        0,
        "partial staging file must never commit",
      );
      assertCondition(
        harness.unlinkCount >= 1,
        "partial staging file should be cleaned",
      );
    },
  );

  await runCase(
    "authentication failure does not delegate the opposite credential",
    async () => {
      const harness = createSftpHarness();
      let attempts = 0;
      const service = new SshDirectFileTransfer({
        run: async () => {
          attempts += 1;
          return {
            succeeded: false,
            maxObservedBytes: 0,
            reason: "direct-authentication-failed",
          };
        },
      } as never);

      const result = await service.tryTransfer(createRequest(harness.client));
      assertEqual(result.status, "fallback", "auth failure should use relay");
      assertEqual(attempts, 1, "auth failure must not attempt reverse pull");
    },
  );

  await runCase(
    "reverse pull rejects remote-source glob metacharacters",
    async () => {
      for (const sourcePath of [
        "/data/a*.bin",
        "/data/a?.bin",
        "/data/[ab].bin",
        "/data/a\\b.bin",
      ]) {
        const harness = createSftpHarness();
        let attempts = 0;
        const service = new SshDirectFileTransfer({
          run: async () => {
            attempts += 1;
            return {
              succeeded: false,
              maxObservedBytes: 0,
              reason: "direct-connection-failed",
            };
          },
        } as never);
        const request = createRequest(harness.client);
        request.sourcePath = sourcePath;

        const result = await service.tryTransfer(request);
        assertEqual(result.status, "fallback", `${sourcePath} should relay`);
        assertEqual(attempts, 1, `${sourcePath} must not reverse pull`);
      }
    },
  );

  await runCase(
    "unsafe newline paths fail closed before opening SFTP",
    async () => {
      const service = new SshDirectFileTransfer();
      let opened = false;
      const request = createRequest({
        sftp: () => {
          opened = true;
        },
      });
      request.sourcePath = "/data/source\nmalicious";
      const result = await service.tryTransfer(request as never);
      assertEqual(result.status, "fallback", "unsafe path should fall back");
      assertEqual(
        opened,
        false,
        "unsafe path must be rejected before side effects",
      );
    },
  );

  await runCase(
    "matching jump ingress routes allow peer private-address probing",
    async () => {
      const harness = createSftpHarness();
      const request = createRequest(harness.client);
      request.sourceConfig.jumpHost = jumpConfig("source-jump", {
        password: "source-copy-of-jump-password",
      });
      request.targetConfig.jumpHost = jumpConfig("target-jump", {
        password: "target-copy-of-jump-password",
      });
      let attempts = 0;
      const service = new SshDirectFileTransfer({
        run: async () => {
          attempts += 1;
          harness.stagingSize = request.options.expectedBytes;
          return {
            succeeded: true,
            maxObservedBytes: request.options.expectedBytes,
            reason: "direct-copy-failed",
          };
        },
      } as never);

      const result = await service.tryTransfer(request);
      assertEqual(
        result.status,
        "transferred",
        "shared jump should allow direct",
      );
      assertEqual(attempts, 1, "shared jump should attempt peer scp once");
    },
  );

  await runCase(
    "one-sided or different jump ingress routes fail closed before probing",
    async () => {
      for (const configure of [
        (request: SshDirectFileTransferRequest) => {
          request.sourceConfig.jumpHost = jumpConfig("source-jump");
        },
        (request: SshDirectFileTransferRequest) => {
          request.sourceConfig.jumpHost = jumpConfig("source-jump");
          request.targetConfig.jumpHost = jumpConfig("target-jump", {
            host: "different-jump.example.test",
          });
        },
        (request: SshDirectFileTransferRequest) => {
          request.sourceConfig.jumpHost = jumpConfig("source-jump");
          request.targetConfig.jumpHost = jumpConfig("target-jump", {
            username: "different-user",
          });
        },
      ]) {
        let opened = false;
        const request = createRequest({
          sftp: () => {
            opened = true;
          },
        });
        configure(request);
        const result = await new SshDirectFileTransfer().tryTransfer(request);
        assertEqual(
          result.status,
          "fallback",
          "unsafe jump pairing should relay",
        );
        assertEqual(opened, false, "unsafe jump pairing must not open SFTP");
      }
    },
  );

  await runCase(
    "explicit proxy connection policy fails closed to relay",
    async () => {
      let opened = false;
      const request = createRequest({
        sftp: () => {
          opened = true;
        },
      });
      request.targetConfig.proxy = {
        id: "proxy",
        name: "Explicit Proxy",
        type: "socks5",
        host: "127.0.0.1",
        port: 1080,
      };
      const result = await new SshDirectFileTransfer().tryTransfer(
        request as never,
      );
      assertEqual(result.status, "fallback", "proxy route should relay");
      assertEqual(
        opened,
        false,
        "proxy policy must be checked before side effects",
      );
    },
  );

  await runCase(
    "AbortError from direct scp propagates instead of becoming fallback",
    async () => {
      const harness = createSftpHarness();
      const attempt = {
        run: async () => {
          const error = new Error("cancelled");
          error.name = "AbortError";
          throw error;
        },
      };
      const service = new SshDirectFileTransfer(attempt as never);

      let caught: Error | null = null;
      try {
        await service.tryTransfer(createRequest(harness.client));
      } catch (error) {
        caught = error as Error;
      }
      assertEqual(
        caught?.name,
        "AbortError",
        "cancellation should propagate as AbortError",
      );
    },
  );

  await runCase(
    "late exec callback after open timeout kills the ghost scp channel",
    async () => {
      class FakeStream extends EventEmitter {
        readonly stderr = new EventEmitter();
        kills = 0;
        closes = 0;

        signal(): void {
          this.kills += 1;
        }

        close(): void {
          this.closes += 1;
        }
      }
      let callback:
        | ((error: Error | null, stream?: FakeStream) => void)
        | undefined;
      const attempt = new SshScpTransferAttempt() as any;
      const execution = attempt.executeScp({
        client: {
          exec: (
            _command: string,
            _options: unknown,
            onOpen: (error: Error | null, stream?: FakeStream) => void,
          ) => {
            callback = onOpen;
          },
        },
        command: "scp test",
        agentForward: false,
      });
      await execution.catch(() => undefined);

      const lateStream = new FakeStream();
      callback?.(null, lateStream);
      assertEqual(lateStream.kills, 1, "late scp channel should be killed");
      assertEqual(lateStream.closes, 1, "late scp channel should be closed");
    },
  );

  await runCase(
    "abort settles even when target SFTP open never calls back",
    async () => {
      const controller = new AbortController();
      const request = createRequest({ sftp: () => undefined });
      const startedAt = Date.now();
      const transfer = new SshDirectFileTransfer().tryTransfer({
        ...request,
        options: {
          expectedBytes: request.options.expectedBytes,
          signal: controller.signal,
        },
      } as never);
      setTimeout(() => controller.abort(), 10);

      let caught: Error | null = null;
      try {
        await transfer;
      } catch (error) {
        caught = error as Error;
      }
      assertEqual(
        caught?.name,
        "AbortError",
        "SFTP-open abort should propagate",
      );
      assertCondition(
        Date.now() - startedAt < 500,
        "SFTP-open abort should not wait for the open timeout",
      );
    },
  );

  await runCase(
    "stalled scp channel falls back after first-progress watchdog",
    async () => {
      class StalledStream extends EventEmitter {
        readonly stderr = new EventEmitter();
        kills = 0;
        closes = 0;

        signal(): void {
          this.kills += 1;
        }

        close(): void {
          this.closes += 1;
        }
      }
      const stream = new StalledStream();
      const client = {
        exec: (
          _command: string,
          _options: unknown,
          callback: (error: Error | null, stream: StalledStream) => void,
        ) => callback(null, stream),
      };
      const attempt = new SshScpTransferAttempt({
        firstProgressTimeoutMs: 30,
        idleProgressTimeoutMs: 30,
      }) as any;
      attempt.resolveScpCapability = async () => "supported";
      const startedAt = Date.now();
      const result = await attempt.run({
        executor: {
          side: "source",
          client,
          config: config("source"),
          observedHostKey,
        },
        remote: {
          side: "target",
          client: {},
          config: config("target"),
          observedHostKey,
        },
        sourcePath: "/data/source.bin",
        targetPath: "/data/staging.bin",
        direction: "push",
        targetSftp: { stat: () => undefined },
        expectedBytes: 64 * 1024 * 1024,
        hostAlias: "gyshell-peer-watchdog",
        openAgentExecutorClient: async () => null,
      });

      assertEqual(result.succeeded, false, "stalled route should fall back");
      assertEqual(stream.kills, 1, "watchdog should kill stalled scp");
      assertEqual(stream.closes, 1, "watchdog should close stalled scp");
      assertCondition(
        Date.now() - startedAt < 500,
        "test watchdog should settle promptly",
      );
    },
  );

  await runCase(
    "transient capability failure is not cached for the session",
    async () => {
      let calls = 0;
      const client = {
        exec: (
          _command: string,
          callback: (
            error: Error | null,
            stream?: EventEmitter & { stderr: EventEmitter },
          ) => void,
        ) => {
          calls += 1;
          if (calls === 1) {
            callback(new Error("temporary channel failure"));
            return;
          }
          const stream = new EventEmitter() as EventEmitter & {
            stderr: EventEmitter;
          };
          stream.stderr = new EventEmitter();
          callback(null, stream);
          queueMicrotask(() => {
            stream.emit("data", Buffer.from("OpenSSH_9.6p1"));
            stream.emit("close", 0);
          });
        },
      };
      const attempt = new SshScpTransferAttempt() as any;
      const first = await attempt.resolveScpCapability(client);
      const second = await attempt.resolveScpCapability(client);

      assertEqual(
        first,
        "unavailable",
        "transient failure should be unavailable",
      );
      assertEqual(second, "supported", "second probe should retry and succeed");
      assertEqual(calls, 2, "unavailable result must not be cached");
    },
  );
};

void run().catch((error) => {
  console.error(error);
  process.exit(1);
});
