import type { TerminalService } from '../TerminalService'
import type { FileTransferService } from '../FileTransferService'
import type { CommandPolicyMode } from '../CommandPolicy/CommandPolicyService'
import type { ICommandPolicyRuntime } from '../runtimeContracts'
import type {
  QueuedAgentInsertionInput,
  RunBackgroundExecCommandInput,
  RunBackgroundFileTransferInput
} from './queuedInsertions'
import type { TerminalTab } from '../../types'

export interface ToolExecutionContext {
  sessionId: string
  messageId: string
  terminalService: TerminalService
  createTerminalFromSavedConnection?: (
    connectionId: string
  ) => Promise<TerminalTab | null>
  fileTransferService?: FileTransferService
  sendEvent: (sessionId: string, event: any) => void
  waitForFeedback?: (messageId: string, timeoutMs?: number) => Promise<any | null>
  commandPolicyService: ICommandPolicyRuntime
  commandPolicyMode: CommandPolicyMode
  agentRunId?: string
  enqueueQueuedInsertion?: (insertion: QueuedAgentInsertionInput) => void
  waitForQueuedInsertion?: (signal?: AbortSignal) => Promise<boolean>
  markWaitInterruptedByQueuedInsertion?: () => void
  registerBackgroundExecCommand?: (command: RunBackgroundExecCommandInput) => void
  completeBackgroundExecCommand?: (command: RunBackgroundExecCommandInput & { exitCode?: number }) => void
  registerBackgroundFileTransfer?: (transfer: RunBackgroundFileTransferInput) => void
  completeBackgroundFileTransfer?: (transfer: RunBackgroundFileTransferInput & { status?: string; error?: string }) => void
  signal?: AbortSignal
}

export type ReadFileSupport = {
  image: boolean
}
