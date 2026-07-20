import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  AIMessage,
  HumanMessage,
  ToolMessage,
  mapChatMessagesToStoredMessages,
  mapStoredMessagesToChatMessages
} from '@langchain/core/messages'
import { AgentService_v2 } from '../AgentService_v2'
import { ChatHistoryService } from '../ChatHistoryService'
import { HistorySqliteStore } from '../history/HistorySqliteStore'
import { toolImplementations } from './tools'
import {
  formatInitialCommandOutput,
  parseCommandOutputEnvelopeContract
} from './tools/command_output_contract'
import { expireUnbackedStoredCommandOutputEnvelopes } from './utils/model_messages'
import type { CommandExecutionState } from '@gyshell/shared'

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
)

function commandEnvelope(
  executionState: CommandExecutionState,
  options: {
    terminalId?: string
    historyCommandMatchId?: string
    output?: string
    revision?: number
  } = {}
): string {
  const terminalId = options.terminalId || 'local-terminal'
  const historyCommandMatchId =
    options.historyCommandMatchId || 'background-task'
  const output = options.output || ''
  const outputBytes = Buffer.byteLength(output, 'utf8')
  return formatInitialCommandOutput({
    terminalId,
    historyCommandMatchId,
    executionState,
    ...(executionState === 'finished' ? { exitCode: 0 } : {}),
    output,
    capture: {
      state: executionState === 'running' ? 'in_progress' : 'complete',
      observedUtf8Bytes: outputBytes,
      retainedUtf8Bytes: outputBytes,
      availableLineCount: output ? output.split('\n').length : 0,
      revision: options.revision ?? (executionState === 'running' ? 0 : 1),
      terminalControlsObserved: false
    }
  }).text
}

function toolHistoryFixture(content: string, messageId = 'exec-message') {
  const assistant = new AIMessage({
    content: '',
    tool_calls: [
      {
        id: 'exec-call',
        name: 'exec_command',
        args: {
          tabIdOrName: 'local-terminal',
          command: 'printf durable',
          waitMode: 'nowait'
        }
      }
    ]
  })
  ;(assistant as any).additional_kwargs = {
    _gyshellMessageId: 'exec-assistant'
  }
  const tool = new ToolMessage({
    content,
    tool_call_id: 'exec-call',
    name: 'exec_command'
  })
  ;(tool as any).additional_kwargs = { _gyshellMessageId: messageId }
  return { assistant, tool }
}

async function runCase(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    console.log(`ok - ${name}`)
  } catch (error) {
    console.error(`not ok - ${name}`)
    throw error
  }
}

function createTerminalRuntime() {
  const terminal = {
    id: 'local-terminal',
    title: 'Local',
    type: 'local',
    runtimeState: 'ready',
    capabilities: { supportsFilesystem: true }
  }
  return {
    resolveTerminal(reference: string) {
      return reference === terminal.id || reference === terminal.title
        ? { found: [terminal], bestMatch: terminal }
        : { found: [] }
    },
    getTransferMachineIdentity() {
      return 'local://default'
    },
    getRecentOutput() {
      return ''
    },
    getActiveTaskId() {
      return undefined
    },
    getTerminalRuntimeSnapshot(terminalId: string) {
      if (terminalId !== terminal.id) return null
      return {
        ...terminal,
        isInitializing: false,
        reconnectable: false,
        canRunCommand: true,
        canWrite: true,
        canUseFilesystem: true
      }
    },
    async statFile(_terminalId: string, filePath: string) {
      return {
        exists: filePath === '/tmp/pixel.png',
        isDirectory: false,
        isFile: true,
        size: PNG_1X1.length
      }
    },
    async readFile() {
      return PNG_1X1
    }
  }
}

function createAgent(input?: {
  invokeMcp?: (name: string, args: unknown, signal?: AbortSignal) => Promise<unknown>
  mcpToolNames?: string[]
  isMcpReadOnly?: () => boolean
  loadSession?: (sessionId: string) => any
  saveSession?: (session: any) => void
  onEvent?: (event: any) => void
  terminalRuntime?: any
  chatHistoryRuntime?: any
}) {
  const mcpToolNames = new Set(input?.mcpToolNames || [])
  const chatHistoryRuntime = {
    saveSession: input?.saveSession || (() => {}),
    loadSession: input?.loadSession || (() => null),
    getAllSessions: () => [],
    getAllSessionSummaries: () => []
  }
  const mcpRuntime = {
    isMcpToolName: (name: string) => mcpToolNames.has(name),
    getActiveTools: () =>
      [...mcpToolNames].map((name) => ({
        name,
        metadata: { annotations: { readOnlyHint: input?.isMcpReadOnly?.() ?? true } }
      })),
    invokeTool: input?.invokeMcp || (async () => 'ok')
  }
  const agent = new AgentService_v2(
    (input?.terminalRuntime || createTerminalRuntime()) as any,
    {} as any,
    mcpRuntime as any,
    {} as any,
    {} as any,
    { flush() {} } as any,
    (input?.chatHistoryRuntime || chatHistoryRuntime) as any
  )
  agent.setEventPublisher((_sessionId, event) => input?.onEvent?.(event))
  return agent
}

await runCase(
  'parallel MCP reads settle concurrently but commit results in model ordinal order',
  async () => {
    let active = 0
    let maximumActive = 0
    const delays: Record<string, number> = { mcp_slow: 45, mcp_fast: 5 }
    const agent = createAgent({
      mcpToolNames: ['mcp_slow', 'mcp_fast', 'mcp_error'],
      invokeMcp: async (name) => {
        active += 1
        maximumActive = Math.max(maximumActive, active)
        try {
          await new Promise((resolve) => setTimeout(resolve, delays[name] ?? 15))
          if (name === 'mcp_error') throw new Error('probe failure')
          return `${name}-result`
        } finally {
          active -= 1
        }
      }
    })
    const toolCalls = [
      { id: 'slow', name: 'mcp_slow', args: {} },
      { id: 'fast', name: 'mcp_fast', args: {} },
      { id: 'error', name: 'mcp_error', args: {} }
    ]
    const source = new AIMessage({ content: '', tool_calls: toolCalls })
    const batch = await (agent as any).createBatchToolcallExecutorNode().invoke({
      sessionId: 'parallel-mcp',
      messages: [source]
    })

    const result = await (agent as any).createParallelToolsNode().invoke({
      ...batch,
      pendingToolSupplementMessages: []
    })
    const results = result.messages.slice(1) as ToolMessage[]

    assert.equal(maximumActive, 3)
    assert.deepEqual(
      results.map((message) => message.tool_call_id),
      ['slow', 'fast', 'error']
    )
    assert.equal(String(results[0].content), 'mcp_slow-result')
    assert.equal(String(results[1].content), 'mcp_fast-result')
    assert.equal(String(results[2].content), 'probe failure')
    assert.equal(result.pendingToolCalls.length, 0)
  }
)

