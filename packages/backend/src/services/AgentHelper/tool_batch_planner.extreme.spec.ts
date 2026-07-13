import assert from 'node:assert/strict'
import {
  createSyntheticToolOutcomeContent,
  deferTerminalMutationsAfterRuntimeBoundary,
  getParallelToolCallPrefix,
  isParallelToolCallPrefixStillSafe,
  normalizeToolCallIds,
  normalizeToolCallNames,
  planToolCallBatch,
  resolveToolCallTerminalIds,
  type ModelToolCall,
  type ToolBatchPlanningEnvironment
} from './tool_batch_planner'

function runCase(name: string, fn: () => void): void {
  try {
    fn()
    console.log(`ok - ${name}`)
  } catch (error) {
    console.error(`not ok - ${name}`)
    throw error
  }
}

function createEnvironment(input?: {
  disabled?: string[]
  mcpReadOnly?: string[]
  terminalByReference?: Record<string, string>
  machineByReference?: Record<string, string>
}): ToolBatchPlanningEnvironment {
  let groupNumber = 0
  const disabled = new Set(input?.disabled || [])
  const mcpReadOnly = new Set(input?.mcpReadOnly || [])
  return {
    isToolEnabled: (name) => !disabled.has(name),
    isMcpTool: (name) => name.startsWith('mcp_'),
    isMcpToolReadOnly: (name) => mcpReadOnly.has(name),
    resolveTerminalId: (reference) => input?.terminalByReference?.[reference] || null,
    resolveMachineId: (reference) => input?.machineByReference?.[reference] || null,
    createParallelGroupId: () => `parallel-${++groupNumber}`
  }
}

function call(id: string, name: string, args: Record<string, unknown> = {}): ModelToolCall {
  return { id, name, args }
}

runCase('valid ids remain byte-for-byte stable while invalid ids are repaired', () => {
  let id = 0
  const result = normalizeToolCallIds(
    [
      call('keep-a', 'read_file'),
      call(' keep-spaces ', 'read_file'),
      call('', 'read_file'),
      call('   ', 'read_file'),
      call('keep-a', 'read_file'),
      call('keep-b', 'read_file')
    ],
    () => String(++id)
  )

  assert.deepEqual(
    result.toolCalls.map((toolCall) => toolCall.id),
    [
      'keep-a',
      ' keep-spaces ',
      'gyshell_repaired_1',
      'gyshell_repaired_2',
      'gyshell_repaired_3',
      'keep-b'
    ]
  )
  assert.deepEqual(
    result.repairs.map((repair) => repair.reason),
    ['empty', 'empty', 'duplicate']
  )
})

runCase('parallel safety is revalidated against runtime changes', () => {
  const environment = createEnvironment({ mcpReadOnly: ['mcp_lookup'] })
  const planned = planToolCallBatch(
    [call('a', 'read_file'), call('b', 'mcp_lookup')],
    environment
  )
  assert.equal(isParallelToolCallPrefixStillSafe(planned, environment), true)
  assert.equal(
    isParallelToolCallPrefixStillSafe(
      planned,
      createEnvironment({ disabled: ['read_file'], mcpReadOnly: ['mcp_lookup'] })
    ),
    false
  )
  assert.equal(isParallelToolCallPrefixStillSafe(planned, createEnvironment()), false)
})

runCase('blank tool names are repaired without changing ids or dropping calls', () => {
  const normalized = normalizeToolCallNames([
    { id: 'missing', args: {} },
    { id: 'blank', name: '   ', args: {} },
    call('valid', 'read_file')
  ])
  const planned = planToolCallBatch(normalized.toolCalls, createEnvironment())

  assert.deepEqual(normalized.repairedOrdinals, [0, 1])
  assert.deepEqual(
    planned.map((item) => [item.id, item.name, item._gyshellExecution.mode]),
    [
      ['missing', 'gyshell_invalid_tool_call', 'not_executed'],
      ['blank', 'gyshell_invalid_tool_call', 'not_executed'],
      ['valid', 'read_file', 'execute']
    ]
  )
})

runCase('cross-machine safety is revalidated after terminal rebinding', () => {
  const planned = planToolCallBatch(
    [
      call('a', 'exec_command', { tabIdOrName: 'one', command: 'one' }),
      call('b', 'exec_command', { tabIdOrName: 'two', command: 'two' })
    ],
    createEnvironment({
      machineByReference: { one: 'machine-a', two: 'machine-b' }
    })
  )
  assert.equal(
    isParallelToolCallPrefixStillSafe(
      planned,
      createEnvironment({ machineByReference: { one: 'machine-a', two: 'machine-a' } })
    ),
    false
  )
})

