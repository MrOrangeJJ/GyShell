import { z } from 'zod'
import type { ToolExecutionContext } from '../types'
import { truncateCommandOutput } from './terminal_tools'

export const waitSchema = z.object({
  seconds: z.number().min(5).max(60).describe('Number of seconds to wait (5-60)')
})

export const waitTerminalIdleSchema = z.object({
  tabIdOrName: z.string().describe('The ID or Name of the terminal tab to monitor')
})

export const waitCommandEndSchema = z.object({
  tabIdOrName: z.string().describe('The ID or Name of the terminal tab to wait for the current command to end')
})

export async function wait(args: z.infer<typeof waitSchema>, context: ToolExecutionContext): Promise<string> {
  const { sessionId, messageId, sendEvent } = context
  const { seconds } = args

  sendEvent(sessionId, {
    messageId,
    type: 'sub_tool_started',
    title: 'Wait',
    hint: `Waiting for ${seconds}s...`,
    input: JSON.stringify(args)
  })

  await waitWithSignal(seconds * 1000, context.signal)

  const result = `Waited for ${seconds} seconds.`
  sendEvent(sessionId, {
    messageId,
    type: 'sub_tool_finished'
  })
  return result
}

export async function waitTerminalIdle(
  args: z.infer<typeof waitTerminalIdleSchema>,
  context: ToolExecutionContext
): Promise<string> {
  const { tabIdOrName } = args
  const { terminalService, sessionId, messageId, sendEvent } = context

  abortIfNeeded(context.signal)
  const { found, bestMatch } = terminalService.resolveTerminal(tabIdOrName)
  if (!bestMatch) {
    return found.length > 1
      ? `Error: Multiple terminal tabs found with name "${tabIdOrName}".`
      : `Error: Terminal tab "${tabIdOrName}" not found.`
  }

  sendEvent(sessionId, {
    messageId,
    type: 'sub_tool_started',
    toolName: 'wait_terminal_idle',
    title: `Waiting on ${bestMatch.title || bestMatch.id}`,
    hint: ''
  })

  let lastContent = ''
  let stableCount = 0
  const maxWaitSeconds = 120
  let elapsed = 0

  while (elapsed < maxWaitSeconds) {
    abortIfNeeded(context.signal)
    const currentContent = terminalService.getRecentOutput(bestMatch.id)

    if (currentContent === lastContent && currentContent !== '') {
      stableCount++
    } else {
      stableCount = 0
      lastContent = currentContent
    }

    if (stableCount >= 4) {
      const finalOutput = terminalService.getRecentOutput(bestMatch.id)
      const successMsg = `The terminal has stabilized. The following is the current visible state of the terminal tab "${bestMatch.title || bestMatch.id}":
================================================================================
<terminal_content>
${finalOutput}
</terminal_content>
================================================================================`
      sendEvent(sessionId, {
        messageId,
        type: 'sub_tool_delta',
        outputDelta: successMsg
      })
      sendEvent(sessionId, {
        messageId,
        type: 'sub_tool_finished'
      })
      return successMsg
    }

    await waitWithSignal(1000, context.signal)
    elapsed++
  }

  const currentOutput = terminalService.getRecentOutput(bestMatch.id)
  const timeoutMsg = `Wait timeout: The terminal has been running for over 120s and is still not idle. Please check if the task is still running correctly. If you need to continue waiting, run this tool again. If you need to stop it, use write_stdin (e.g., Ctrl+C). The following is the current visible state of the terminal tab "${bestMatch.title || bestMatch.id}":
================================================================================
<terminal_content>
${currentOutput}
</terminal_content>
================================================================================`
  sendEvent(sessionId, {
    messageId,
    type: 'sub_tool_delta',
    outputDelta: timeoutMsg
  })

  sendEvent(sessionId, {
    messageId,
    type: 'sub_tool_finished'
  })

  return timeoutMsg
}