await runCase('valid opaque call ids match source and result byte-for-byte', async () => {
  const agent = createAgent({ mcpToolNames: ['mcp_lookup'] })
  const source = new AIMessage({
    content: '',
    tool_calls: [{ id: ' call-with-spaces ', name: 'mcp_lookup', args: {} }]
  })
  const batch = await (agent as any).createBatchToolcallExecutorNode().invoke({
    sessionId: 'opaque-id',
    messages: [source]
  })
  const result = await (agent as any).createMcpToolsNode().invoke(batch)

  assert.equal(source.tool_calls?.[0].id, ' call-with-spaces ')
  assert.equal(batch.pendingToolCalls[0].id, ' call-with-spaces ')
  assert.equal((result.messages[1] as ToolMessage).tool_call_id, ' call-with-spaces ')
})

await runCase('runtime disable and MCP annotation drift break a parallel wave before dispatch', async () => {
  let mcpReadOnly = true
  const agent = createAgent({
    mcpToolNames: ['mcp_lookup'],
    isMcpReadOnly: () => mcpReadOnly
  })
  const source = new AIMessage({
    content: '',
    tool_calls: [
      {
        id: 'file',
        name: 'read_file',
        args: { tabIdOrName: 'local-terminal', filePath: '/tmp/pixel.png' }
      },
      { id: 'lookup', name: 'mcp_lookup', args: {} }
    ]
  })
  const batch = await (agent as any).createBatchToolcallExecutorNode().invoke({
    sessionId: 'runtime-drift',
    messages: [source]
  })
  mcpReadOnly = false
  const result = await (agent as any)
    .createParallelToolsNode()
    .invoke({ ...batch, pendingToolSupplementMessages: [] })

  assert.equal(result.messages.length, 1)
  assert.equal(
    result.pendingToolCalls.every(
      (call: any) => call._gyshellExecution.parallelGroupId === undefined
    ),
    true
  )

  ;(agent as any).builtInToolEnabled.read_file = false
  assert.equal((agent as any).routeAfterToolCall(result), 'tools')
  assert.equal(result.pendingToolCalls[0]._gyshellExecution.mode, 'not_executed')
})

await runCase('any rejected parallel command has an unknown non-retryable outcome', async () => {
  const agent = createAgent()
  ;(agent as any).createToolBatchPlanningEnvironment = () => ({
    isToolEnabled: () => true,
    isMcpTool: () => false,
    isMcpToolReadOnly: () => false,
    resolveTerminalId: (reference: string) => reference,
    resolveMachineId: (reference: string) => `machine-${reference}`,
    createParallelGroupId: () => 'parallel'
  })
  ;(agent as any).getSingleToolNode = () => ({
    invoke: async () => {
      throw new Error('post-dispatch adapter failure')
    }
  })
  const calls = ['one', 'two'].map((reference, ordinal) => ({
    id: reference,
    name: 'exec_command',
    args: { tabIdOrName: reference, command: reference },
    _gyshellExecution: {
      ordinal,
      mode: 'execute',
      parallelGroupId: 'parallel'
    }
  }))
  const result = await (agent as any).createParallelToolsNode().invoke({
    sessionId: 'command-rejection',
    messages: [new AIMessage({ content: '', tool_calls: calls })],
    pendingToolCalls: calls,
    pendingToolSupplementMessages: []
  })

  for (const message of result.messages.slice(1) as ToolMessage[]) {
    assert.deepEqual(JSON.parse(String(message.content)), {
      status: 'unknown_outcome',
      reason:
        'The cross-machine command executor rejected without a definitive pre-dispatch result. Its external outcome is unknown and it must not be replayed automatically.',
      retryable: false
    })
  }
})

await runCase('a wait command switched to background defers its same-terminal tail', async () => {
  const agent = createAgent()
  const originalRunCommand = toolImplementations.runCommand
  ;(toolImplementations as any).runCommand = async (
    _args: unknown,
    _context: unknown,
    options: { onContinuesInBackground?: () => void }
  ) => {
    options.onContinuesInBackground?.()
    return 'running in background'
  }
  try {
    const source = new AIMessage({
      content: '',
      tool_calls: [
        {
          id: 'command',
          name: 'exec_command',
          args: {
            tabIdOrName: 'local-terminal',
            command: 'server',
            waitMode: 'wait'
          }
        },
        {
          id: 'edit',
          name: 'edit_file',
          args: { tabIdOrName: 'local-terminal', filePath: '/tmp/a', patch: 'x' }
        }
      ]
    })
    const batch = await (agent as any).createBatchToolcallExecutorNode().invoke({
      sessionId: 'runtime-background-boundary',
      messages: [source]
    })
    const result = await (agent as any).createCommandToolsNode().invoke({
      ...batch,
      execCommandActionModelEnabled: false
    })

    assert.equal(result.pendingToolCalls[0].id, 'edit')
    assert.equal(
      result.pendingToolCalls[0]._gyshellExecution.mode,
      'not_executed'
    )
  } finally {
    ;(toolImplementations as any).runCommand = originalRunCommand
  }
})

await runCase('a terminal exit during wait defers its same-terminal tail', async () => {
  const agent = createAgent()
  const originalRunCommand = toolImplementations.runCommand
  ;(toolImplementations as any).runCommand = async (
    _args: unknown,
    _context: unknown,
    options: { onRuntimeBoundary?: () => void }
  ) => {
    options.onRuntimeBoundary?.()
    return 'terminal runtime exited; command outcome unknown'
  }
  try {
    const source = new AIMessage({
      content: '',
      tool_calls: [
        {
          id: 'command',
          name: 'exec_command',
          args: {
            tabIdOrName: 'local-terminal',
            command: 'may-have-run',
            waitMode: 'wait'
          }
        },
        {
          id: 'edit',
          name: 'edit_file',
          args: {
            tabIdOrName: 'local-terminal',
            filePath: '/tmp/a',
            oldString: 'a',
            newString: 'b'
          }
        }
      ]
    })
    const batch = await (agent as any).createBatchToolcallExecutorNode().invoke({
      sessionId: 'runtime-terminal-exit-boundary',
      messages: [source]
    })
    const result = await (agent as any).createCommandToolsNode().invoke({
      ...batch,
      execCommandActionModelEnabled: false
    })

    assert.equal(result.pendingToolCalls[0].id, 'edit')
    assert.equal(
      result.pendingToolCalls[0]._gyshellExecution.mode,
      'not_executed'
    )
  } finally {
    ;(toolImplementations as any).runCommand = originalRunCommand
  }
})