runCase('contiguous explicit reads and read-only MCP tools share a bounded parallel wave', () => {
  const planned = planToolCallBatch(
    [
      call('a', 'read_file'),
      call('b', 'read_terminal_tab'),
      call('c', 'mcp_lookup'),
      call('d', 'read_command_output'),
      call('e', 'read_file_transfer_status')
    ],
    createEnvironment({ mcpReadOnly: ['mcp_lookup'] })
  )

  assert.deepEqual(
    planned.slice(0, 4).map((item) => item._gyshellExecution.parallelGroupId),
    ['parallel-1', 'parallel-1', 'parallel-1', 'parallel-1']
  )
  assert.equal(planned[4]._gyshellExecution.parallelGroupId, undefined)
})

runCase('MCP tools without an explicit readOnlyHint remain sequential', () => {
  const planned = planToolCallBatch(
    [call('a', 'mcp_unknown'), call('b', 'mcp_unknown')],
    createEnvironment()
  )
  assert.equal(planned[0]._gyshellExecution.parallelGroupId, undefined)
  assert.equal(planned[1]._gyshellExecution.parallelGroupId, undefined)
})

runCase('same-terminal commands stay ordered and sequential', () => {
  const environment = createEnvironment({
    terminalByReference: { shell: 'terminal-1' },
    machineByReference: { shell: 'local' }
  })
  const planned = planToolCallBatch(
    [
      call('a', 'exec_command', { tabIdOrName: 'shell', command: 'one' }),
      call('b', 'exec_command', { tabIdOrName: 'shell', command: 'two' })
    ],
    environment
  )

  assert.deepEqual(
    planned.map((item) => item._gyshellExecution.mode),
    ['execute', 'execute']
  )
  assert.equal(planned[0]._gyshellExecution.parallelGroupId, undefined)
  assert.equal(planned[1]._gyshellExecution.parallelGroupId, undefined)
})

runCase('commands on distinct machines can execute in the same parallel wave', () => {
  const planned = planToolCallBatch(
    [
      call('a', 'exec_command', { tabIdOrName: 'local', command: 'one' }),
      call('b', 'exec_command', { tabIdOrName: 'remote', command: 'two' })
    ],
    createEnvironment({
      terminalByReference: { local: 'terminal-1', remote: 'terminal-2' },
      machineByReference: {
        local: 'local-machine',
        remote: 'remote-machine'
      }
    })
  )

  assert.equal(planned[0]._gyshellExecution.parallelGroupId, 'parallel-1')
  assert.equal(planned[1]._gyshellExecution.parallelGroupId, 'parallel-1')
})

runCase('skill is the only executed call in a context-changing batch', () => {
  const planned = planToolCallBatch(
    [
      call('a', 'read_file'),
      call('b', 'skill', { name: 'investigate' }),
      call('c', 'read_terminal_tab')
    ],
    createEnvironment()
  )

  assert.deepEqual(
    planned.map((item) => item._gyshellExecution.mode),
    ['not_executed', 'execute', 'not_executed']
  )
  assert.match(planned[0]._gyshellExecution.reason || '', /context-changing/)
})

runCase(
  'synchronous exec followed by stdin on the same terminal is rejected without dropping ids',
  () => {
    const planned = planToolCallBatch(
      [
        call('exec', 'exec_command', {
          tabIdOrName: 'shell',
          command: 'interactive',
          waitMode: 'wait'
        }),
        call('stdin', 'write_stdin', {
          tabIdOrName: 'shell',
          sequence: ['yes', 'LF']
        })
      ],
      createEnvironment({
        terminalByReference: { shell: 'terminal-1' },
        machineByReference: { shell: 'local-machine' }
      })
    )

    assert.deepEqual(
      planned.map((item) => [item.id, item._gyshellExecution.mode]),
      [
        ['exec', 'not_executed'],
        ['stdin', 'not_executed']
      ]
    )
    assert.match(planned[0]._gyshellExecution.reason || '', /deadlock/)
  }
)

runCase(
  'nowait creates a model-visible boundary for later same-terminal mutations but not reads',
  () => {
    const planned = planToolCallBatch(
      [
        call('exec', 'exec_command', {
          tabIdOrName: 'shell',
          command: 'server',
          waitMode: 'nowait'
        }),
        call('read', 'read_terminal_tab', { tabIdOrName: 'shell' }),
        call('stdin', 'write_stdin', {
          tabIdOrName: 'shell',
          sequence: ['LF']
        })
      ],
      createEnvironment({
        terminalByReference: { shell: 'terminal-1' },
        machineByReference: { shell: 'local-machine' }
      })
    )

    assert.deepEqual(
      planned.map((item) => item._gyshellExecution.mode),
      ['execute', 'execute', 'not_executed']
    )
  }
)

runCase('terminal boundaries cover file writes and propagate after a rejected mutation', () => {
  const environment = createEnvironment({
    terminalByReference: { shell: 'terminal-1' },
    machineByReference: { shell: 'local-machine' }
  })
  const planned = planToolCallBatch(
    [
      call('exec', 'exec_command', {
        tabIdOrName: 'shell',
        command: 'interactive',
        waitMode: 'wait'
      }),
      call('stdin', 'write_stdin', { tabIdOrName: 'shell', sequence: ['yes', 'LF'] }),
      call('edit', 'edit_file', { tabIdOrName: 'shell', filePath: '/tmp/a' }),
      call('later-exec', 'exec_command', { tabIdOrName: 'shell', command: 'after' })
    ],
    environment
  )

  assert.deepEqual(
    planned.map((item) => item._gyshellExecution.mode),
    ['not_executed', 'not_executed', 'not_executed', 'not_executed']
  )
})

