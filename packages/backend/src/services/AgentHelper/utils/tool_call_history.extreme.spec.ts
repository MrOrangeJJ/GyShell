import assert from 'node:assert/strict'
import {
  AIMessage,
  HumanMessage,
  ToolMessage,
  mapChatMessagesToStoredMessages,
  mapStoredMessagesToChatMessages,
  type BaseMessage
} from '@langchain/core/messages'
import {
  completeUnmatchedToolCallsInHistory,
  removeUnmatchedToolCallsFromHistory,
  serializeSyntheticToolOutcome,
  type SyntheticToolOutcome
} from './tool_call_history'

function runCase(name: string, fn: () => void): void {
  try {
    fn()
    console.log(`ok - ${name}`)
  } catch (error) {
    console.error(`not ok - ${name}`)
    throw error
  }
}

function makeAssistant(calls: Array<{ id?: unknown; name?: unknown; args?: unknown }>): AIMessage {
  return new AIMessage({
    content: '',
    tool_calls: calls as any
  })
}

function makeTool(id: string, name: string, content: string): ToolMessage {
  return new ToolMessage({
    content,
    tool_call_id: id,
    name
  })
}

function getToolMessages(messages: BaseMessage[]): ToolMessage[] {
  return messages.filter((message) => message.getType() === 'tool') as ToolMessage[]
}

function parseOutcome(message: ToolMessage): SyntheticToolOutcome {
  assert.equal(typeof message.content, 'string')
  return JSON.parse(message.content as string) as SyntheticToolOutcome
}

function permutations<T>(values: T[]): T[][] {
  if (values.length <= 1) return [values.slice()]
  const result: T[][] = []
  values.forEach((value, index) => {
    const rest = [...values.slice(0, index), ...values.slice(index + 1)]
    for (const suffix of permutations(rest)) {
      result.push([value, ...suffix])
    }
  })
  return result
}

runCase('empty and tool-free histories retain their original array identity', () => {
  const empty: BaseMessage[] = []
  const emptyResult = completeUnmatchedToolCallsInHistory(empty)
  assert.equal(emptyResult.messages, empty)
  assert.equal(emptyResult.changed, false)

  const toolFree: BaseMessage[] = [new HumanMessage('hello'), new AIMessage('hi')]
  const toolFreeResult = completeUnmatchedToolCallsInHistory(toolFree)
  assert.equal(toolFreeResult.messages, toolFree)
  assert.equal(toolFreeResult.changed, false)
})

runCase('orphan tool responses are excluded without changing surrounding roles', () => {
  const before = new HumanMessage('before')
  const orphan = makeTool('orphan-call', 'read_file', 'unowned-result')
  const after = new AIMessage('after')

  const completed = completeUnmatchedToolCallsInHistory([
    before,
    orphan,
    after
  ])

  assert.equal(completed.changed, true)
  assert.equal(completed.orphanToolResponseCount, 1)
  assert.equal(completed.messages.includes(orphan), false)
  assert.deepEqual(completed.messages, [before, after])
})

runCase('every unique unmatched call receives one ordered structured result', () => {
  const assistant = makeAssistant([
    { id: 'call-a', name: 'read_file', args: { path: 'a' } },
    { id: 'call-b', name: 'read_terminal_tab', args: {} }
  ])
  const laterMessage = new HumanMessage('queued user input')
  const originalCalls = assistant.tool_calls

  const result = completeUnmatchedToolCallsInHistory([assistant, laterMessage])

  assert.equal(result.addedToolMessageCount, 2)
  assert.equal(result.changed, true)
  assert.equal(result.messages[0], assistant)
  assert.equal(result.messages[3], laterMessage)
  assert.equal(assistant.tool_calls, originalCalls)
  assert.deepEqual(
    assistant.tool_calls?.map((call) => call.id),
    ['call-a', 'call-b']
  )

  const tools = getToolMessages(result.messages)
  assert.deepEqual(
    tools.map((message) => message.tool_call_id),
    ['call-a', 'call-b']
  )
  assert.deepEqual(
    tools.map((message) => message.name),
    ['read_file', 'read_terminal_tab']
  )
  for (const tool of tools) {
    const outcome = parseOutcome(tool)
    assert.equal(outcome.status, 'unknown_outcome')
    assert.equal(outcome.retryable, false)
    assert.ok(outcome.reason.length > 0)
  }
})