await runCase('a parallel command switched to background defers its parent-batch tail', async () => {
  const terminals = ['A', 'B'].map((id) => ({
    id,
    title: id,
    type: 'local',
    runtimeState: 'ready',
    capabilities: { supportsFilesystem: true }
  }))
  const terminalRuntime = {
    resolveTerminal(reference: string) {
      const terminal = terminals.find(
        (candidate) => candidate.id === reference || candidate.title === reference
      )
      return terminal
        ? { found: [terminal], bestMatch: terminal }
        : { found: [] }
    },
    getTransferMachineIdentity(terminalId: string) {
      return `machine://${terminalId}`
    },
    getTerminalRuntimeSnapshot(terminalId: string) {
      const terminal = terminals.find((candidate) => candidate.id === terminalId)
      return terminal
        ? {
            ...terminal,
            isInitializing: false,
            reconnectable: false,
            canRunCommand: true,
            canWrite: true,
            canUseFilesystem: true
          }
        : null
    },
    getRecentOutput() {
      return ''
    }
  }
  const agent = createAgent({ terminalRuntime })
  const originalRunCommand = toolImplementations.runCommand
  ;(toolImplementations as any).runCommand = async (
    args: { tabIdOrName: string },
    _context: unknown,
    options: { onContinuesInBackground?: () => void }
  ) => {
    if (args.tabIdOrName === 'A') options.onContinuesInBackground?.()
    return `${args.tabIdOrName} result`
  }
  try {
    const source = new AIMessage({
      content: '',
      tool_calls: [
        {
          id: 'command-a',
          name: 'exec_command',
          args: { tabIdOrName: 'A', command: 'server', waitMode: 'wait' }
        },
        {
          id: 'command-b',
          name: 'exec_command',
          args: { tabIdOrName: 'B', command: 'check', waitMode: 'wait' }
        },
        {
          id: 'edit-a',
          name: 'edit_file',
          args: { tabIdOrName: 'A', filePath: '/tmp/a', oldString: 'a', newString: 'b' }
        }
      ]
    })
    const batch = await (agent as any).createBatchToolcallExecutorNode().invoke({
      sessionId: 'parallel-runtime-boundary',
      messages: [source]
    })
    assert.equal(batch.pendingToolCalls[2]._gyshellExecution.mode, 'execute')

    const result = await (agent as any).createParallelToolsNode().invoke({
      ...batch,
      execCommandActionModelEnabled: false,
      pendingToolSupplementMessages: []
    })
    assert.equal(result.pendingToolCalls[0].id, 'edit-a')
    assert.equal(
      result.pendingToolCalls[0]._gyshellExecution.mode,
      'not_executed'
    )
  } finally {
    ;(toolImplementations as any).runCommand = originalRunCommand
  }
})

await runCase('an existing active terminal task defers the preserved mutation tail', async () => {
  const terminalRuntime = {
    ...createTerminalRuntime(),
    getActiveTaskId() {
      return 'already-running'
    }
  }
  const agent = createAgent({ terminalRuntime })
  const originalRunCommand = toolImplementations.runCommand
  ;(toolImplementations as any).runCommand = async () =>
    'Error: There is a running exec_command in the terminal tab.'
  try {
    const source = new AIMessage({
      content: '',
      tool_calls: [
        {
          id: 'blocked-command',
          name: 'exec_command',
          args: {
            tabIdOrName: 'local-terminal',
            command: 'next',
            waitMode: 'wait'
          }
        },
        {
          id: 'unsafe-edit',
          name: 'edit_file',
          args: { tabIdOrName: 'local-terminal', filePath: '/tmp/a' }
        }
      ]
    })
    const batch = await (agent as any).createBatchToolcallExecutorNode().invoke({
      sessionId: 'existing-active-task',
      messages: [source]
    })
    const result = await (agent as any).createCommandToolsNode().invoke({
      ...batch,
      execCommandActionModelEnabled: false
    })
    assert.equal(
      result.pendingToolCalls[0]._gyshellExecution.mode,
      'not_executed'
    )
  } finally {
    ;(toolImplementations as any).runCommand = originalRunCommand
  }
})

await runCase('a malformed blank-name call is preserved and explicitly completed', async () => {
  const agent = createAgent()
  const source = new AIMessage({
    content: '',
    tool_calls: [{ id: 'blank-name', name: '', args: {} }]
  })
  const batch = await (agent as any).createBatchToolcallExecutorNode().invoke({
    sessionId: 'blank-name',
    messages: [source]
  })
  assert.equal((agent as any).routeModelOutput(batch), 'tools')
  const result = await (agent as any).createToolsNode().invoke(batch)

  assert.equal(source.tool_calls?.[0].id, 'blank-name')
  assert.equal(source.tool_calls?.[0].name, 'gyshell_invalid_tool_call')
  assert.equal((result.messages[1] as ToolMessage).tool_call_id, 'blank-name')
  assert.equal(JSON.parse(String(result.messages[1].content)).status, 'not_executed')
})

await runCase('invalid streamed calls retain their IDs and receive explicit error results', async () => {
  const agent = createAgent()
  const source = new AIMessage({
    content: '',
    tool_calls: [],
    invalid_tool_calls: [
      {
        id: 'invalid-stream-call',
        name: 'read_file',
        args: '{"filePath":',
        error: 'Malformed JSON',
        type: 'invalid_tool_call'
      }
    ]
  } as any)
  const batch = await (agent as any).createBatchToolcallExecutorNode().invoke({
    sessionId: 'invalid-stream-call',
    messages: [source]
  })

  assert.equal(source.invalid_tool_calls?.length, 0)
  assert.equal(source.tool_calls?.length, 1)
  assert.equal(source.tool_calls?.[0].id, 'invalid-stream-call')
  assert.equal(batch.pendingToolCalls[0].id, 'invalid-stream-call')
  assert.equal(batch.pendingToolCalls[0]._gyshellExecution.mode, 'not_executed')
  assert.equal(batch.pendingToolCalls[0]._gyshellExecution.outcomeStatus, 'error')

  const result = await (agent as any).createToolsNode().invoke(batch)
  const toolMessage = result.messages[1] as ToolMessage
  assert.equal(toolMessage.tool_call_id, 'invalid-stream-call')
  assert.deepEqual(JSON.parse(String(toolMessage.content)), {
    status: 'error',
    reason: 'LangChain reported an invalid tool call: Malformed JSON',
    retryable: true
  })
})

