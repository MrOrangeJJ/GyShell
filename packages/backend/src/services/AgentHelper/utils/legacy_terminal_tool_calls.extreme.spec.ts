import assert from 'node:assert/strict'
import {
  AIMessage,
  AIMessageChunk,
  HumanMessage,
  mapChatMessagesToStoredMessages,
  type BaseMessage
} from '@langchain/core/messages'
import { terminalIdSchema } from '../terminalIdContract'
import { encodeTerminalScopedFilePath } from '../terminalScopedFilePath'
import {
  migrateLegacyTerminalToolCallsForModelInput,
  UNRESOLVED_LEGACY_TERMINAL_ID,
  type TerminalReferenceMigrationResolver
} from './legacy_terminal_tool_calls'
import { prepareModelInputMessagesForInvocation } from './model_messages'

function runCase(name: string, fn: () => void): void {
  try {
    fn()
    console.log(`ok - ${name}`)
  } catch (error) {
    console.error(`not ok - ${name}`)
    throw error
  }
}

const terminals = [
  { id: 'id-A', title: 'Alias A' },
  { id: 'id-B', title: 'Duplicate' },
  { id: 'id-C', title: 'Duplicate' },
  { id: '  id)(%/终端😀  ', title: 'Unicode Alias' }
]

const resolver: TerminalReferenceMigrationResolver = {
  resolveExactTerminalId(reference) {
    return terminals.find((terminal) => terminal.id === reference)?.id || null
  },
  resolveLegacyTerminalReference(reference) {
    const exact = terminals.find((terminal) => terminal.id === reference)
    if (exact) return exact.id
    const titleMatches = terminals.filter(
      (terminal) => terminal.title === reference
    )
    return titleMatches.length === 1 ? titleMatches[0].id : null
  }
}

const stored = (messages: BaseMessage[]): any[] =>
  mapChatMessagesToStoredMessages(messages) as any[]

const jsonClone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

runCase('migration covers canonical, invalid, chunk, raw, and legacy function call shapes', () => {
  const message = new AIMessage({
    content: '',
    tool_calls: [
      {
        id: 'canonical-call',
        name: 'exec_command',
        args: { tabIdOrName: 'Alias A', command: 'pwd', waitMode: 'wait' }
      }
    ],
    invalid_tool_calls: [
      {
        id: 'invalid-call',
        name: 'read_file',
        args: JSON.stringify({
          tabIdOrName: 'Alias A',
          filePath: '/tmp/a'
        }),
        error: 'provider marked this invalid'
      }
    ],
    additional_kwargs: {
      tool_calls: [
        {
          id: 'raw-call',
          type: 'function',
          function: {
            name: 'write_stdin',
            arguments: JSON.stringify({
              tabIdOrName: 'Alias A',
              sequence: ['LF']
            })
          }
        }
      ],
      function_call: {
        name: 'wait_terminal_idle',
        arguments: JSON.stringify({ tabIdOrName: 'Alias A' })
      }
    }
  } as any)
  const chunk = new AIMessageChunk({
    content: '',
    tool_call_chunks: [
      {
        id: 'chunk-call',
        name: 'read_terminal_tab',
        args: JSON.stringify({ tabIdOrName: 'Alias A' }),
        index: 0,
        type: 'tool_call_chunk'
      }
    ]
  } as any)
  const originalStored = stored([message, chunk])
  const originalSnapshot = JSON.stringify(originalStored)

  const migrated = migrateLegacyTerminalToolCallsForModelInput(
    [message, chunk],
    resolver
  )
  const migratedStored = stored(migrated)

  assert.equal(JSON.stringify(stored([message, chunk])), originalSnapshot)
  assert.notEqual(migrated[0], message)
  assert.equal(
    migratedStored[0].data.tool_calls[0].args.terminalId,
    'id-A'
  )
  assert.equal(
    JSON.parse(migratedStored[0].data.invalid_tool_calls[0].args).terminalId,
    'id-A'
  )
  assert.equal(
    JSON.parse(
      migratedStored[0].data.additional_kwargs.tool_calls[0].function.arguments
    ).terminalId,
    'id-A'
  )
  assert.equal(
    JSON.parse(
      migratedStored[0].data.additional_kwargs.function_call.arguments
    ).terminalId,
    'id-A'
  )
  assert.equal(
    JSON.parse(migratedStored[1].data.tool_call_chunks[0].args).terminalId,
    'id-A'
  )
  assert.equal(
    migratedStored[1].data.tool_calls[0].args.terminalId,
    'id-A'
  )
  assert.equal(JSON.stringify(migratedStored).includes('tabIdOrName'), false)
})