runCase('existing results are ordered before AI and Human image supplements', () => {
  const assistant = makeAssistant([
    { id: 'call-a', name: 'read_file', args: {} },
    { id: 'call-b', name: 'read_file', args: {} },
    { id: 'call-c', name: 'read_file', args: {} }
  ])
  const resultA = makeTool('call-a', 'read_file', 'a-result')
  const resultC = makeTool('call-c', 'read_file', 'c-result')
  const aiSupplement = new AIMessage('let me see')
  const imageSupplement = new HumanMessage({
    content: [
      { type: 'text', text: 'image follows' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }
    ]
  })
  const tail = new HumanMessage('later')

  const completed = completeUnmatchedToolCallsInHistory([
    assistant,
    resultC,
    aiSupplement,
    imageSupplement,
    resultA,
    tail
  ])

  assert.equal(completed.addedToolMessageCount, 1)
  assert.deepEqual(
    completed.messages.slice(1, 4).map((message) => (message as any).tool_call_id),
    ['call-a', 'call-b', 'call-c']
  )
  assert.equal(completed.messages[1], resultA)
  assert.equal(completed.messages[3], resultC)
  assert.equal(completed.messages[4], aiSupplement)
  assert.equal(completed.messages[5], imageSupplement)
  assert.equal(completed.messages[6], tail)
})

runCase('all result and supplement permutations converge to one protocol-safe prefix', () => {
  for (const permutation of permutations(['a', 'b', 'c', 'ai', 'human'])) {
    const assistant = makeAssistant([
      { id: 'call-a', name: 'read_file', args: {} },
      { id: 'call-b', name: 'read_file', args: {} },
      { id: 'call-c', name: 'read_file', args: {} }
    ])
    const resultByLabel: Record<string, BaseMessage> = {
      a: makeTool('call-a', 'read_file', 'a-result'),
      b: makeTool('call-b', 'read_file', 'b-result'),
      c: makeTool('call-c', 'read_file', 'c-result'),
      ai: new AIMessage('image bridge'),
      human: new HumanMessage({
        content: [
          {
            type: 'image_url',
            image_url: { url: 'data:image/png;base64,AA==' }
          }
        ]
      })
    }
    const history = [assistant, ...permutation.map((label) => resultByLabel[label])]

    const completed = completeUnmatchedToolCallsInHistory(history)

    assert.deepEqual(
      completed.messages.slice(1, 4).map((message) => (message as ToolMessage).tool_call_id),
      ['call-a', 'call-b', 'call-c']
    )
    const expectedSupplements = permutation
      .filter((label) => label === 'ai' || label === 'human')
      .map((label) => resultByLabel[label])
    assert.deepEqual(completed.messages.slice(4), expectedSupplements)
    assert.equal(completed.addedToolMessageCount, 0)
  }
})

runCase('the same ID in a later assistant batch cannot satisfy an earlier batch', () => {
  const firstAssistant = makeAssistant([{ id: 'call-reused', name: 'first_tool', args: {} }])
  const separator = new HumanMessage('new turn')
  const secondAssistant = makeAssistant([{ id: 'call-reused', name: 'second_tool', args: {} }])
  const secondResult = makeTool('call-reused', 'second_tool', 'second-result')

  const completed = completeUnmatchedToolCallsInHistory([
    firstAssistant,
    separator,
    secondAssistant,
    secondResult
  ])

  assert.equal(completed.addedToolMessageCount, 1)
  assert.equal(completed.messages[0], firstAssistant)
  assert.equal((completed.messages[1] as ToolMessage).tool_call_id, 'call-reused')
  assert.equal((completed.messages[1] as ToolMessage).name, 'first_tool')
  assert.equal(completed.messages[2], separator)
  assert.equal(completed.messages[3], secondAssistant)
  assert.equal(completed.messages[4], secondResult)
})

runCase('duplicate and empty call IDs never cause fabricated duplicate or invalid results', () => {
  const assistant = makeAssistant([
    { id: 'call-a', name: 'first', args: {} },
    { id: 'call-a', name: 'duplicate', args: {} },
    { id: '', name: 'empty', args: {} },
    { id: '   ', name: 'whitespace', args: {} },
    { name: 'missing', args: {} }
  ])
  const existing = makeTool('call-a', 'first', 'done')
  const history: BaseMessage[] = [assistant, existing]

  const completed = completeUnmatchedToolCallsInHistory(history)

  assert.equal(completed.addedToolMessageCount, 0)
  assert.equal(completed.duplicateToolCallIdCount, 1)
  assert.equal(completed.invalidToolCallCount, 3)
  assert.equal(completed.messages, history)
  assert.equal(completed.changed, false)
  assert.equal(assistant.tool_calls?.length, 5)
  assert.deepEqual(getToolMessages(completed.messages), [existing])
})