await runCase('stop during a multi-call stream preserves every call and cancelled result', () => {
  const agent = createAgent()
  const rawChunks = [
    {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'stop-complete',
                function: {
                  name: 'read_file',
                  arguments: '{"filePath":"/tmp/complete.txt"}'
                }
              },
              {
                index: 1,
                id: 'stop-partial',
                function: {
                  name: 'read_file',
                  arguments: '{"filePath":"/tmp/partial'
                }
              }
            ]
          },
          finish_reason: null
        }
      ]
    }
  ]
  const messages = (agent as any).buildAbortedModelStreamMessages({
    response: new AIMessage('partial assistant text'),
    rawChunks,
    contracts: new Map([['read_file', ['filePath']]]),
    partialText: 'partial assistant text',
    messageId: 'stopped-assistant'
  })

  assert.deepEqual(
    messages.map((message: any) => message.getType()),
    ['ai', 'tool', 'tool']
  )
  assert.deepEqual(
    messages[0].tool_calls.map((call: any) => [call.id, call.index]),
    [
      ['stop-complete', 0],
      ['stop-partial', 1]
    ]
  )
  assert.deepEqual(
    messages.slice(1).map((message: any) => message.tool_call_id),
    ['stop-complete', 'stop-partial']
  )
  assert.deepEqual(
    messages.slice(1).map((message: any) => JSON.parse(String(message.content)).status),
    ['cancelled', 'cancelled']
  )

  const restored = mapStoredMessagesToChatMessages(mapChatMessagesToStoredMessages(messages))
  assert.deepEqual(
    (restored[0] as any).tool_calls?.map((call: any) => [call.id, call.index]),
    [
      ['stop-complete', 0],
      ['stop-partial', 1]
    ]
  )
  assert.deepEqual(
    restored.slice(1).map((message: any) => message.tool_call_id),
    ['stop-complete', 'stop-partial']
  )
})

await runCase('default-disabled lifecycle tools retain their call id and structured result', async () => {
  const agent = createAgent()
  const source = new AIMessage({
    content: '',
    tool_calls: [
      {
        id: 'default-disabled-create',
        name: 'create_terminal_tab',
        args: { connectionId: 'local' }
      }
    ]
  })
  const batch = await (agent as any).createBatchToolcallExecutorNode().invoke({
    sessionId: 'default-disabled-lifecycle',
    messages: [source]
  })

  assert.equal(batch.pendingToolCalls[0]._gyshellExecution.mode, 'not_executed')
  assert.equal((agent as any).routeModelOutput(batch), 'tools')
  const result = await (agent as any).createToolsNode().invoke(batch)
  const toolMessage = result.messages[1] as ToolMessage
  assert.equal(toolMessage.tool_call_id, 'default-disabled-create')
  assert.deepEqual(JSON.parse(String(toolMessage.content)), {
    status: 'not_executed',
    reason:
      'Tool "create_terminal_tab" is disabled in the current GyShell configuration.',
    retryable: true
  })
})

await runCase('a lifecycle tool disabled after planning fails closed with a structured result', async () => {
  const events: any[] = []
  const agent = createAgent({ onEvent: (event) => events.push(event) })
  ;(agent as any).builtInToolEnabled.close_terminal_tab = true
  const source = new AIMessage({
    content: '',
    tool_calls: [
      {
        id: 'runtime-disabled-close',
        name: 'close_terminal_tab',
        args: { tabIdOrName: 'local-terminal' }
      }
    ]
  })
  const batch = await (agent as any).createBatchToolcallExecutorNode().invoke({
    sessionId: 'runtime-disabled-lifecycle',
    messages: [source]
  })
  assert.equal(batch.pendingToolCalls[0]._gyshellExecution.mode, 'execute')

  ;(agent as any).builtInToolEnabled.close_terminal_tab = false
  const result = await (agent as any).createToolsNode().invoke(batch)
  const toolMessage = result.messages[1] as ToolMessage
  assert.equal(toolMessage.tool_call_id, 'runtime-disabled-close')
  assert.deepEqual(JSON.parse(String(toolMessage.content)), {
    status: 'not_executed',
    reason: 'Tool "close_terminal_tab" was disabled before execution.',
    retryable: true
  })
  assert.equal(
    events.some(
      (event) =>
        event.type === 'tool_call' &&
        event.toolName === 'close_terminal_tab' &&
        JSON.parse(String(event.output)).status === 'not_executed'
    ),
    true
  )
})

await runCase('lifecycle tool AbortError is never converted into a validation result', async () => {
  const agent = createAgent()
  ;(agent as any).builtInToolEnabled.create_terminal_tab = true
  ;(agent as any).builtInToolEnabled.close_terminal_tab = true
  const originalCreate = toolImplementations.createTerminalTab
  const originalClose = toolImplementations.closeTerminalTab
  const abort = async (): Promise<string> => {
    const error = new Error('AbortError')
    error.name = 'AbortError'
    throw error
  }
  ;(toolImplementations as any).createTerminalTab = abort
  ;(toolImplementations as any).closeTerminalTab = abort

  try {
    for (const toolCall of [
      {
        id: 'aborted-create',
        name: 'create_terminal_tab',
        args: { connectionId: 'local' }
      },
      {
        id: 'aborted-close',
        name: 'close_terminal_tab',
        args: { tabIdOrName: 'local-terminal' }
      }
    ]) {
      await assert.rejects(
        () =>
          (agent as any).createToolsNode().invoke({
            sessionId: `abort-${toolCall.id}`,
            messages: [new AIMessage({ content: '', tool_calls: [toolCall] })],
            pendingToolCalls: [
              {
                ...toolCall,
                _gyshellExecution: { ordinal: 0, mode: 'execute' }
              }
            ]
          }),
        /AbortError/
      )
    }
  } finally {
    ;(toolImplementations as any).createTerminalTab = originalCreate
    ;(toolImplementations as any).closeTerminalTab = originalClose
  }
})

await runCase('an MCP adapter that ignores stop cannot publish a late result event', async () => {
  let resolveInvoke!: () => void
  const invokeFinished = new Promise<void>((resolve) => {
    resolveInvoke = resolve
  })
  const events: any[] = []
  const agent = createAgent({
    mcpToolNames: ['mcp_slow'],
    invokeMcp: async () => invokeFinished.then(() => 'late result'),
    onEvent: (event) => events.push(event)
  })
  const controller = new AbortController()
  const invocation = (agent as any).createMcpToolsNode().invoke(
    {
      sessionId: 'late-mcp',
      messages: [
        new AIMessage({
          content: '',
          tool_calls: [{ id: 'slow', name: 'mcp_slow', args: {} }]
        })
      ],
      pendingToolCalls: [{ id: 'slow', name: 'mcp_slow', args: {} }]
    },
    { signal: controller.signal }
  )
  controller.abort()
  resolveInvoke()
  await assert.rejects(() => invocation, /AbortError/)
  assert.equal(events.length, 0)
})

