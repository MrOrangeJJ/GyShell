import { z } from 'zod'
import type { ToolExecutionContext } from '../types'
import {
  formatTerminalStatusHeader,
  formatTerminalUnavailableForTool,
  resolveTerminalForTool
} from './terminal_runtime_guard'

export const waitSchema = z.object({
  seconds: z.number().min(5).max(120).describe('Number of seconds to wait (5-120)')
})

export const waitTerminalIdleSchema = z.object({
  tabIdOrName: z.string().describe('The ID or Name of the terminal tab to monitor')
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

  const waitResult = await waitWithSignalOrQueuedInsertion(
    seconds * 1000,
    context.signal,
    context.waitForQueuedInsertion
  )

  if (waitResult === 'queued_insertion') {
    context.markWaitInterruptedByQueuedInsertion?.()
    const result = 'Wait ended early because a queued agent notification became available.'
    sendEvent(sessionId, {
      messageId,
      type: 'sub_tool_delta',
      outputDelta: result
    })
    sendEvent(sessionId, {
      messageId,
      type: 'sub_tool_finished'
    })
    return result
  }

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
  const resolved = resolveTerminalForTool(context, tabIdOrName)
  if (!resolved.ok) {
    return resolved.message
  }
  const bestMatch = resolved.terminal
  if (resolved.snapshot.runtimeState !== 'ready') {
    return formatTerminalUnavailableForTool(
      resolved.snapshot,
      'monitor this terminal'
    )
  }

  sendEvent(sessionId, {
    messageId,
    type: 'sub_tool_started',
    toolName: 'wait_terminal_idle',
    title: `Waiting on ${bestMatch.title || bestMatch.id}`,
    hint: ''
  })

  const finish = (result: string): string => {
    sendEvent(sessionId, {
      messageId,
      type: 'sub_tool_delta',
      outputDelta: result
    })
    sendEvent(sessionId, {
      messageId,
      type: 'sub_tool_finished'
    })
    return result
  }

  let lastContent = terminalService.getRecentOutput(bestMatch.id)
  let stableCount = 0
  const maxWaitSeconds = 120
  let elapsed = 0

  while (elapsed < maxWaitSeconds) {
    abortIfNeeded(context.signal)
    const snapshot = terminalService.getTerminalRuntimeSnapshot(bestMatch.id)
    if (!snapshot) {
      return finish(
        `Error: Terminal tab "${bestMatch.title || bestMatch.id}" was closed while it was being monitored.`
      )
    }
    if (snapshot.runtimeState !== 'ready') {
      return finish(
        formatTerminalUnavailableForTool(snapshot, 'monitor this terminal')
      )
    }
    const currentContent = terminalService.getRecentOutput(bestMatch.id)

    if (snapshot.canRunCommand) {
      return finish(
        `The terminal is at a verified idle prompt.\n${formatTerminalStatusHeader(snapshot)}\n<terminal_content>\n${currentContent}\n</terminal_content>`
      )
    }

    if (currentContent === lastContent) {
      stableCount++
    } else {
      stableCount = 0
      lastContent = currentContent
    }

    if (stableCount >= 4) {
      const stableSnapshot = terminalService.getTerminalRuntimeSnapshot(bestMatch.id)
      if (!stableSnapshot) {
        return finish(
          `Error: Terminal tab "${bestMatch.title || bestMatch.id}" was closed while it was being monitored.`
        )
      }
      const finalOutput = terminalService.getRecentOutput(bestMatch.id)
      const successMsg = `The terminal output has remained unchanged for several seconds, but the shell is still busy. Output stability does not prove that the running command completed; do not start another command in this terminal.\n${formatTerminalStatusHeader(stableSnapshot)}\nThe following is the current visible state of the terminal tab "${bestMatch.title || bestMatch.id}":
<terminal_content>
${finalOutput}
</terminal_content>`
      return finish(successMsg)
    }

    const waitResult = await waitWithSignalOrQueuedInsertion(
      1000,
      context.signal,
      context.waitForQueuedInsertion
    )
    if (waitResult === 'queued_insertion') {
      context.markWaitInterruptedByQueuedInsertion?.()
      return finish(
        'Terminal monitoring ended early because a queued agent notification became available.'
      )
    }
    elapsed++
  }

  const currentOutput = terminalService.getRecentOutput(bestMatch.id)
  const finalSnapshot = terminalService.getTerminalRuntimeSnapshot(bestMatch.id)
  const timeoutMsg = `Wait timeout: the terminal did not reach a verified idle prompt within 120 seconds. Continue monitoring, inspect the running command, or interrupt it with write_stdin sequence ["CTRL_C"].${finalSnapshot ? `\n${formatTerminalStatusHeader(finalSnapshot)}` : ''}\nThe following is the current visible state of the terminal tab "${bestMatch.title || bestMatch.id}":
<terminal_content>
${currentOutput}
</terminal_content>`
  return finish(timeoutMsg)
}

function abortIfNeeded(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error('AbortError')
  }
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

function waitWithSignalOrQueuedInsertion(
  ms: number,
  signal: AbortSignal | undefined,
  waitForQueuedInsertion?: (signal?: AbortSignal) => Promise<boolean>
): Promise<'timer' | 'queued_insertion'> {
  if (!waitForQueuedInsertion) {
    return waitWithSignal(ms, signal).then(() => 'timer' as const)
  }

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('AbortError'))
      return
    }

    let settled = false
    const queuedInsertionController = new AbortController()
    const timer = setTimeout(() => {
      finish('timer')
    }, ms)

    function cleanup() {
      clearTimeout(timer)
      queuedInsertionController.abort()
      signal?.removeEventListener('abort', onAbort)
    }
    function finish(reason: 'timer' | 'queued_insertion') {
      if (settled) return
      settled = true
      cleanup()
      resolve(reason)
    }
    function fail(error: Error) {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    function onAbort() {
      fail(new Error('AbortError'))
    }

    signal?.addEventListener('abort', onAbort, { once: true })
    waitForQueuedInsertion(queuedInsertionController.signal)
      .then((available) => {
        if (available) {
          finish('queued_insertion')
        }
      })
      .catch((error) => {
        if (settled || queuedInsertionController.signal.aborted) return
        fail(error instanceof Error ? error : new Error(String(error)))
      })
  })
}
