import process from "node:process";
import { parseArguments, hasFlag } from "./arguments";
import { executeCommand, validateCommand } from "./commands";
import { normalizeCliError } from "./errors";
import { GatewayClient } from "./gateway-client";
import { CLI_HELP } from "./help";
import type {
  CliEnvironment,
  CliErrorEnvelope,
  CliIo,
  CliSuccessEnvelope,
  RpcClient,
} from "./types";

export interface RunCliOptions {
  argv?: string[];
  env?: CliEnvironment;
  io?: CliIo;
  createClient?: (
    url: string,
    token: string | undefined,
    timeoutMs: number,
  ) => RpcClient;
}

const DEFAULT_IO: CliIo = {
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
};

export async function runCli(options: RunCliOptions = {}): Promise<number> {
  const argv = options.argv ?? process.argv.slice(2);
  const env = options.env ?? process.env;
  const io = options.io ?? DEFAULT_IO;
  let pretty = false;
  let client: RpcClient | null = null;

  try {
    const args = parseArguments(argv, env);
    pretty = args.global.pretty;
    if (hasFlag(args, "help") || args.positional.length === 0) {
      io.stdout.write(CLI_HELP);
      return 0;
    }
    validateCommand(args);
    const createClient =
      options.createClient ??
      ((url, token, timeoutMs) => new GatewayClient(url, token, timeoutMs));
    client = createClient(
      args.global.url,
      args.global.token,
      args.global.timeoutMs,
    );
    await client.connect(args.global.timeoutMs);
    const result = await executeCommand(args, client, io);
    const envelope: CliSuccessEnvelope = {
      ok: true,
      command: result.command,
      data: result.data,
    };
    writeJson(io.stdout, envelope, pretty);
    return 0;
  } catch (error) {
    const normalized = normalizeCliError(error);
    const envelope: CliErrorEnvelope = {
      ok: false,
      error: {
        code: normalized.code,
        message: normalized.message,
        ...(normalized.details !== undefined
          ? { details: normalized.details }
          : {}),
      },
    };
    writeJson(io.stderr, envelope, pretty);
    if (options.argv === undefined) process.exitCode = normalized.exitCode;
    return normalized.exitCode;
  } finally {
    client?.close();
  }
}

function writeJson(
  stream: Pick<NodeJS.WriteStream, "write">,
  value: unknown,
  pretty: boolean,
): void {
  stream.write(`${JSON.stringify(value, null, pretty ? 2 : undefined)}\n`);
}

export { CLI_HELP } from "./help";
export { GatewayClient } from "./gateway-client";