await runCase('a read_file adapter that ignores stop cannot publish a late result event', async () => {
  let releaseRead!: () => void
  let markReadStarted!: () => void
  const readGate = new Promise<void>((resolve) => {
    releaseRead = resolve
  })
  const readStarted = new Promise<void>((resolve) => {
    markReadStarted = resolve
  })
  const terminalRuntime = {
    ...createTerminalRuntime(),
    async readFile() {
      markReadStarted()
      await readGate
      return Buffer.from('late file')
    }
  }
  const events: any[] = []
  const agent = createAgent({
    terminalRuntime,
    onEvent: (event) => events.push(event)
  })
  ;(agent as any).sessionModelBindings.set('late-read-file', {
    readFileSupport: { image: false }
  })
  const controller = new AbortController()
  const invocation = (agent as any).createReadFileNode().invoke(
    {
      sessionId: 'late-read-file',
      messages: [
        new AIMessage({
          content: '',
          tool_calls: [
            {
              id: 'slow-file',
              name: 'read_file',
              args: {
                tabIdOrName: 'local-terminal',
                filePath: '/tmp/pixel.png'
              }
            }
          ]
        })
      ],
      pendingToolCalls: [
        {
          id: 'slow-file',
          name: 'read_file',
          args: { tabIdOrName: 'local-terminal', filePath: '/tmp/pixel.png' }
        }
      ],
      pendingToolSupplementMessages: []
    },
    { signal: controller.signal }
  )
  await readStarted
  controller.abort()
  await assert.rejects(() => invocation, /AbortError/)
  releaseRead()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(events.length, 0)
})

await runCase('a stopped file mutation settles before a restarted run can overwrite it', async () => {
  let releaseWrite!: () => void
  let markWriteStarted!: () => void
  let writeCallCount = 0
  const committedContents: string[] = []
  const writeGate = new Promise<void>((resolve) => {
    releaseWrite = resolve
  })
  const writeStarted = new Promise<void>((resolve) => {
    markWriteStarted = resolve
  })
  const terminalRuntime = {
    ...createTerminalRuntime(),
    async writeFile(_terminalId: string, _filePath: string, content: string) {
      writeCallCount += 1
      if (writeCallCount === 1) {
        markWriteStarted()
        await writeGate
      }
      committedContents.push(content)
    }
  }
  const events: any[] = []
  const agent = createAgent({
    terminalRuntime,
    onEvent: (event) => events.push(event)
  })
  const staleToolCall = {
    id: 'stale-write',
    name: 'write_file',
    args: {
      tabIdOrName: 'local-terminal',
      filePath: '/tmp/new.txt',
      content: 'stale-run-content'
    }
  }
  const controller = new AbortController()
  const staleInvocation = (agent as any).createFileToolsNode().invoke(
    {
      sessionId: 'stale-write-file',
      messages: [new AIMessage({ content: '', tool_calls: [staleToolCall] })],
      pendingToolCalls: [staleToolCall]
    },
    { signal: controller.signal }
  )
  await writeStarted
  controller.abort()
  await assert.rejects(() => staleInvocation, /abort/i)

  const freshToolCall = {
    id: 'fresh-write',
    name: 'write_file',
    args: {
      tabIdOrName: 'local-terminal',
      filePath: '/tmp/new.txt',
      content: 'fresh-run-content'
    }
  }
  let freshSettled = false
  const freshInvocation = (agent as any)
    .createFileToolsNode()
    .invoke({
      sessionId: 'fresh-write-file',
      messages: [new AIMessage({ content: '', tool_calls: [freshToolCall] })],
      pendingToolCalls: [freshToolCall]
    })
    .finally(() => {
      freshSettled = true
    })

  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(writeCallCount, 1)
  assert.equal(freshSettled, false)
  releaseWrite()
  const freshResult = await freshInvocation

  assert.deepEqual(committedContents, ['stale-run-content', 'fresh-run-content'])
  assert.equal(
    String((freshResult.messages[1] as ToolMessage).content).includes(
      'Wrote file successfully.'
    ),
    true
  )
  assert.equal(events.length, 1)
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal((agent as any).fileMutationTailByMachine.size, 0)
})

await runCase('specialized built-in nodes fail closed when disabled after routing', async () => {
  const agent = createAgent()
  const originalRunCommandNowait = toolImplementations.runCommandNowait
  const originalWriteFile = toolImplementations.writeFile
  const originalRunReadFile = toolImplementations.runReadFile
  const adapterCalls = { command: 0, file: 0, read: 0 }
  ;(toolImplementations as any).runCommandNowait = async () => {
    adapterCalls.command += 1
    return 'command ran'
  }
  ;(toolImplementations as any).writeFile = async () => {
    adapterCalls.file += 1
    return 'file wrote'
  }
  ;(toolImplementations as any).runReadFile = async () => {
    adapterCalls.read += 1
    return { resultText: 'file read' }
  }

  try {
    const cases = [
      {
        id: 'disabled-command-after-route',
        name: 'exec_command',
        capability: 'exec_command',
        route: 'command_tools',
        args: {
          tabIdOrName: 'local-terminal',
          command: 'touch /tmp/should-not-run',
          waitMode: 'nowait'
        },
        node: () => (agent as any).createCommandToolsNode(),
        callCount: () => adapterCalls.command
      },
      {
        id: 'disabled-file-after-route',
        name: 'write_file',
        capability: 'create_or_edit',
        route: 'file_tools',
        args: {
          tabIdOrName: 'local-terminal',
          filePath: '/tmp/should-not-write',
          content: 'blocked'
        },
        node: () => (agent as any).createFileToolsNode(),
        callCount: () => adapterCalls.file
      },
      {
        id: 'disabled-read-after-route',
        name: 'read_file',
        capability: 'read_file',
        route: 'read_file',
        args: {
          tabIdOrName: 'local-terminal',
          filePath: '/tmp/pixel.png'
        },
        node: () => (agent as any).createReadFileNode(),
        callCount: () => adapterCalls.read
      }
    ]

    for (const testCase of cases) {
      ;(agent as any).builtInToolEnabled[testCase.capability] = true
      const source = new AIMessage({
        content: '',
        tool_calls: [
          { id: testCase.id, name: testCase.name, args: testCase.args }
        ]
      })
      const batch = await (agent as any).createBatchToolcallExecutorNode().invoke({
        sessionId: testCase.id,
        messages: [source]
      })
      assert.equal((agent as any).routeModelOutput(batch), testCase.route)

      ;(agent as any).builtInToolEnabled[testCase.capability] = false
      const result = await testCase.node().invoke({
        ...batch,
        execCommandActionModelEnabled: false
      })
      const toolMessage = result.messages[1] as ToolMessage
      const outcome = JSON.parse(String(toolMessage.content))
      assert.equal(testCase.callCount(), 0)
      assert.equal(toolMessage.tool_call_id, testCase.id)
      assert.equal(outcome.status, 'not_executed')
      assert.equal(outcome.retryable, true)
      assert.equal(result.pendingToolCalls.length, 0)
    }
  } finally {
    ;(toolImplementations as any).runCommandNowait = originalRunCommandNowait
    ;(toolImplementations as any).writeFile = originalWriteFile
    ;(toolImplementations as any).runReadFile = originalRunReadFile
  }
})

