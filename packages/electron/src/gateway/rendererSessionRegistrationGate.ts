export type RendererSessionRegistrationOperation = "register" | "unregister";

export type RendererSessionRegistrationHandler<TEvent> = (
  event: TEvent,
  operation: RendererSessionRegistrationOperation,
  sessionId: string,
) => void | Promise<void>;

interface PendingRegistration<TEvent> {
  event: TEvent;
  operation: RendererSessionRegistrationOperation;
  sessionId: string;
  resolve: () => void;
  reject: (error: unknown) => void;
}

/**
 * Bridges the short interval between renderer creation and backend IPC setup.
 *
 * ChatStore creates its initial session while the renderer module is being
 * evaluated, whereas the full Electron gateway is intentionally initialized
 * after history migration and terminal restore. Keeping this gate independent
 * of the gateway lets the main process install the IPC contract immediately
 * without constructing backend services early or dropping ownership requests.
 */
export class RendererSessionRegistrationGate<TEvent> {
  private handler: RendererSessionRegistrationHandler<TEvent> | null = null;
  private failure: Error | null = null;
  private pending: Array<PendingRegistration<TEvent>> = [];
  private executionChain: Promise<void> = Promise.resolve();

  dispatch(
    event: TEvent,
    operation: RendererSessionRegistrationOperation,
    sessionId: string,
  ): Promise<void> {
    const normalizedSessionId = String(sessionId || "").trim();
    if (!normalizedSessionId) {
      return Promise.reject(new Error("Session id is required."));
    }
    if (this.failure) {
      return Promise.reject(this.failure);
    }
    if (this.handler) {
      return this.enqueue({ event, operation, sessionId: normalizedSessionId });
    }

    return new Promise<void>((resolve, reject) => {
      this.pending.push({
        event,
        operation,
        sessionId: normalizedSessionId,
        resolve,
        reject,
      });
    });
  }

  setHandler(handler: RendererSessionRegistrationHandler<TEvent>): void {
    if (this.failure) {
      throw this.failure;
    }
    if (this.handler) {
      throw new Error("Renderer session registration handler is already set.");
    }
    this.handler = handler;
    const pending = this.pending.splice(0);
    pending.forEach((request) => {
      const operation = this.enqueue(request);
      operation.then(request.resolve, request.reject);
    });
  }

  fail(error: unknown): void {
    if (this.handler || this.failure) return;
    this.failure =
      error instanceof Error
        ? error
        : new Error(String(error || "Renderer session registration unavailable."));
    const pending = this.pending.splice(0);
    pending.forEach((request) => request.reject(this.failure));
  }

  private enqueue(request: {
    event: TEvent;
    operation: RendererSessionRegistrationOperation;
    sessionId: string;
  }): Promise<void> {
    const operation = this.executionChain.then(async () => {
      if (!this.handler) {
        throw this.failure || new Error("Renderer session handler is unavailable.");
      }
      await this.handler(request.event, request.operation, request.sessionId);
    });
    // A failed request must not prevent a later unregister/register from being
    // processed. The individual caller still receives the original rejection.
    this.executionChain = operation.catch(() => undefined);
    return operation;
  }
}
