export class ActionModelFallbackHelper {
  private fallbackBySession = new Map<string, boolean>()

  beginSession(sessionId: string): void {
    this.fallbackBySession.set(sessionId, false)
  }

  clearSession(sessionId: string): void {
    this.fallbackBySession.delete(sessionId)
  }

  isFallbackEnabled(sessionId: string): boolean {
    return this.fallbackBySession.get(sessionId) === true
  }

  async runWithSessionFallback<T>(opts: {
    sessionId: string
    invokeStructured: () => Promise<T>
    invokePseudoSchema: () => Promise<T>
    onFallbackTriggered?: (error: unknown) => void
  }): Promise<T> {
    if (this.isFallbackEnabled(opts.sessionId)) {
      return await opts.invokePseudoSchema()
    }

    try {
      return await opts.invokeStructured()
    } catch (error) {
      this.fallbackBySession.set(opts.sessionId, true)
      opts.onFallbackTriggered?.(error)
      return await opts.invokePseudoSchema()
    }
  }
}