await runCase('an MCP tool deactivated after routing receives a structured result', async () => {
  let invokeCalls = 0
  const agent = createAgent({
    mcpToolNames: ['mcp_dynamic'],
    invokeMcp: async () => {
      invokeCalls += 1
      return 'should not run'
    }
  })
  const source = new AIMessage({
    content: '',
    tool_calls: [{ id: 'deactivated-mcp', name: 'mcp_dynamic', args: {} }]
  })
  const batch = await (agent as any).createBatchToolcallExecutorNode().invoke({
    sessionId: 'deactivated-mcp',
    messages: [source]
  })
  assert.equal((agent as any).routeModelOutput(batch), 'mcp_tools')

  ;(agent as any).mcpToolService.isMcpToolName = () => false
  const result = await (agent as any).createMcpToolsNode().invoke(batch)
  const toolMessage = result.messages[1] as ToolMessage
  assert.equal(invokeCalls, 0)
  assert.equal(toolMessage.tool_call_id, 'deactivated-mcp')
  assert.deepEqual(JSON.parse(String(toolMessage.content)), {
    status: 'not_executed',
    reason: 'MCP tool "mcp_dynamic" is no longer active.',
    retryable: true
  })
})

await runCase(
  'exec_command completion that wins the initial-save race cannot be overwritten by its running return value',
  async () => {
    const originalRunCommandNowait = toolImplementations.runCommandNowait
    const running = commandEnvelope('running')
    const finished = commandEnvelope('finished', {
      output: 'durable completion\n'
    })
    ;(toolImplementations as any).runCommandNowait = async (
      _args: unknown,
      context: any
    ) => {
      context.replaceExecCommandToolResult?.({
        content: finished,
        terminalId: 'local-terminal',
        historyCommandMatchId: 'background-task'
      })
      return running
    }

    try {
      const agent = createAgent()
      const toolCall = {
        id: 'exec-call',
        name: 'exec_command',
        args: {
          tabIdOrName: 'local-terminal',
          command: 'printf durable',
          waitMode: 'nowait'
        }
      }
      const source = new AIMessage({ content: '', tool_calls: [toolCall] })
      const result = await (agent as any).createCommandToolsNode().invoke({
        sessionId: 'completion-before-save',
        messages: [source],
        pendingToolCalls: [toolCall],
        execCommandActionModelEnabled: false
      })
      const contract = parseCommandOutputEnvelopeContract(
        String((result.messages[1] as ToolMessage).content)
      )

      assert.equal(contract?.executionState, 'finished')
      assert.equal(
        String((result.messages[1] as ToolMessage).content).includes(
          'durable completion'
        ),
        true
      )
    } finally {
      ;(toolImplementations as any).runCommandNowait = originalRunCommandNowait
    }
  }
)

await runCase(
  'late exec_command settlement is durable, monotonic across stale saves, and never resurrects deleted history',
  () => {
    let durableSession: any = null
    let saveCount = 0
    const agent = createAgent({
      loadSession: (sessionId) =>
        durableSession?.id === sessionId ? durableSession : null,
      saveSession: (session) => {
        durableSession = session
        saveCount += 1
      }
    })
    const running = commandEnvelope('running')
    const finished = commandEnvelope('finished', {
      output: 'persisted final output\n'
    })
    const initial = toolHistoryFixture(running)
    const initialStored = mapChatMessagesToStoredMessages([
      initial.assistant,
      initial.tool
    ]) as any[]
    durableSession = {
      id: 'durable-nowait',
      title: 'Durable nowait',
      messages: new Map([
        ['exec-assistant', initialStored[0]],
        ['exec-message', initialStored[1]]
      ]),
      lastCheckpointOffset: 0
    }

    const patched = (agent as any).persistSettledExecCommandToolResult({
      sessionId: 'durable-nowait',
      messageId: 'exec-message',
      content: finished,
      terminalId: 'local-terminal',
      historyCommandMatchId: 'background-task'
    })
    assert.equal(patched, true)
    assert.equal(saveCount, 1)
    assert.equal(
      parseCommandOutputEnvelopeContract(
        durableSession.messages.get('exec-message').data.content
      )?.executionState,
      'finished'
    )

    const stale = toolHistoryFixture(running)
    const staleSession = {
      id: 'durable-nowait',
      title: 'Durable nowait',
      messages: new Map(),
      lastCheckpointOffset: 0
    }
    ;(agent as any).updateSessionFromMessages(staleSession, [
      stale.assistant,
      stale.tool
    ])
    ;(agent as any).chatHistoryService.saveSession(staleSession)
    assert.equal(
      parseCommandOutputEnvelopeContract(
        durableSession.messages.get('exec-message').data.content
      )?.executionState,
      'finished',
      'a later whole-session save must not move a settled command back to running'
    )

    const restartedStoredMessages = [
      ...durableSession.messages.values()
    ] as any[]
    expireUnbackedStoredCommandOutputEnvelopes(
      restartedStoredMessages,
      () => undefined
    )
    assert.equal(
      parseCommandOutputEnvelopeContract(
        restartedStoredMessages[1].data.content
      )?.executionState,
      'finished',
      'a self-contained final result must survive process-local backing loss'
    )

    const savesBeforeMismatch = saveCount
    const mismatched = (agent as any).persistSettledExecCommandToolResult({
      sessionId: 'durable-nowait',
      messageId: 'exec-message',
      content: commandEnvelope('finished', {
        historyCommandMatchId: 'different-task',
        output: 'wrong command\n'
      }),
      terminalId: 'local-terminal',
      historyCommandMatchId: 'different-task'
    })
    assert.equal(mismatched, false)
    assert.equal(saveCount, savesBeforeMismatch)

    durableSession.messages.delete('exec-message')
    const savesBeforeDeletion = saveCount
    const resurrected = (agent as any).persistSettledExecCommandToolResult({
      sessionId: 'durable-nowait',
      messageId: 'exec-message',
      content: finished,
      terminalId: 'local-terminal',
      historyCommandMatchId: 'background-task'
    })
    assert.equal(resurrected, false)
    assert.equal(saveCount, savesBeforeDeletion)
    assert.equal(durableSession.messages.has('exec-message'), false)
  }
)

await runCase(
  'aborted and unknown exec_command terminal states replace durable running snapshots',
  () => {
    for (const state of ['aborted', 'outcome_unknown'] as const) {
      let durableSession: any = null
      const agent = createAgent({
        loadSession: () => durableSession,
        saveSession: (session) => {
          durableSession = session
        }
      })
      const initial = toolHistoryFixture(commandEnvelope('running'))
      const stored = mapChatMessagesToStoredMessages([
        initial.assistant,
        initial.tool
      ]) as any[]
      durableSession = {
        id: `terminal-state-${state}`,
        title: state,
        messages: new Map([
          ['exec-assistant', stored[0]],
          ['exec-message', stored[1]]
        ]),
        lastCheckpointOffset: 0
      }
      const content = commandEnvelope(state, {
        output: `${state}\n`
      })

      assert.equal(
        (agent as any).persistSettledExecCommandToolResult({
          sessionId: durableSession.id,
          messageId: 'exec-message',
          content,
          terminalId: 'local-terminal',
          historyCommandMatchId: 'background-task'
        }),
        true
      )
      assert.equal(
        parseCommandOutputEnvelopeContract(
          durableSession.messages.get('exec-message').data.content
        )?.executionState,
        state
      )
    }
  }
)

