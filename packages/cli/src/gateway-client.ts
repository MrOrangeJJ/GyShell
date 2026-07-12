import WebSocket, { type RawData } from "ws";
import { CliError } from "./errors";
import type { GatewayUiUpdate, RpcClient } from "./types";

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

interface GatewayEnvelope {
  type?: string;
  id?: string;
  ok?: boolean;
  result?: unknown;
  error?: { code?: string; message?: string };
  payload?: unknown;
}

export class GatewayClient implements RpcClient {
  private socket: WebSocket | null = null;
  private nextRequestId = 1;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly uiListeners = new Set<(update: GatewayUiUpdate) => void>();

  constructor(
    private readonly url: string,
    private readonly accessToken?: string,
    private readonly defaultTimeoutMs = 15_000,
  ) {}

  async connect(timeoutMs = this.defaultTimeoutMs): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) return;
    await new Promise<void>((resolve, reject) => {
      const headers: Record<string, string> = {};
      const token = this.accessToken?.trim();
      if (token) headers.authorization = `Bearer ${token}`;

      let socket: WebSocket;
      try {
        socket = new WebSocket(this.url, { headers });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        reject(
          new CliError(
            "CONNECTION_ERROR",
            `Unable to connect to ${sanitizeGatewayUrl(this.url)}: ${sanitizeGatewayText(detail)}`,
            3,
          ),
        );
        return;
      }
      this.socket = socket;
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.terminate();
        reject(
          new CliError(
            "CONNECTION_TIMEOUT",
            `Connection timeout (${timeoutMs}ms): ${sanitizeGatewayUrl(this.url)}`,
            3,
          ),
        );
      }, timeoutMs);

      socket.on("message", (raw) => this.handleMessage(raw));
      socket.once("open", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      });
      socket.on("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(
          new CliError(
            "CONNECTION_ERROR",
            `Unable to connect to ${sanitizeGatewayUrl(this.url)}: ${sanitizeGatewayText(error.message)}`,
            3,
          ),
        );
      });
      socket.on("close", (code, reason) => {
        clearTimeout(timer);
        const detail = reason.toString().trim();
        const error = new Error(
          `Gateway socket closed (${code})${detail ? `: ${detail}` : ""}`,
        );
        this.rejectPending(error);
        this.socket = null;
        if (!settled) {
          settled = true;
          reject(new CliError("CONNECTION_ERROR", error.message, 3));
        }
      });
    });
  }

  async request<T>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = this.defaultTimeoutMs,
  ): Promise<T> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new CliError(
        "NOT_CONNECTED",
        "Gateway socket is not connected.",
        3,
      );
    }
    const id = String(this.nextRequestId++);
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new CliError(
            "RPC_TIMEOUT",
            `RPC timeout (${timeoutMs}ms): ${method}`,
            5,
          ),
        );
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      try {
        socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  onUiUpdate(listener: (update: GatewayUiUpdate) => void): () => void {
    this.uiListeners.add(listener);
    return () => this.uiListeners.delete(listener);
  }

  close(): void {
    const socket = this.socket;
    this.socket = null;
    this.rejectPending(new Error("Gateway client closed."));
    if (!socket) return;
    try {
      socket.close();
    } catch {
      socket.terminate();
    }
  }

  private handleMessage(raw: RawData): void {
    let envelope: GatewayEnvelope;
    try {
      envelope = JSON.parse(raw.toString("utf8")) as GatewayEnvelope;
    } catch {
      return;
    }
    if (envelope.type === "gateway:response" && envelope.id) {
      const pending = this.pending.get(String(envelope.id));
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(String(envelope.id));
      if (envelope.ok) {
        pending.resolve(envelope.result);
      } else {
        const code = envelope.error?.code || "RPC_ERROR";
        const message = envelope.error?.message || "Gateway RPC failed.";
        pending.reject(new CliError(code, `${code}: ${message}`, 4));
      }
      return;
    }
    if (
      envelope.type === "gateway:ui-update" &&
      envelope.payload &&
      typeof envelope.payload === "object"
    ) {
      const update = envelope.payload as GatewayUiUpdate;
      this.uiListeners.forEach((listener) => listener(update));
    }
  }

  private rejectPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

export function sanitizeGatewayUrl(raw: string): string {
  try {
    const parsed = new URL(raw);
    if (parsed.username) parsed.username = "[REDACTED]";
    if (parsed.password) parsed.password = "[REDACTED]";
    for (const key of [...parsed.searchParams.keys()]) {
      if (/(token|key|secret|password)/i.test(key)) {
        parsed.searchParams.set(key, "[REDACTED]");
      }
    }
    return parsed.toString();
  } catch {
    return sanitizeGatewayText(raw);
  }
}

function sanitizeGatewayText(raw: string): string {
  return raw
    .replace(/([?&](?:access_)?token=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/([?&](?:api_?)?key=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/([?&](?:secret|password)=)[^&\s]+/gi, "$1[REDACTED]");
}