runCase('exact IDs win before unique legacy titles while ambiguity and staleness fail closed', () => {
  const message = new AIMessage({
    content: '',
    tool_calls: [
      {
        id: 'exact',
        name: 'read_terminal_tab',
        args: { tabIdOrName: 'id-B' }
      },
      {
        id: 'ambiguous',
        name: 'read_terminal_tab',
        args: { tabIdOrName: 'Duplicate' }
      },
      {
        id: 'stale',
        name: 'read_terminal_tab',
        args: { tabIdOrName: 'Missing Alias' }
      },
      {
        id: 'malformed-selector',
        name: 'read_terminal_tab',
        args: { tabIdOrName: 42 }
      }
    ]
  } as any)
  const calls = stored(
    migrateLegacyTerminalToolCallsForModelInput([message], resolver)
  )[0].data.tool_calls

  assert.equal(calls[0].args.terminalId, 'id-B')
  assert.equal(calls[1].args.terminalId, UNRESOLVED_LEGACY_TERMINAL_ID)
  assert.equal(calls[2].args.terminalId, UNRESOLVED_LEGACY_TERMINAL_ID)
  assert.equal(calls[3].args.terminalId, UNRESOLVED_LEGACY_TERMINAL_ID)
  assert.equal(
    terminalIdSchema.safeParse(UNRESOLVED_LEGACY_TERMINAL_ID).success,
    false
  )
})

runCase('canonical and legacy selectors must resolve to the same exact ID', () => {
  const message = new AIMessage({
    content: '',
    tool_calls: [
      {
        id: 'compatible',
        name: 'exec_command',
        args: {
          terminalId: 'id-A',
          tabIdOrName: 'Alias A',
          command: 'pwd'
        }
      },
      {
        id: 'conflict',
        name: 'exec_command',
        args: {
          terminalId: 'id-B',
          tabIdOrName: 'Alias A',
          command: 'pwd'
        }
      },
      {
        id: 'invalid-canonical',
        name: 'exec_command',
        args: {
          terminalId: 'stale-id',
          tabIdOrName: 'Alias A',
          command: 'pwd'
        }
      }
    ]
  } as any)
  const calls = stored(
    migrateLegacyTerminalToolCallsForModelInput([message], resolver)
  )[0].data.tool_calls

  assert.equal(calls[0].args.terminalId, 'id-A')
  assert.equal(calls[1].args.terminalId, UNRESOLVED_LEGACY_TERMINAL_ID)
  assert.equal(calls[2].args.terminalId, UNRESOLVED_LEGACY_TERMINAL_ID)
  assert.equal(calls.every((call: any) => !('tabIdOrName' in call.args)), true)
})

runCase('copy selectors migrate independently and conflicts cannot be stripped', () => {
  const message = new AIMessage({
    content: '',
    tool_calls: [
      {
        id: 'copy-compatible',
        name: 'copy_between_tabs',
        args: {
          sourceTerminalId: 'id-A',
          sourceTabIdOrName: 'Alias A',
          targetTabIdOrName: 'id-B',
          sourcePaths: ['/tmp/a'],
          targetDirPath: '/tmp'
        }
      },
      {
        id: 'copy-conflict',
        name: 'copy_between_tabs',
        args: {
          sourceTerminalId: 'id-C',
          sourceTabIdOrName: 'id-B',
          targetTerminalId: 'id-A',
          targetTabIdOrName: 'Alias A',
          sourcePaths: ['/tmp/a'],
          targetDirPath: '/tmp'
        }
      }
    ]
  } as any)
  const calls = stored(
    migrateLegacyTerminalToolCallsForModelInput([message], resolver)
  )[0].data.tool_calls

  assert.equal(calls[0].args.sourceTerminalId, 'id-A')
  assert.equal(calls[0].args.targetTerminalId, 'id-B')
  assert.equal(
    calls[1].args.sourceTerminalId,
    UNRESOLVED_LEGACY_TERMINAL_ID
  )
  assert.equal(calls[1].args.targetTerminalId, 'id-A')
  assert.equal(JSON.stringify(calls).includes('TabIdOrName'), false)
})