await runCase(
  'SQLite restart retains late exec_command settlement after a stale whole-session save',
  () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gyshell-command-settlement-')
    )
    const databasePath = path.join(tempDir, 'history.sqlite')
    let store: HistorySqliteStore | undefined
    try {
      store = new HistorySqliteStore({ filePath: databasePath })
      const history = new ChatHistoryService({ store })
      const running = commandEnvelope('running')
      const finished = commandEnvelope('finished', {
        output: 'sqlite final output\n'
      })
      const initial = toolHistoryFixture(running)
      const initialStored = mapChatMessagesToStoredMessages([
        initial.assistant,
        initial.tool
      ]) as any[]
      history.saveSession({
        id: 'sqlite-nowait',
        title: 'SQLite nowait',
        messages: new Map([
          ['exec-assistant', initialStored[0]],
          ['exec-message', initialStored[1]]
        ]),
        lastCheckpointOffset: 0
      })

      const agent = createAgent({ chatHistoryRuntime: history })
      assert.equal(
        (agent as any).persistSettledExecCommandToolResult({
          sessionId: 'sqlite-nowait',
          messageId: 'exec-message',
          content: finished,
          terminalId: 'local-terminal',
          historyCommandMatchId: 'background-task'
        }),
        true
      )

      const stale = toolHistoryFixture(running)
      const staleSession = {
        id: 'sqlite-nowait',
        title: 'SQLite nowait',
        messages: new Map(),
        lastCheckpointOffset: 0
      }
      ;(agent as any).updateSessionFromMessages(staleSession, [
        stale.assistant,
        stale.tool
      ])
      history.saveSession(staleSession)
      store.close()
      store = undefined

      store = new HistorySqliteStore({ filePath: databasePath })
      const restarted = new ChatHistoryService({ store }).loadSession(
        'sqlite-nowait'
      )
      assert.ok(restarted)
      const restartedMessages = [...restarted.messages.values()] as any[]
      expireUnbackedStoredCommandOutputEnvelopes(
        restartedMessages,
        () => undefined
      )
      const restartedTool = restartedMessages.find(
        (message) => message?.data?.name === 'exec_command'
      )
      const restartedContract = parseCommandOutputEnvelopeContract(
        restartedTool?.data?.content
      )
      assert.equal(restartedContract?.executionState, 'finished')
      assert.equal(
        String(restartedTool?.data?.content).includes('sqlite final output'),
        true
      )
    } finally {
      store?.close()
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  }
)

await runCase(
  'stop after dispatch preserves the originating ToolMessage for late command settlement',
  async () => {
    const originalRunCommand = toolImplementations.runCommand
    let replaceResult:
      | ((result: {
          content: string
          terminalId: string
          historyCommandMatchId: string
        }) => void)
      | undefined
    ;(toolImplementations as any).runCommand = async (
      _args: unknown,
      context: any
    ) => {
      replaceResult = context.replaceExecCommandToolResult
      replaceResult?.({
        content: commandEnvelope('running'),
        terminalId: 'local-terminal',
        historyCommandMatchId: 'background-task'
      })
      const error = new Error('AbortError')
      error.name = 'AbortError'
      throw error
    }

    const agent = createAgent()
    const physicalRunId = 'stopped-command-run'
    ;(agent as any).activePhysicalRunIds.add(physicalRunId)
    try {
      const toolCall = {
        id: 'exec-call',
        name: 'exec_command',
        args: {
          tabIdOrName: 'local-terminal',
          command: 'long-running',
          waitMode: 'wait'
        }
      }
      const source = new AIMessage({ content: '', tool_calls: [toolCall] })
      await assert.rejects(
        () =>
          (agent as any).createCommandToolsNode().invoke({
            sessionId: 'stopped-command-session',
            physicalRunId,
            messages: [source],
            pendingToolCalls: [toolCall],
            execCommandActionModelEnabled: false
          }),
        /AbortError/
      )

      const preserved = (agent as any).abortedMessagesByRunId.get(
        physicalRunId
      ) as ToolMessage[] | undefined
      assert.equal(preserved?.length, 1)
      assert.equal(
        parseCommandOutputEnvelopeContract(String(preserved?.[0]?.content))
          ?.executionState,
        'running'
      )

      replaceResult?.({
        content: commandEnvelope('finished', {
          output: 'finished after stop\n'
        }),
        terminalId: 'local-terminal',
        historyCommandMatchId: 'background-task'
      })
      assert.equal(
        parseCommandOutputEnvelopeContract(String(preserved?.[0]?.content))
          ?.executionState,
        'finished'
      )
    } finally {
      ;(agent as any).activePhysicalRunIds.delete(physicalRunId)
      ;(agent as any).abortedMessagesByRunId.delete(physicalRunId)
      ;(toolImplementations as any).runCommand = originalRunCommand
    }
  }
)

await runCase('checkpoint stop preserves image supplements and isolates partial text by run', async () => {
  const saved = new Map<string, any>()
  const snapshots = new Map<string, any>()
  const agent = createAgent({
    saveSession: (session) => saved.set(session.id, session)
  })
  ;(agent as any).graph = {
    getState: async (config: any) =>
      snapshots.get(String(config.configurable.thread_id))
  }

  const imageSource = new AIMessage({
    content: '',
    tool_calls: [{ id: 'image', name: 'read_file', args: {} }]
  })
  snapshots.set('image-stop', {
    values: {
      messages: [
        imageSource,
        new ToolMessage({ content: 'image read', tool_call_id: 'image', name: 'read_file' })
      ],
      pendingToolSupplementMessages: [
        new AIMessage('image bridge'),
        new HumanMessage('image payload')
      ]
    }
  })
  await (agent as any).trySaveSessionFromCheckpoint('image-stop', 'image-run')
  const imageHistory = mapStoredMessagesToChatMessages([
    ...saved.get('image-stop').messages.values()
  ])
  assert.deepEqual(
    imageHistory.map((message) => message.getType()),
    ['ai', 'tool', 'ai', 'human']
  )

  snapshots.set('session-a', { values: { messages: [new HumanMessage('A')] } })
  snapshots.set('session-b', { values: { messages: [new HumanMessage('B')] } })
  ;(agent as any).abortedMessagesByRunId.set('run-a', [new AIMessage('partial A')])
  ;(agent as any).abortedMessagesByRunId.set('run-b', [new AIMessage('partial B')])
  await (agent as any).trySaveSessionFromCheckpoint('session-a', 'run-a')
  await (agent as any).trySaveSessionFromCheckpoint('session-b', 'run-b')

  const historyA = mapStoredMessagesToChatMessages([...saved.get('session-a').messages.values()])
  const historyB = mapStoredMessagesToChatMessages([...saved.get('session-b').messages.values()])
  assert.equal(String(historyA[1].content), 'partial A')
  assert.equal(String(historyB[1].content), 'partial B')
})

