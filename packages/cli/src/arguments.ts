import { CliUsageError } from "./errors";
import type {
  CliEnvironment,
  CliGlobalOptions,
  ParsedArguments,
} from "./types";

const BOOLEAN_FLAGS = new Set([
  "help",
  "pretty",
  "wait",
  "stdin",
  "enter",
  "include-secrets",
  "ack-experimental-risk",
]);
const FLAG_ALIASES: Record<string, string> = {
  h: "help",
  sessionid: "session-id",
  sessionId: "session-id",
};

const GLOBAL_FLAGS = new Set(["url", "token", "timeout", "pretty", "help"]);
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

export function normalizeGatewayUrl(raw: string): string {
  const value = raw.trim();
  if (!value) throw new CliUsageError("Gateway URL cannot be empty.");
  if (value.startsWith("ws://") || value.startsWith("wss://")) return value;
  return `ws://${value}`;
}

function positiveInteger(
  raw: string | undefined,
  fallback: number,
  name: string,
): number {
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new CliUsageError(`${name} must be a positive integer.`);
  }
  if (value > MAX_TIMER_DELAY_MS) {
    throw new CliUsageError(`${name} must be at most ${MAX_TIMER_DELAY_MS}.`);
  }
  return value;
}

function defaultGatewayUrl(env: CliEnvironment): string {
  const explicit = env.GYSHELL_URL || env.GYSHELL_WS_URL || env.GYLL_URL;
  if (explicit?.trim()) return normalizeGatewayUrl(explicit);
  const port = positiveInteger(
    env.GYSHELL_WS_PORT || env.GYBACKEND_WS_PORT,
    17888,
    "Gateway port",
  );
  if (port > 65535)
    throw new CliUsageError("Gateway port must be at most 65535.");
  return `ws://127.0.0.1:${port}`;
}

function canonicalFlagName(raw: string): string {
  return FLAG_ALIASES[raw] || raw;
}

export function parseArguments(
  argv: string[],
  env: CliEnvironment = process.env,
): ParsedArguments {
  const positional: string[] = [];
  const flags = new Map<string, string[]>();
  let endOfOptions = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (endOfOptions) {
      positional.push(token);
      continue;
    }
    if (token === "--") {
      endOfOptions = true;
      continue;
    }
    if (token === "-h") {
      addFlag(flags, "help", "true");
      continue;
    }
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }

    const separator = token.indexOf("=");
    const rawName = token.slice(2, separator === -1 ? undefined : separator);
    const name = canonicalFlagName(rawName);
    if (!name) throw new CliUsageError("Flag name cannot be empty.");

    if (separator !== -1) {
      if (BOOLEAN_FLAGS.has(name)) {
        throw new CliUsageError(
          `--${name} is a boolean switch and does not accept a value.`,
        );
      }
      addFlag(flags, name, token.slice(separator + 1));
      continue;
    }
    if (BOOLEAN_FLAGS.has(name)) {
      addFlag(flags, name, "true");
      continue;
    }
    const next = argv[index + 1];
    if (next === undefined || next === "--" || next.startsWith("--")) {
      throw new CliUsageError(`--${name} requires a value.`);
    }
    addFlag(flags, name, next);
    index += 1;
  }

  const timeoutMs = positiveInteger(
    getFlag(flags, "timeout") || env.GYSHELL_TIMEOUT_MS || env.GYLL_TIMEOUT_MS,
    15_000,
    "--timeout",
  );
  const global: CliGlobalOptions = {
    url: normalizeGatewayUrl(getFlag(flags, "url") || defaultGatewayUrl(env)),
    token:
      getFlag(flags, "token") ||
      env.GYSHELL_TOKEN ||
      env.GYSHELL_ACCESS_TOKEN ||
      env.GYLL_TOKEN ||
      undefined,
    timeoutMs,
    pretty: hasFlag(flags, "pretty"),
  };
  return { positional, flags, global };
}

function addFlag(
  flags: Map<string, string[]>,
  name: string,
  value: string,
): void {
  const current = flags.get(name) || [];
  current.push(value);
  flags.set(name, current);
}

export function getFlag(
  args: ParsedArguments | Map<string, string[]>,
  name: string,
): string | undefined {
  const flags = args instanceof Map ? args : args.flags;
  return flags.get(name)?.at(-1);
}

export function getFlags(args: ParsedArguments, name: string): string[] {
  return [...(args.flags.get(name) || [])];
}

export function hasFlag(
  args: ParsedArguments | Map<string, string[]>,
  name: string,
): boolean {
  const flags = args instanceof Map ? args : args.flags;
  return flags.has(name);
}

export function assertAllowedFlags(
  args: ParsedArguments,
  allowed: string[],
): void {
  const accepted = new Set([...GLOBAL_FLAGS, ...allowed]);
  const unknown = [...args.flags.keys()].filter((name) => !accepted.has(name));
  if (unknown.length > 0) {
    throw new CliUsageError(
      `Unknown option(s): ${unknown.map((name) => `--${name}`).join(", ")}.`,
    );
  }
}

export function requiredFlag(args: ParsedArguments, name: string): string {
  const value = getFlag(args, name)?.trim();
  if (!value) throw new CliUsageError(`--${name} is required.`);
  return value;
}

export function integerFlag(
  args: ParsedArguments,
  name: string,
  fallback?: number,
  range: { min?: number; max?: number } = {},
): number {
  const raw = getFlag(args, name);
  if (raw === undefined && fallback !== undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value))
    throw new CliUsageError(`--${name} must be an integer.`);
  if (range.min !== undefined && value < range.min) {
    throw new CliUsageError(`--${name} must be at least ${range.min}.`);
  }
  if (range.max !== undefined && value > range.max) {
    throw new CliUsageError(`--${name} must be at most ${range.max}.`);
  }
  return value;
}

export function enumFlag<T extends string>(
  args: ParsedArguments,
  name: string,
  values: readonly T[],
  fallback?: T,
): T {
  const raw = getFlag(args, name);
  if (raw === undefined && fallback !== undefined) return fallback;
  if (!values.includes(raw as T)) {
    throw new CliUsageError(`--${name} must be one of: ${values.join(", ")}.`);
  }
  return raw as T;
}