export async function waitCommandEnd(
  args: z.infer<typeof waitCommandEndSchema>,
  context: ToolExecutionContext
): Promise<string> {
  const { tabIdOrName } = args
  const { terminalService, sessionId, messageId, sendEvent } = context

  abortIfNeeded(context.signal)
  const { found, bestMatch } = terminalService.resolveTerminal(tabIdOrName)
  if (!bestMatch) {
    return found.length > 1
      ? `Error: Multiple terminal tabs found with name "${tabIdOrName}".`
      : `Error: Terminal tab "${tabIdOrName}" not found.`
  }

  const taskId = terminalService.getActiveTaskId(bestMatch.id)
  if (!taskId) {
    return `No running command found in terminal tab "${bestMatch.title || bestMatch.id}".`
  }

  sendEvent(sessionId, {
    messageId,
    type: 'sub_tool_started',
    toolName: 'wait_command_end',
    title: `Waiting for command to end in ${bestMatch.title || bestMatch.id}`,
    hint: ''
  })

  try {
    let userSkipped = false
    const gateway = (global as any).gateway
    if (gateway) {
      gateway.waitForFeedback(messageId).then((payload: any) => {
        if (payload?.type === 'SKIP_WAIT') {
          userSkipped = true
        }
      })
    }

    const result = await terminalService.waitForTask(bestMatch.id, taskId, {
      signal: context.signal,
      interruptOnAbort: false,
      shouldSkip: () => userSkipped
    })

    const task = terminalService.getCommandTask(bestMatch.id, taskId)
    const commandName = task?.command || 'Unknown command'
    const historyCommandMatchId = result.history_command_match_id
    const truncatedOutput = truncateCommandOutput(result.stdoutDelta || '', historyCommandMatchId, bestMatch.id)

    let finalResult = ''
    if (result.exitCode === -3 || result.stdoutDelta === 'USER_SKIPPED_WAIT') {
      finalResult = `The user has chosen to run the command "${commandName}" asynchronously. The command is currently running in the background. You can use read_command_output to check its progress if needed. history_command_match_id=${historyCommandMatchId}, terminalId=${bestMatch.id}`

      sendEvent(sessionId, {
        messageId,
        type: 'command_finished',
        command: commandName,
        commandId: messageId,
        tabName: bestMatch.title || bestMatch.id,
        exitCode: result.exitCode,
        outputDelta: finalResult,
        isNowait: true
      })
      return finalResult
    } else if (result.exitCode === -1 && result.stdoutDelta?.includes('timed out')) {
      finalResult = `The command "${commandName}" is still running, but the wait has timed out (120s). You can use read_command_output to check its current progress, or call wait_command_end again if you believe it needs more time to finish. history_command_match_id=${historyCommandMatchId}, terminalId=${bestMatch.id}`
    } else {
      finalResult = `The command "${commandName}" has finished executing. The following is the output (history_command_match_id=${historyCommandMatchId}):
================================================================================
<terminal_content>
${truncatedOutput}
</terminal_content>
================================================================================`
    }

    sendEvent(sessionId, {
      messageId,
      type: 'sub_tool_delta',
      outputDelta: finalResult
    })

    sendEvent(sessionId, {
      messageId,
      type: 'sub_tool_finished'
    })

    return finalResult
  } catch (error) {
    if (isAbortError(error)) throw error
    const errorMessage = error instanceof Error ? error.message : String(error)

    sendEvent(sessionId, {
      messageId,
      type: 'sub_tool_delta',
      outputDelta: errorMessage
    })

    sendEvent(sessionId, {
      messageId,
      type: 'sub_tool_finished'
    })

    return errorMessage
  }
}

function abortIfNeeded(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error('AbortError')
  }
}

function isAbortError(error: unknown): boolean {
  if (!error) return false
  if (error instanceof Error) {
    return error.name === 'AbortError' || error.message === 'AbortError'
  }
  return false
}

function waitWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('AbortError'))
      return
    }
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
    const onAbort = () => {
      cleanup()
      reject(new Error('AbortError'))
    }
    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
