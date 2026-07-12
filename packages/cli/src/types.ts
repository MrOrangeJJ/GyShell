export interface CliIo {
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
  stdin: NodeJS.ReadableStream;
}

export interface CliEnvironment {
  [key: string]: string | undefined;
}

export interface CliGlobalOptions {
  url: string;
  token?: string;
  timeoutMs: number;
  pretty: boolean;
}

export interface ParsedArguments {
  positional: string[];
  flags: Map<string, string[]>;
  global: CliGlobalOptions;
}

export interface GatewayUiUpdate {
  type: string;
  sessionId?: string;
  message?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface GatewaySessionSnapshot {
  id: string;
  title: string;
  updatedAt: number;
  messages: Array<Record<string, unknown>>;
  isBusy: boolean;
  lockedProfileId: string | null;
  uiRevision?: number;
}

export interface RpcClient {
  connect(timeoutMs?: number): Promise<void>;
  request<T>(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<T>;
  onUiUpdate(listener: (update: GatewayUiUpdate) => void): () => void;
  close(): void;
}

export interface CommandResult {
  command: string;
  data: unknown;
}

export interface CliSuccessEnvelope {
  ok: true;
  command: string;
  data: unknown;
}

export interface CliErrorEnvelope {
  ok: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}
