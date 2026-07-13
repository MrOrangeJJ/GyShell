import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as nodePty from "node-pty";
import ssh2Runtime from "ssh2";
import type { SSHConnectionConfig } from "../../types";

const AGENT_START_TIMEOUT_MS = 2_000;
const SSH_ADD_TIMEOUT_MS = 8_000;
const DESTINATION_KEY_TTL_SECONDS = 15;

export interface ScopedOpenSshAgentRequest {
  credential: SSHConnectionConfig;
  destinationUsername: string;
  destinationAlias: string;
  destinationHostKey: Buffer;
  signal?: AbortSignal;
}

const createAbortError = (): Error => {
  const error = new Error("Transfer cancelled by user.");
  error.name = "AbortError";
  return error;
};

const ensureNotAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw createAbortError();
};

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

const buildPtyEnvironment = (socketPath: string): Record<string, string> => {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  delete environment.SSH_ASKPASS;
  delete environment.SSH_ASKPASS_REQUIRE;
  return {
    ...environment,
    LC_ALL: "C",
    SSH_AUTH_SOCK: socketPath,
    TERM: environment.TERM || "xterm-256color",
  };
};

/**
 * A single-key OpenSSH agent lease used only by one direct-transfer attempt.
 * The identity is constrained to the exact destination user and observed host
 * key, so forwarding the socket does not grant general use of the private key.
 */
export class ScopedOpenSshAgent {
  private constructor(
    readonly socketPath: string,
    private readonly agentProcess: ChildProcess,
    private readonly directoryPath: string,
  ) {}

  static async create(
    request: ScopedOpenSshAgentRequest,
  ): Promise<ScopedOpenSshAgent> {
    ensureNotAborted(request.signal);
    if (process.platform === "win32") {
      throw new Error("A local OpenSSH agent is unavailable on Windows.");
    }
    if (/[/\0\r\n]/.test(request.destinationAlias)) {
      throw new Error("Invalid destination alias.");
    }
    if (/[@\0\r\n]/.test(request.destinationUsername)) {
      throw new Error("Invalid destination username.");
    }
    if (
      request.credential.passphrase &&
      /[\0\r\n]/.test(request.credential.passphrase)
    ) {
      throw new Error("Unsupported private-key passphrase.");
    }

    const keyContent = await this.readPrivateKey(request.credential);
    const parsed = ssh2Runtime.utils.parseKey(
      keyContent,
      request.credential.passphrase,
    );
    const parsedKey = Array.isArray(parsed) ? parsed[0] : parsed;
    if (parsedKey instanceof Error || !parsedKey?.isPrivateKey()) {
      keyContent.fill(0);
      throw new Error("The private key could not be parsed.");
    }

    let directoryPath: string | null = null;
    let agentProcess: ChildProcess | null = null;

    try {
      directoryPath = await fs.mkdtemp(join(tmpdir(), "gyshell-agent-"));
      await fs.chmod(directoryPath, 0o700);
      const socketPath = join(directoryPath, "agent.sock");
      const privateKeyPath = join(directoryPath, "identity");
      const knownHostsPath = join(directoryPath, "known_hosts");
      await fs.writeFile(privateKeyPath, keyContent, {
        flag: "wx",
        mode: 0o600,
      });
      await fs.writeFile(
        knownHostsPath,
        this.buildKnownHostsEntry(
          request.destinationAlias,
          request.destinationHostKey,
        ),
        { flag: "wx", mode: 0o600 },
      );
      keyContent.fill(0);

      agentProcess = spawn("ssh-agent", ["-D", "-a", socketPath], {
        stdio: ["ignore", "ignore", "ignore"],
      });
      await this.waitForAgentSocket(agentProcess, socketPath, request.signal);
      await this.addConstrainedKey({
        socketPath,
        directoryPath,
        privateKeyPath,
        knownHostsPath,
        destination: `${request.destinationUsername}@${request.destinationAlias}`,
        passphrase: request.credential.passphrase,
        signal: request.signal,
      });
      await fs.rm(privateKeyPath, { force: true });

      return new ScopedOpenSshAgent(socketPath, agentProcess, directoryPath);
    } catch (error) {
      keyContent.fill(0);
      agentProcess?.kill("SIGTERM");
      if (directoryPath) {
        await fs.rm(directoryPath, { recursive: true, force: true });
      }
      throw error;
    }
  }

  private static async readPrivateKey(
    config: SSHConnectionConfig,
  ): Promise<Buffer> {
    if (config.privateKey) return Buffer.from(config.privateKey);
    if (config.privateKeyPath) return await fs.readFile(config.privateKeyPath);
    throw new Error("The private key is unavailable.");
  }

