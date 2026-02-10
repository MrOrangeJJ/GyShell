export interface SelfCorrectionPendingInstruction {
  passCount: number
  instruction: string
}

interface SelfCorrectionRuntimeState {
  pendingInstruction: SelfCorrectionPendingInstruction | null
  runningControllers: Set<AbortController>
}

export class SelfCorrectionRuntimeManager {
  private runtimeBySession = new Map<string, SelfCorrectionRuntimeState>()

  private getOrCreate(sessionId: string): SelfCorrectionRuntimeState {
    const existing = this.runtimeBySession.get(sessionId)
    if (existing) return existing
    const created: SelfCorrectionRuntimeState = {
      pendingInstruction: null,
      runningControllers: new Set()
    }
    this.runtimeBySession.set(sessionId, created)
    return created
  }

  consumePendingInstruction(sessionId: string): SelfCorrectionPendingInstruction | null {
    const runtime = this.runtimeBySession.get(sessionId)
    if (!runtime?.pendingInstruction) return null
    const pending = runtime.pendingInstruction
    runtime.pendingInstruction = null
    return pending
  }

  setPendingInstruction(sessionId: string, next: SelfCorrectionPendingInstruction): void {
    const runtime = this.getOrCreate(sessionId)
    const current = runtime.pendingInstruction
    if (!current || next.passCount >= current.passCount) {
      runtime.pendingInstruction = next
    }
  }

  addController(sessionId: string, controller: AbortController): void {
    const runtime = this.getOrCreate(sessionId)
    runtime.runningControllers.add(controller)
  }

  removeController(sessionId: string, controller: AbortController): void {
    const runtime = this.runtimeBySession.get(sessionId)
    runtime?.runningControllers.delete(controller)
  }

  clearSession(sessionId: string): void {
    const runtime = this.runtimeBySession.get(sessionId)
    if (!runtime) return
    for (const controller of runtime.runningControllers) {
      controller.abort()
    }
    runtime.runningControllers.clear()
    this.runtimeBySession.delete(sessionId)
  }
}