runCase('legacy file scopes preserve their historical authoritative target and canonicalize opaque IDs', () => {
  const opaqueId = terminals[3].id
  const message = new AIMessage({
    content: '',
    tool_calls: [
      {
        id: 'legacy-scope',
        name: 'read_file',
        args: {
          tabIdOrName: 'Alias A',
          filePath: '@terminal(Unicode%20Alias):/tmp/a'
        }
      },
      {
        id: 'canonical-scope-conflict',
        name: 'read_file',
        args: {
          terminalId: 'id-A',
          tabIdOrName: 'Alias A',
          filePath: '@terminal(id-B):/tmp/b'
        }
      }
    ]
  } as any)
  const calls = stored(
    migrateLegacyTerminalToolCallsForModelInput([message], resolver)
  )[0].data.tool_calls

  assert.equal(calls[0].args.terminalId, opaqueId)
  assert.equal(
    calls[0].args.filePath,
    encodeTerminalScopedFilePath(opaqueId, '/tmp/a')
  )
  assert.equal(
    calls[1].args.terminalId,
    UNRESOLVED_LEGACY_TERMINAL_ID
  )
})

runCase('malformed JSON with a legacy selector becomes a non-resolvable canonical call', () => {
  const message = new AIMessage({
    content: '',
    invalid_tool_calls: [
      {
        id: 'bad-single',
        name: 'exec_command',
        args: '{"tabIdOrName":"Alias A",',
        error: 'bad json'
      },
      {
        id: 'bad-copy',
        name: 'copy_between_tabs',
        args: '{"sourceTabIdOrName":"Alias A",',
        error: 'bad json'
      },
      {
        id: 'unrelated-json',
        name: 'exec_command',
        args: '{"command":',
        error: 'bad json'
      }
    ]
  } as any)
  const calls = stored(
    migrateLegacyTerminalToolCallsForModelInput([message], resolver)
  )[0].data.invalid_tool_calls

  assert.deepEqual(JSON.parse(calls[0].args), {
    terminalId: UNRESOLVED_LEGACY_TERMINAL_ID
  })
  assert.deepEqual(JSON.parse(calls[1].args), {
    sourceTerminalId: UNRESOLVED_LEGACY_TERMINAL_ID,
    targetTerminalId: UNRESOLVED_LEGACY_TERMINAL_ID
  })
  assert.equal(calls[2].args, '{"command":')
})

runCase('non-terminal calls and canonical-only history remain identity-stable', () => {
  const canonicalMessage = new AIMessage({
    content: '',
    tool_calls: [
      {
        id: 'canonical-only',
        name: 'exec_command',
        args: { terminalId: 'id-A', command: 'pwd' }
      },
      {
        id: 'unrelated',
        name: 'mcp_lookup',
        args: { tabIdOrName: 'unrelated-data' }
      }
    ]
  } as any)
  const messages = [new HumanMessage('hello'), canonicalMessage]
  const result = migrateLegacyTerminalToolCallsForModelInput(messages, resolver)
  assert.equal(result, messages)
  assert.equal(result[0], messages[0])
  assert.equal(result[1], messages[1])
})

runCase('provider preparation migrates only a detached request copy', () => {
  const message = new AIMessage({
    content: '',
    tool_calls: [
      {
        id: 'provider-copy',
        name: 'exec_command',
        args: { tabIdOrName: 'Alias A', command: 'pwd' }
      }
    ]
  } as any)
  const before = jsonClone(stored([message]))
  const prepared = prepareModelInputMessagesForInvocation([message], {
    terminalReferenceMigrationResolver: resolver
  })

  assert.deepEqual(stored([message]), before)
  assert.equal(
    stored(prepared)[0].data.tool_calls[0].args.terminalId,
    'id-A'
  )
  assert.equal(
    JSON.stringify(stored(prepared)).includes('tabIdOrName'),
    false
  )
})

runCase('stored-message conversion is a deep-copy boundary for tool args', () => {
  const message = new AIMessage({
    content: '',
    tool_calls: [
      {
        id: 'deep-copy',
        name: 'exec_command',
        args: {
          tabIdOrName: 'Alias A',
          nested: { values: ['original'] }
        }
      }
    ]
  } as any)
  const storedCopy = stored([message])
  storedCopy[0].data.tool_calls[0].args.tabIdOrName = 'mutated'
  storedCopy[0].data.tool_calls[0].args.nested.values[0] = 'mutated'

  const originalArgs = (message as any).tool_calls[0].args
  assert.equal(originalArgs.tabIdOrName, 'Alias A')
  assert.equal(originalArgs.nested.values[0], 'original')
})