  private static buildKnownHostsEntry(
    alias: string,
    rawHostKey: Buffer,
  ): Buffer {
    const parsed = ssh2Runtime.utils.parseKey(rawHostKey);
    const key = Array.isArray(parsed) ? parsed[0] : parsed;
    if (key instanceof Error || !key) {
      throw new Error("The destination host key could not be parsed.");
    }
    return Buffer.from(
      `${alias} ${key.type} ${rawHostKey.toString("base64")}\n`,
      "utf8",
    );
  }

  private static async waitForAgentSocket(
    agentProcess: ChildProcess,
    socketPath: string,
    signal?: AbortSignal,
  ): Promise<void> {
    let spawnError: Error | null = null;
    agentProcess.once("error", (error) => {
      spawnError = error;
    });

    const startedAt = Date.now();
    while (Date.now() - startedAt < AGENT_START_TIMEOUT_MS) {
      ensureNotAborted(signal);
      if (spawnError) throw spawnError;
      if (agentProcess.exitCode !== null) {
        throw new Error("ssh-agent exited before becoming ready.");
      }
      try {
        await fs.stat(socketPath);
        return;
      } catch {
        await delay(20, signal);
      }
    }
    throw new Error("Timed out while starting ssh-agent.");
  }

  private static async addConstrainedKey(input: {
    socketPath: string;
    directoryPath: string;
    privateKeyPath: string;
    knownHostsPath: string;
    destination: string;
    passphrase?: string;
    signal?: AbortSignal;
  }): Promise<void> {
    ensureNotAborted(input.signal);
    await new Promise<void>((resolve, reject) => {
      let terminal: nodePty.IPty;
      let settled = false;
      let promptTail = "";
      let passphraseSent = false;
      let timeout: ReturnType<typeof setTimeout> | null = null;
      let dataSubscription: ReturnType<nodePty.IPty["onData"]> | null = null;
      let exitSubscription: ReturnType<nodePty.IPty["onExit"]> | null = null;

      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        input.signal?.removeEventListener("abort", onAbort);
        dataSubscription?.dispose();
        exitSubscription?.dispose();
        if (error) reject(error);
        else resolve();
      };
      const onAbort = (): void => {
        try {
          terminal.kill();
        } catch {
          // The process may have exited while cancellation was delivered.
        }
        finish(createAbortError());
      };

      try {
        terminal = nodePty.spawn(
          "ssh-add",
          [
            "-H",
            input.knownHostsPath,
            "-h",
            input.destination,
            "-t",
            String(DESTINATION_KEY_TTL_SECONDS),
            input.privateKeyPath,
          ],
          {
            name: "xterm-color",
            cols: 80,
            rows: 24,
            cwd: input.directoryPath,
            env: buildPtyEnvironment(input.socketPath),
          },
        );
      } catch (error) {
        reject(error);
        return;
      }

      timeout = setTimeout(() => {
        try {
          terminal.kill();
        } catch {
          // The timeout result below is authoritative.
        }
        finish(new Error("Timed out while loading the private key."));
      }, SSH_ADD_TIMEOUT_MS);
      dataSubscription = terminal.onData((data) => {
        promptTail = `${promptTail}${data}`.slice(-512);
        if (passphraseSent && /bad passphrase|try again/i.test(promptTail)) {
          terminal.kill();
          finish(new Error("The private-key passphrase was rejected."));
          return;
        }
        if (passphraseSent) return;
        if (!/enter passphrase for .+:\s*$/i.test(promptTail)) return;
        if (!input.passphrase) {
          terminal.kill();
          finish(new Error("The private key requires a passphrase."));
          return;
        }
        passphraseSent = true;
        promptTail = "";
        terminal.write(`${input.passphrase}\r`);
      });
      exitSubscription = terminal.onExit(({ exitCode }) => {
        if (exitCode !== 0) {
          finish(new Error(`ssh-add exited with code ${exitCode}.`));
          return;
        }
        finish();
      });
      input.signal?.addEventListener("abort", onAbort, { once: true });
      if (input.signal?.aborted) onAbort();
    });
  }

  async dispose(): Promise<void> {
    const isRunning = (): boolean =>
      this.agentProcess.exitCode === null &&
      this.agentProcess.signalCode === null;
    if (isRunning()) {
      const exited = new Promise<void>((resolve) =>
        this.agentProcess.once("exit", () => resolve()),
      );
      this.agentProcess.kill("SIGTERM");
      await Promise.race([
        exited,
        new Promise<void>((resolve) => setTimeout(resolve, 500)),
      ]);
      if (isRunning()) {
        this.agentProcess.kill("SIGKILL");
      }
    }
    await fs.rm(this.directoryPath, { recursive: true, force: true });
  }
}
