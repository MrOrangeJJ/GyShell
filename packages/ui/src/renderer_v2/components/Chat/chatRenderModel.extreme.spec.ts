import { observable } from 'mobx'
import {
  buildChatRenderItems,
  resolveSeamlessOverlayMessages,
} from './chatRenderModel'
import type { ChatMessage, ChatSession } from '../../stores/ChatStore'

const assertEqual = <T>(actual: T, expected: T, message: string): void => {
  if (actual !== expected) {
    throw new Error(
      `${message}. expected=${String(expected)} actual=${String(actual)}`,
    )
  }
}

const assertDeepEqual = (
  actual: unknown,
  expected: unknown,
  message: string,
): void => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}. expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`,
    )
  }
}

const runCase = (name: string, fn: () => void): void => {
  fn()
  console.log(`PASS ${name}`)
}

const createMessage = (
  overrides: Partial<ChatMessage> & Pick<ChatMessage, 'id' | 'role' | 'type'>,
): ChatMessage => ({
  id: overrides.id,
  role: overrides.role,
  type: overrides.type,
  content: overrides.content || '',
  timestamp: 1,
  ...(overrides.backendMessageId
    ? { backendMessageId: overrides.backendMessageId }
    : {}),
  ...(overrides.metadata ? { metadata: overrides.metadata } : {}),
  ...(typeof overrides.streaming === 'boolean'
    ? { streaming: overrides.streaming }
    : {}),
})

const createSession = (messages: ChatMessage[]): ChatSession => {
  const messagesById = observable.map<string, ChatMessage>()
  const messageIds: string[] = []
  messages.forEach((message) => {
    messagesById.set(message.id, message)
    messageIds.push(message.id)
  })
  return {
    id: 'session-1',
    title: 'Test Session',
    messagesById,
    messageIds,
    renderListVersion: 0,
    isThinking: false,
    isSessionBusy: false,
    lockedProfileId: null,
  }
}

runCase(
  'assistant runs are computed once and expose group-copy only on the tail row',
  () => {
    const session = createSession([
      createMessage({ id: 'u1', role: 'user', type: 'text', content: 'hello' }),
      createMessage({
        id: 'a1',
        role: 'assistant',
        type: 'text',
        content: 'first reply',
        streaming: false,
      }),
      createMessage({
        id: 'a2',
        role: 'assistant',
        type: 'command',
        content: 'ls',
        streaming: false,
      }),
      createMessage({ id: 'u2', role: 'user', type: 'text', content: 'next' }),
    ])

    const items = buildChatRenderItems(session, false)
    assertDeepEqual(
      items.map((item) => item.id),
      ['u1', 'a1', 'a2', 'u2'],
      'visible item ordering should stay stable',
    )
    assertEqual(
      items[1]?.mergeWithPreviousAssistant,
      false,
      'assistant run head should not merge with previous row',
    )
    assertEqual(
      items[1]?.showAssistantRoleLabel,
      true,
      'assistant run head should show the role label',
    )
    assertEqual(
      items[2]?.mergeWithPreviousAssistant,
      true,
      'assistant run continuation should merge with previous assistant row',
    )
    assertEqual(
      items[2]?.showAssistantRoleLabel,
      false,
      'assistant run continuation should not repeat the role label',
    )
    assertEqual(
      items[1]?.showAssistantGroupCopy,
      false,
      'assistant run head should not show copy control',
    )
    assertEqual(
      items[2]?.showAssistantGroupCopy,
      true,
      'assistant run tail should show copy control',
    )
    assertDeepEqual(
      items[2]?.assistantGroupMessageIds,
      ['a1', 'a2'],
      'assistant run tail should expose the full assistant group',
    )
    assertEqual(
      items[1]?.assistantGroupBranchMessageId,
      null,
      'assistant run head should not expose branch source',
    )
    assertEqual(
      items[2]?.assistantGroupBranchMessageId,
      'a2',
      'assistant run tail should expose the selected assistant branch target',
    )
  },
)

runCase(
  'classic assistant role label stays on the first tool row when tools precede text',
  () => {
    const session = createSession([
      createMessage({ id: 'u1', role: 'user', type: 'text', content: 'hello' }),
      createMessage({
        id: 'tool1',
        role: 'assistant',
        type: 'tool_call',
        content: '{"query":"example"}',
        streaming: false,
      }),
      createMessage({
        id: 'cmd1',
        role: 'assistant',
        type: 'command',
        content: 'pwd',
        streaming: false,
      }),
      createMessage({
        id: 'a1',
        role: 'assistant',
        type: 'text',
        content: 'answer after tools',
        streaming: false,
      }),
      createMessage({ id: 'u2', role: 'user', type: 'text', content: 'next' }),
    ])

    const items = buildChatRenderItems(session, false, 'classic')
    assertDeepEqual(
      items.map((item) => item.id),
      ['u1', 'tool1', 'cmd1', 'a1', 'u2'],
      'classic tool-first assistant runs should preserve visible ordering',
    )
    assertDeepEqual(
      items.map((item) => item.showAssistantRoleLabel),
      [false, true, false, false, false],
      'classic mode should render one assistant label at the top of the assistant turn',
    )
    assertDeepEqual(
      items.map((item) => item.mergeWithPreviousAssistant),
      [false, false, true, true, false],
      'classic mode should merge all assistant rows after the top-labeled row',
    )
    assertDeepEqual(
      items[3]?.assistantGroupMessageIds,
      ['tool1', 'cmd1', 'a1'],
      'classic copy grouping should keep all assistant rows in the connected run',
    )
  },
)

runCase(
  'seamless assistant role label stays on the first grouped tool row when tools precede text',
  () => {
    const session = createSession([
      createMessage({ id: 'u1', role: 'user', type: 'text', content: 'hello' }),
      createMessage({
        id: 'tool1',
        role: 'assistant',
        type: 'tool_call',
        content: '{"query":"example"}',
        streaming: false,
      }),
      createMessage({
        id: 'cmd1',
        role: 'assistant',
        type: 'command',
        content: 'pwd',
        streaming: false,
      }),
      createMessage({
        id: 'a1',
        role: 'assistant',
        type: 'text',
        content: 'answer after tools',
        streaming: false,
      }),
    ])

    const items = buildChatRenderItems(session, false, 'seamless')
    assertDeepEqual(
      items.map((item) => item.id),
      ['u1', 'tool1', 'a1'],
      'seamless mode should group leading tool rows before the text row',
    )
    assertDeepEqual(
      items[1]?.seamlessGroupMessageIds,
      ['tool1', 'cmd1'],
      'seamless grouped tool row should include consecutive tool activity',
    )
    assertEqual(
      items[1]?.estimatedHeight,
      72,
      'collapsed seamless groups should keep a compact estimate independent of step count',
    )
    const restoredExpandedItems = buildChatRenderItems(
      session,
      false,
      'seamless',
      new Set(['tool1']),
    )
    assertEqual(
      (restoredExpandedItems[1]?.estimatedHeight || 0) > 72,
      true,
      'restored expanded groups should retain a disclosure-aware estimate before measurement',
    )
    assertDeepEqual(
      items.map((item) => item.showAssistantRoleLabel),
      [false, true, false],
      'seamless mode should render one assistant label at the top of the assistant turn',
    )
    assertDeepEqual(
      items.map((item) => item.mergeWithPreviousAssistant),
      [false, false, true],
      'seamless text after a leading tool group should merge under the top label',
    )
    assertEqual(
      items[2]?.assistantGroupBranchMessageId,
      'a1',
      'seamless assistant text tail should branch from the selected assistant message',
    )
  },
)

runCase(
  'seamless tool group at the turn tail owns the copy/branch controls',
  () => {
    const session = createSession([
      createMessage({ id: 'u1', role: 'user', type: 'text', content: 'hello' }),
      createMessage({
        id: 'a1',
        role: 'assistant',
        type: 'text',
        content: 'let me check',
        streaming: false,
      }),
      createMessage({
        id: 'tool1',
        role: 'assistant',
        type: 'tool_call',
        content: '{"query":"example"}',
        backendMessageId: 'b-tool1',
        streaming: false,
      }),
      createMessage({
        id: 'cmd1',
        role: 'assistant',
        type: 'command',
        content: 'pwd',
        backendMessageId: 'b-cmd1',
        streaming: false,
      }),
    ])

    const items = buildChatRenderItems(session, false, 'seamless')
    assertDeepEqual(
      items.map((item) => item.id),
      ['u1', 'a1', 'tool1'],
      'seamless mode should group the trailing tool activity into one row',
    )
    assertDeepEqual(
      items[2]?.seamlessGroupMessageIds,
      ['tool1', 'cmd1'],
      'trailing tool group should include consecutive tool activity',
    )
    assertEqual(
      items[2]?.showAssistantGroupCopy,
      true,
      'a settled tool group ending the turn should expose the copy control',
    )
    assertDeepEqual(
      items[2]?.assistantGroupMessageIds,
      ['tool1', 'cmd1'],
      'the tail tool group should copy its grouped tool messages',
    )
    assertEqual(
      items[2]?.assistantGroupBranchMessageId,
      'cmd1',
      'the tail tool group should branch from its last tool message',
    )
  },
)

runCase('expanded seamless estimates track compact disclosure rows', () => {
  const session = createSession([
    createMessage({ id: 'u1', role: 'user', type: 'text', content: 'run' }),
    ...Array.from({ length: 20 }, (_, index) =>
      createMessage({
        id: `tool-${index}`,
        role: 'assistant',
        type: 'tool_call',
        content: JSON.stringify({ index }),
        metadata: { output: 'x'.repeat(12_000) },
        streaming: false,
      }),
    ),
  ])

  const items = buildChatRenderItems(
    session,
    false,
    'seamless',
    new Set(['tool-0']),
  )

  assertEqual(
    items[1]?.estimatedHeight,
    524,
    'the expanded fallback should estimate 20 compact rows without sizing for hidden detail payloads',
  )
})

runCase(
  'streaming seamless tool group tail keeps copy/branch hidden until settled',
  () => {
    const session = createSession([
      createMessage({ id: 'u1', role: 'user', type: 'text', content: 'hello' }),
      createMessage({
        id: 'tool1',
        role: 'assistant',
        type: 'tool_call',
        content: '{"query":"example"}',
        backendMessageId: 'b-tool1',
        streaming: true,
      }),
    ])

    const items = buildChatRenderItems(session, true, 'seamless')
    assertEqual(
      items[1]?.showAssistantGroupCopy,
      false,
      'a streaming tool group should not expose the copy control yet',
    )
    assertEqual(
      items[1]?.assistantGroupBranchMessageId,
      null,
      'a streaming tool group should not expose a branch target yet',
    )
  },
)

runCase(
  'hidden non-terminal reasoning and retry-hint rows stay out of the render model',
  () => {
    const session = createSession([
      createMessage({ id: 'u1', role: 'user', type: 'text', content: 'hello' }),
      createMessage({
        id: 'r1',
        role: 'assistant',
        type: 'reasoning',
        content: 'intermediate reasoning',
        streaming: false,
      }),
      createMessage({
        id: 'hint1',
        role: 'system',
        type: 'alert',
        content: 'Retrying',
        metadata: { subToolLevel: 'info' },
      }),
      createMessage({
        id: 'a1',
        role: 'assistant',
        type: 'text',
        content: 'answer',
        streaming: false,
      }),
      createMessage({
        id: 'r2',
        role: 'assistant',
        type: 'reasoning',
        content: 'final reasoning',
        streaming: false,
      }),
    ])

    const items = buildChatRenderItems(session, false)
    assertDeepEqual(
      items.map((item) => item.id),
      ['u1', 'a1', 'r2'],
      'non-terminal reasoning and retry-hint rows should be filtered out',
    )
  },
)

runCase(
  'compaction boundary renders as an independent row without hiding assistant turn actions',
  () => {
    const session = createSession([
      createMessage({ id: 'u1', role: 'user', type: 'text', content: 'hello' }),
      createMessage({
        id: 'a1',
        role: 'assistant',
        type: 'text',
        content: 'answer before cutoff',
        backendMessageId: 'backend-assistant-1',
        streaming: false,
      }),
      createMessage({
        id: 'boundary',
        role: 'system',
        type: 'compaction_boundary',
        content: '',
        backendMessageId: 'ui-boundary-1',
        metadata: {
          compactionBoundaryTargetBackendMessageId: 'backend-user-2',
        },
      }),
      createMessage({
        id: 'u2',
        role: 'user',
        type: 'text',
        content: 'protected tail starts',
        backendMessageId: 'backend-user-2',
      }),
    ])

    const items = buildChatRenderItems(session, false, 'classic')
    assertDeepEqual(
      items.map((item) => `${item.kind}:${item.id}`),
      ['user:u1', 'assistant:a1', 'boundary:boundary', 'user:u2'],
      'boundary marker should be a visible non-assistant row',
    )
    assertEqual(
      items[1]?.showAssistantGroupCopy,
      true,
      'boundary marker should not suppress copy controls for the preceding assistant turn',
    )
    assertEqual(
      items[2]?.estimatedHeight,
      40,
      'boundary marker should use a compact virtual height estimate',
    )
  },
)

runCase(
  'seamless trailing tool group keeps turn actions when followed by a compaction boundary',
  () => {
    const session = createSession([
      createMessage({ id: 'u1', role: 'user', type: 'text', content: 'hello' }),
      createMessage({
        id: 'tool1',
        role: 'assistant',
        type: 'tool_call',
        content: '{"query":"example"}',
        backendMessageId: 'backend-tool-1',
        streaming: false,
      }),
      createMessage({
        id: 'boundary',
        role: 'system',
        type: 'compaction_boundary',
        content: '',
        backendMessageId: 'ui-boundary-1',
        metadata: {
          compactionBoundaryTargetBackendMessageId: 'backend-user-2',
        },
      }),
      createMessage({
        id: 'u2',
        role: 'user',
        type: 'text',
        content: 'protected tail starts',
        backendMessageId: 'backend-user-2',
      }),
    ])

    const items = buildChatRenderItems(session, false, 'seamless')
    assertDeepEqual(
      items.map((item) => `${item.kind}:${item.id}`),
      ['user:u1', 'assistant:tool1', 'boundary:boundary', 'user:u2'],
      'seamless mode should keep the boundary outside tool grouping',
    )
    assertEqual(
      items[1]?.showAssistantGroupCopy,
      true,
      'boundary marker should not suppress tool-group turn actions',
    )
    assertDeepEqual(
      items[1]?.seamlessGroupMessageIds,
      ['tool1'],
      'boundary marker should not enter the seamless tool group',
    )
  },
)

runCase(
  'completed whitespace assistant messages and token rows do not become visible rows',
  () => {
    const session = createSession([
      createMessage({
        id: 'tokens',
        role: 'system',
        type: 'tokens_count',
        content: '',
      }),
      createMessage({
        id: 'blank',
        role: 'assistant',
        type: 'text',
        content: '   ',
        streaming: false,
      }),
      createMessage({
        id: 'live',
        role: 'assistant',
        type: 'text',
        content: '',
        streaming: true,
      }),
    ])

    const items = buildChatRenderItems(session, true)
    assertDeepEqual(
      items.map((item) => item.id),
      ['live'],
      'only the live streaming assistant row should remain visible',
    )
  },
)

runCase('seamless overlay only includes the trailing overlay block', () => {
  const session = createSession([
    createMessage({ id: 'u1', role: 'user', type: 'text', content: 'hello' }),
    createMessage({
      id: 'err-old',
      role: 'assistant',
      type: 'error',
      content: 'old failure',
    }),
    createMessage({
      id: 'a1',
      role: 'assistant',
      type: 'text',
      content: 'recovered',
    }),
    createMessage({
      id: 'ask-current',
      role: 'assistant',
      type: 'ask',
      content: 'Need approval',
    }),
    createMessage({
      id: 'alert-current',
      role: 'assistant',
      type: 'alert',
      content: 'Current warning',
      metadata: { subToolLevel: 'warning' },
    }),
  ])

  const overlayMessages = resolveSeamlessOverlayMessages(session)
  assertDeepEqual(
    overlayMessages.map((message) => message.id),
    ['ask-current', 'alert-current'],
    'historical overlay rows should stop pinning once newer visible chat content exists',
  )
})

runCase(
  'seamless overlay ignores hidden tail rows when keeping the current issue',
  () => {
    const session = createSession([
      createMessage({ id: 'u1', role: 'user', type: 'text', content: 'hello' }),
      createMessage({
        id: 'err-current',
        role: 'assistant',
        type: 'error',
        content: 'latest failure',
      }),
      createMessage({
        id: 'tokens',
        role: 'system',
        type: 'tokens_count',
        content: '',
      }),
    ])

    const overlayMessages = resolveSeamlessOverlayMessages(session)
    assertDeepEqual(
      overlayMessages.map((message) => message.id),
      ['err-current'],
      'hidden tail rows should not suppress the active overlay issue',
    )
  },
)

console.log('All chat render model extreme tests passed.')
