import type { TerminalService } from '../TerminalService'
import type { CommandPolicyService, CommandPolicyMode } from '../CommandPolicy/CommandPolicyService'

export interface ToolExecutionContext {
  sessionId: string
  messageId: string
  terminalService: TerminalService
  sendEvent: (sessionId: string, event: any) => void
  waitForFeedback?: (messageId: string, timeoutMs?: number) => Promise<any | null>
  commandPolicyService: CommandPolicyService
  commandPolicyMode: CommandPolicyMode
  signal?: AbortSignal
}

export type ReadFileSupport = {
  image: boolean
}