runCase('background file transfer blocks mutations on both source and target terminals', () => {
  const environment = createEnvironment({
    terminalByReference: { source: 'terminal-1', target: 'terminal-2' }
  })
  const planned = planToolCallBatch(
    [
      call('copy', 'copy_between_tabs', {
        sourceTabIdOrName: 'source',
        targetTabIdOrName: 'target'
      }),
      call('source-edit', 'edit_file', { tabIdOrName: 'source' }),
      call('target-edit', 'write_file', { tabIdOrName: 'target' })
    ],
    environment
  )
  assert.deepEqual(
    planned.map((item) => item._gyshellExecution.mode),
    ['execute', 'not_executed', 'not_executed']
  )
})

runCase('background transfer defers target file reads but permits source and status reads', () => {
  const environment = createEnvironment({
    terminalByReference: { source: 'terminal-1', target: 'terminal-2' }
  })
  const planned = planToolCallBatch(
    [
      call('copy', 'copy_between_tabs', {
        sourceTabIdOrName: 'source',
        targetTabIdOrName: 'target'
      }),
      call('source-read', 'read_file', { tabIdOrName: 'source', filePath: '/tmp/a' }),
      call('target-read', 'read_file', { tabIdOrName: 'target', filePath: '/tmp/a' }),
      call('status', 'read_file_transfer_status', { transferId: 'copy' })
    ],
    environment
  )
  assert.deepEqual(
    planned.map((item) => item._gyshellExecution.mode),
    ['execute', 'execute', 'not_executed', 'execute']
  )
})

runCase('terminal-scoped file paths override mismatched tab args for barriers', () => {
  const environment = createEnvironment({
    terminalByReference: {
      A: 'terminal-a',
      B: 'terminal-b',
      'encoded terminal': 'terminal-encoded'
    },
    machineByReference: { A: 'machine-a', B: 'machine-b' }
  })
  const planned = planToolCallBatch(
    [
      call('run', 'exec_command', {
        tabIdOrName: 'A',
        command: 'server',
        waitMode: 'nowait',
        filePath: '@terminal(B):/irrelevant-extra-arg'
      }),
      call('edit', 'edit_file', {
        tabIdOrName: 'B',
        filePath: '@terminal(A):/tmp/out'
      }),
      call('encoded', 'read_file', {
        tabIdOrName: 'B',
        filePath: '@terminal(encoded%20terminal):/tmp/out'
      })
    ],
    environment
  )
  assert.equal(planned[1]._gyshellExecution.mode, 'not_executed')
  assert.equal(
    resolveToolCallTerminalIds(planned[2], environment)[0],
    'terminal-encoded'
  )
})

runCase('a wait command that becomes background defers every later same-terminal mutation', () => {
  const environment = createEnvironment({ terminalByReference: { shell: 'terminal-1' } })
  const planned = planToolCallBatch(
    [
      call('exec', 'exec_command', { tabIdOrName: 'shell', command: 'server' }),
      call('edit', 'edit_file', { tabIdOrName: 'shell' }),
      call('later-exec', 'exec_command', { tabIdOrName: 'shell', command: 'after' })
    ],
    environment
  )
  deferTerminalMutationsAfterRuntimeBoundary(
    planned.slice(1),
    'terminal-1',
    planned[0],
    environment
  )
  assert.deepEqual(
    planned.map((item) => item._gyshellExecution.mode),
    ['execute', 'not_executed', 'not_executed']
  )
})

runCase('disabled tools become explicit retryable results', () => {
  const planned = planToolCallBatch(
    [call('a', 'read_file'), call('b', 'read_terminal_tab')],
    createEnvironment({ disabled: ['read_file'] })
  )
  assert.equal(planned[0]._gyshellExecution.mode, 'not_executed')
  assert.equal(planned[0]._gyshellExecution.retryable, true)
  assert.equal(planned[1]._gyshellExecution.mode, 'execute')
})

runCase('parallel prefix and structured outcome retain stable protocol data', () => {
  const planned = planToolCallBatch(
    [call('a', 'read_file'), call('b', 'read_terminal_tab')],
    createEnvironment()
  )
  assert.deepEqual(
    getParallelToolCallPrefix(planned).map((item) => item.id),
    ['a', 'b']
  )
  assert.deepEqual(
    JSON.parse(
      createSyntheticToolOutcomeContent({
        status: 'not_executed',
        reason: 'boundary',
        retryable: true
      })
    ),
    { status: 'not_executed', reason: 'boundary', retryable: true }
  )
})
