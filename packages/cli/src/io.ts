import fs from "node:fs/promises";
import { CliUsageError } from "./errors";
import { getFlag, hasFlag } from "./arguments";
import type { CliIo, ParsedArguments } from "./types";

export async function readStdin(stdin: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function readTextSource(
  args: ParsedArguments,
  io: CliIo,
  options: {
    flag: string;
    fileFlag?: string;
    positional?: string[];
    label: string;
  },
): Promise<string> {
  const direct = getFlag(args, options.flag);
  const filePath = options.fileFlag
    ? getFlag(args, options.fileFlag)
    : undefined;
  const fromStdin = hasFlag(args, "stdin");
  const positional = options.positional?.join(" ").trim() || undefined;
  const selected = [
    direct !== undefined,
    filePath !== undefined,
    fromStdin,
    positional !== undefined,
  ].filter(Boolean).length;
  if (selected > 1) {
    throw new CliUsageError(
      `${options.label} must come from exactly one input source.`,
    );
  }
  if (direct !== undefined) return direct;
  if (filePath !== undefined) return await fs.readFile(filePath, "utf8");
  if (fromStdin) return await readStdin(io.stdin);
  if (positional !== undefined) return positional;
  throw new CliUsageError(`${options.label} is required.`);
}

export async function readJsonSource(
  args: ParsedArguments,
  io: CliIo,
  options: { flag: string; fileFlag: string; label: string },
): Promise<Record<string, unknown>> {
  const text = await readTextSource(args, io, {
    flag: options.flag,
    fileFlag: options.fileFlag,
    label: options.label,
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new CliUsageError(`${options.label} must be valid JSON: ${detail}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CliUsageError(`${options.label} must be a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}