runCase('an existing response is consumed at most once and duplicate protocol results are removed', () => {
  const assistant = makeAssistant([{ id: 'call-a', name: 'read_file', args: {} }])
  const supplement = new HumanMessage('supplement')
  const first = makeTool('call-a', 'read_file', 'first')
  const duplicate = makeTool('call-a', 'read_file', 'duplicate')

  const completed = completeUnmatchedToolCallsInHistory([assistant, supplement, first, duplicate])

  assert.equal(completed.addedToolMessageCount, 0)
  assert.equal(completed.duplicateToolResponseCount, 1)
  assert.equal(completed.messages[1], first)
  assert.equal(completed.messages[2], supplement)
  assert.equal(completed.messages.length, 3)
  assert.equal(completed.messages.includes(duplicate), false)
})

runCase('tool IDs are matched exactly rather than by a lossy trimmed key', () => {
  const assistant = makeAssistant([{ id: ' call-with-space ', name: 'read_file', args: {} }])
  const differentlySpacedResult = makeTool('call-with-space', 'read_file', 'different-id')

  const completed = completeUnmatchedToolCallsInHistory([assistant, differentlySpacedResult])
  const tools = getToolMessages(completed.messages)

  assert.equal(completed.addedToolMessageCount, 1)
  assert.equal(completed.orphanToolResponseCount, 1)
  assert.equal(tools[0]?.tool_call_id, ' call-with-space ')
  assert.equal(tools.length, 1)
  assert.equal(completed.messages.includes(differentlySpacedResult), false)
})

runCase('callers can choose cancelled or retryable not-executed outcomes', () => {
  assert.deepEqual(
    JSON.parse(
      serializeSyntheticToolOutcome({
        status: 'cancelled',
        reason: 'Stopped by the user.',
        retryable: false
      })
    ),
    {
      status: 'cancelled',
      reason: 'Stopped by the user.',
      retryable: false
    }
  )

  const assistant = makeAssistant([{ id: 'call-a', name: 'read_file', args: {} }])
  const completed = completeUnmatchedToolCallsInHistory([assistant], {
    status: 'not_executed'
  })
  assert.deepEqual(parseOutcome(getToolMessages(completed.messages)[0]), {
    status: 'not_executed',
    reason: 'The tool call was not executed and may be issued again if it is still needed.',
    retryable: true
  })
})

runCase('malformed runtime options still serialize every required field', () => {
  assert.deepEqual(
    JSON.parse(
      serializeSyntheticToolOutcome({
        status: 'unsupported',
        reason: 123,
        retryable: 'yes'
      } as any)
    ),
    {
      status: 'unknown_outcome',
      reason:
        'The run ended before a definitive tool result was recorded. The side effect, if any, must not be assumed or replayed automatically.',
      retryable: false
    }
  )
})

runCase('the compatibility API preserves calls and serializes through LangChain', () => {
  const assistant = makeAssistant([
    { id: 'call-a', name: 'exec_command', args: { command: 'pwd' } }
  ])
  const compatibility = removeUnmatchedToolCallsFromHistory([assistant])

  assert.equal(compatibility.removedToolCallCount, 0)
  assert.equal(assistant.tool_calls?.length, 1)
  assert.equal(getToolMessages(compatibility.messages).length, 1)

  const restored = mapStoredMessagesToChatMessages(
    mapChatMessagesToStoredMessages(compatibility.messages)
  )
  const restoredAssistant = restored[0] as AIMessage
  const restoredTool = restored[1] as ToolMessage
  assert.equal(restoredAssistant.tool_calls?.[0]?.id, 'call-a')
  assert.equal(restoredTool.tool_call_id, 'call-a')
  assert.equal(parseOutcome(restoredTool).status, 'unknown_outcome')
})

runCase('completion is idempotent after synthetic results are inserted', () => {
  const first = completeUnmatchedToolCallsInHistory([
    makeAssistant([
      { id: 'call-a', name: 'read_file', args: {} },
      { id: 'call-b', name: 'read_file', args: {} }
    ]),
    new HumanMessage('tail')
  ])
  const second = completeUnmatchedToolCallsInHistory(first.messages)

  assert.equal(first.addedToolMessageCount, 2)
  assert.equal(second.addedToolMessageCount, 0)
  assert.equal(second.changed, false)
  assert.equal(second.messages, first.messages)
})
