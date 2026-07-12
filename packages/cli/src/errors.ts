export class CliError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly exitCode: number,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "CliError";
  }
}

export class CliUsageError extends CliError {
  constructor(message: string, details?: unknown) {
    super("USAGE_ERROR", message, 2, details);
    this.name = "CliUsageError";
  }
}

export function normalizeCliError(error: unknown): CliError {
  if (error instanceof CliError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (
    /connect|socket|websocket|ECONNREFUSED|ENOTFOUND|Unauthorized/i.test(
      message,
    )
  ) {
    return new CliError("CONNECTION_ERROR", message, 3);
  }
  if (/timeout/i.test(message)) {
    return new CliError("TIMEOUT", message, 5);
  }
  return new CliError("RPC_ERROR", message, 4);
}