await runCase('late model failure cannot resurrect partial output for a finished physical run', async () => {
  const agent = createAgent()
  const physicalRunId = 'finished-physical-run'
  let releaseProvider: () => void = () => {}
  const providerGate = new Promise<void>((resolve) => {
    releaseProvider = resolve
  })
  ;(agent as any).activePhysicalRunIds.add(physicalRunId)
  const lateCapture = providerGate.then(() =>
    (agent as any).captureAbortedMessageForActiveRun(
      physicalRunId,
      new AIMessage('late partial')
    )
  )

  ;(agent as any).activePhysicalRunIds.delete(physicalRunId)
  ;(agent as any).abortedMessagesByRunId.delete(physicalRunId)
  releaseProvider()

  assert.equal(await lateCapture, false)
  assert.equal(
    (agent as any).abortedMessagesByRunId.has(physicalRunId),
    false
  )
})

await runCase(
  'image supplements are committed only after every result in a mixed read wave',
  async () => {
    const agent = createAgent({ mcpToolNames: ['mcp_lookup'] })
    ;(agent as any).sessionModelBindings.set('image-wave', {
      readFileSupport: { image: true }
    })
    const toolCalls = [
      {
        id: 'image',
        name: 'read_file',
        args: {
          tabIdOrName: 'local-terminal',
          filePath: '/tmp/pixel.png'
        }
      },
      { id: 'lookup', name: 'mcp_lookup', args: {} }
    ]
    const source = new AIMessage({ content: '', tool_calls: toolCalls })
    const batch = await (agent as any).createBatchToolcallExecutorNode().invoke({
      sessionId: 'image-wave',
      messages: [source]
    })
    const parallelResult = await (agent as any)
      .createParallelToolsNode()
      .invoke({ ...batch, pendingToolSupplementMessages: [] })

    assert.deepEqual(
      parallelResult.messages.map((message: any) => message.getType()),
      ['ai', 'tool', 'tool']
    )
    assert.deepEqual(
      parallelResult.messages.slice(1).map((message: ToolMessage) => message.tool_call_id),
      ['image', 'lookup']
    )
    assert.equal(parallelResult.pendingToolSupplementMessages.length, 2)
    assert.equal((agent as any).routeAfterToolCall(parallelResult), 'flush_tool_supplements')

    const flushed = await (agent as any).createFlushToolSupplementsNode().invoke(parallelResult)
    assert.deepEqual(
      flushed.messages.map((message: any) => message.getType()),
      ['ai', 'tool', 'tool', 'ai', 'human']
    )
    assert.equal(flushed.pendingToolSupplementMessages.length, 0)
  }
)

await runCase('persistence completes interrupted calls before later partial assistant text', () => {
  const agent = createAgent()
  const source = new AIMessage({
    content: '',
    tool_calls: [
      { id: 'done', name: 'read_file', args: {} },
      { id: 'in-flight', name: 'exec_command', args: {} },
      { id: 'not-started', name: 'read_terminal_tab', args: {} }
    ]
  })
  const session: any = {
    id: 'interrupted-session',
    title: 'Interrupted',
    messages: new Map(),
    lastCheckpointOffset: 0
  }
  ;(agent as any).updateSessionFromMessages(session, [
    source,
    new ToolMessage({
      content: 'done result',
      tool_call_id: 'done',
      name: 'read_file'
    }),
    new AIMessage('partial text captured during stop')
  ])

  const restored = mapStoredMessagesToChatMessages([...session.messages.values()])
  assert.deepEqual(
    restored.map((message) => message.getType()),
    ['ai', 'tool', 'tool', 'tool', 'ai']
  )
  assert.deepEqual(
    restored.slice(1, 4).map((message: any) => message.tool_call_id),
    ['done', 'in-flight', 'not-started']
  )
  assert.equal(JSON.parse(String(restored[2].content)).status, 'unknown_outcome')
  assert.equal((restored[0] as AIMessage).tool_calls?.length, 3)
})

await runCase(
  'stop before batch planning repairs invalid ids and still records every outcome',
  () => {
    const agent = createAgent()
    const session: any = {
      id: 'invalid-id-stop',
      title: 'Invalid id stop',
      messages: new Map(),
      lastCheckpointOffset: 0
    }
    ;(agent as any).updateSessionFromMessages(session, [
      new AIMessage({
        content: '',
        tool_calls: [
          { id: '', name: 'read_file', args: {} },
          { id: 'duplicate', name: 'read_file', args: {} },
          { id: 'duplicate', name: 'read_terminal_tab', args: {} }
        ]
      })
    ])

    const restored = mapStoredMessagesToChatMessages([...session.messages.values()])
    const restoredCalls = (restored[0] as AIMessage).tool_calls || []
    const restoredIds = restoredCalls.map((toolCall) => String(toolCall.id))
    assert.equal(
      restoredIds.every((id) => id.length > 0),
      true
    )
    assert.equal(new Set(restoredIds).size, 3)
    assert.deepEqual(
      restored.slice(1).map((message: any) => message.tool_call_id),
      restoredIds
    )
  }
)

await runCase(
  'token overflow handling fails closed while any tool batch state is unresolved',
  async () => {
    const agent = createAgent()
    await assert.rejects(
      () =>
        (agent as any).createTokenManagerNode().invoke({
          sessionId: 'overflow-unresolved',
          messages: [new HumanMessage('x'.repeat(10_000))],
          pendingToolCalls: [{ id: 'pending', name: 'read_file', args: {} }],
          pendingToolSupplementMessages: [],
          token_state: { current_tokens: 10_000, max_tokens: 10 }
        }),
      /cannot run before every tool result/
    )
  }
)

await runCase('action-model policy history never contains the unresolved active tool batch', () => {
  const agent = createAgent()
  const first = { id: 'first', name: 'exec_command', args: {} }
  const second = { id: 'second', name: 'exec_command', args: {} }
  const source = new AIMessage({
    content: '',
    tool_calls: [first, second]
  })
  const history = (agent as any).buildActionModelHistoryBeforeActiveToolBatch({
    messages: [
      new HumanMessage('<user_input>run checks</user_input>'),
      source,
      new ToolMessage({
        content: 'first complete',
        tool_call_id: 'first',
        name: 'exec_command'
      })
    ],
    pendingToolCalls: [second]
  })

  assert.equal(
    history.some(
      (message: any) =>
        message === source ||
        (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) ||
        message.getType() === 'tool'
    ),
    false
  )
})
