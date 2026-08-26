import type { ChatMessage } from '../../stores/ChatStore'
import {
  createChatRowHeightEstimate,
  createChatTextHeightShape,
  createFixedChatRowHeightEstimate,
  resolveChatRowHeightEstimate,
} from './chatRowHeightEstimate'

const assertEqual = <T>(actual: T, expected: T, message: string): void => {
  if (actual !== expected) {
    throw new Error(
      `${message}. expected=${String(expected)} actual=${String(actual)}`,
    )
  }
}

const assertBetween = (
  actual: number,
  minimum: number,
  maximum: number,
  message: string,
): void => {
  if (actual < minimum || actual > maximum) {
    throw new Error(
      `${message}. expected=${minimum}..${maximum} actual=${actual}`,
    )
  }
}

const runCase = (name: string, fn: () => void): void => {
  fn()
  console.log(`PASS ${name}`)
}

const createMessage = (
  overrides: Partial<ChatMessage> & Pick<ChatMessage, 'role' | 'type'>,
): ChatMessage => ({
  id: overrides.id || 'message-1',
  role: overrides.role,
  type: overrides.type,
  content: overrides.content || '',
  timestamp: 1,
  ...(overrides.metadata ? { metadata: overrides.metadata } : {}),
  ...(typeof overrides.streaming === 'boolean'
    ? { streaming: overrides.streaming }
    : {}),
})

runCase('long text estimates grow monotonically as the viewport narrows', () => {
  const message = createMessage({
    role: 'assistant',
    type: 'text',
    content: 'width-sensitive content '.repeat(120),
  })
  const estimate = createChatRowHeightEstimate(message, 'assistant')
  const narrow = resolveChatRowHeightEstimate(estimate, {
    viewportWidth: 291,
  })
  const medium = resolveChatRowHeightEstimate(estimate, {
    viewportWidth: 480,
  })
  const wide = resolveChatRowHeightEstimate(estimate, {
    viewportWidth: 753,
  })

  assertEqual(narrow > medium, true, 'narrow text should wrap into more rows')
  assertEqual(medium > wide, true, 'wide text should wrap into fewer rows')
})

runCase('short assistant rows keep compact estimates and explicit chrome', () => {
  const estimate = createChatRowHeightEstimate(
    createMessage({ role: 'assistant', type: 'text', content: 'done' }),
    'assistant',
  )

  assertEqual(
    resolveChatRowHeightEstimate(estimate, { viewportWidth: 720 }),
    30,
    'short continuation rows should use the minimum measured row height',
  )
  assertEqual(
    resolveChatRowHeightEstimate(estimate, {
      viewportWidth: 720,
      showAssistantRoleLabel: true,
    }),
    50,
    'assistant role labels should add their own layout chrome',
  )
  assertEqual(
    resolveChatRowHeightEstimate(estimate, {
      viewportWidth: 720,
      showAssistantGroupActions: true,
    }),
    54,
    'assistant group actions should reserve their footer height',
  )
})

runCase('CJK characters consume wider wrapping units than ASCII', () => {
  const asciiEstimate = {
    fixedHeight: 8,
    textShape: createChatTextHeightShape('a'.repeat(120)),
  }
  const cjkEstimate = {
    fixedHeight: 8,
    textShape: createChatTextHeightShape('界'.repeat(120)),
  }
  const asciiHeight = resolveChatRowHeightEstimate(asciiEstimate, {
    viewportWidth: 291,
  })
  const cjkHeight = resolveChatRowHeightEstimate(cjkEstimate, {
    viewportWidth: 291,
  })

  assertEqual(
    cjkHeight > asciiHeight,
    true,
    'double-width text should wrap into more visual lines',
  )
})

runCase('blank markdown lines add spacing without full text-line inflation', () => {
  const dense = {
    fixedHeight: 8,
    textShape: createChatTextHeightShape('one\ntwo\nthree'),
  }
  const spaced = {
    fixedHeight: 8,
    textShape: createChatTextHeightShape('one\n\ntwo\n\nthree'),
  }
  const denseHeight = resolveChatRowHeightEstimate(dense, {
    viewportWidth: 720,
  })
  const spacedHeight = resolveChatRowHeightEstimate(spaced, {
    viewportWidth: 720,
  })

  assertEqual(
    spacedHeight - denseHeight,
    14,
    'two blank markdown lines should add compact paragraph spacing',
  )
})

runCase('user image strips and banner defaults stay component-specific', () => {
  const plainUser = createChatRowHeightEstimate(
    createMessage({ role: 'user', type: 'text', content: 'prompt' }),
    'user',
  )
  const imageUser = createChatRowHeightEstimate(
    createMessage({
      role: 'user',
      type: 'text',
      content: 'prompt',
      metadata: {
        inputImages: [
          {
            attachmentId: 'image-1',
            mimeType: 'image/png',
            fileName: 'probe.png',
          },
        ],
      },
    }),
    'user',
  )
  const command = createChatRowHeightEstimate(
    createMessage({ role: 'assistant', type: 'command', content: 'pwd' }),
    'assistant',
  )
  const fileEdit = createChatRowHeightEstimate(
    createMessage({ role: 'assistant', type: 'file_edit' }),
    'assistant',
  )

  const plainUserHeight = resolveChatRowHeightEstimate(plainUser)
  const imageUserHeight = resolveChatRowHeightEstimate(imageUser)
  assertEqual(
    imageUserHeight - plainUserHeight,
    64,
    'image attachments should reserve exactly one horizontal image strip',
  )
  assertEqual(
    resolveChatRowHeightEstimate(command),
    168,
    'short expanded command banners should preserve the established fallback',
  )
  assertEqual(
    resolveChatRowHeightEstimate(fileEdit),
    38,
    'collapsed file-edit banners should use their compact measured height',
  )
})

runCase('command output estimates grow with content and cap at banner max height', () => {
  const short = createChatRowHeightEstimate(
    createMessage({
      role: 'assistant',
      type: 'command',
      content: 'echo ok',
      metadata: { output: 'ok\\n' },
    }),
    'assistant',
  )
  const long = createChatRowHeightEstimate(
    createMessage({
      role: 'assistant',
      type: 'command',
      content: 'echo many',
      metadata: { output: 'line\\n'.repeat(2_000) },
    }),
    'assistant',
  )
  const shortHeight = resolveChatRowHeightEstimate(short, { viewportWidth: 710 })
  const longHeight = resolveChatRowHeightEstimate(long, { viewportWidth: 710 })
  assertEqual(longHeight > shortHeight, true, 'long command output should reserve more banner height')
  assertEqual(longHeight <= 300, true, 'command banners should honor the bounded CSS body height')
})

runCase('extreme payload estimates stay finite and bounded by linear work', () => {
  const estimate = {
    fixedHeight: 8,
    textShape: createChatTextHeightShape('x'.repeat(1_000_000)),
  }
  const height = resolveChatRowHeightEstimate(estimate, {
    viewportWidth: 291,
  })

  assertEqual(Number.isFinite(height), true, 'extreme estimates must stay finite')
  assertBetween(
    height,
    400_000,
    600_000,
    'a one-million-character row should remain a plausible linear estimate',
  )
  assertEqual(
    estimate.textShape.lineBuckets.length,
    2,
    'a long unbroken line should retain one compact bucket pair, not one entry per character',
  )
})

runCase('newline-heavy payloads keep a constant-size text shape', () => {
  const shape = createChatTextHeightShape('\n'.repeat(1_000_000))
  const height = resolveChatRowHeightEstimate(
    { fixedHeight: 8, textShape: shape },
    { viewportWidth: 291 },
  )

  assertEqual(
    shape.lineBuckets.length,
    0,
    'blank lines should be summarized by a counter instead of a million-entry array',
  )
  assertEqual(
    shape.blankLineCount,
    1_000_001,
    'every blank line including the trailing empty line should be retained',
  )
  assertEqual(
    Number.isFinite(height),
    true,
    'newline-heavy estimates must remain finite',
  )
})

runCase('repeated non-empty lines collapse into one histogram bucket', () => {
  const shape = createChatTextHeightShape('x\n'.repeat(500_000))

  assertEqual(
    shape.lineBuckets.length,
    2,
    'half a million equal-width lines should retain one histogram bucket pair',
  )
  assertEqual(
    shape.lineBuckets[1],
    500_000,
    'the histogram bucket should retain the exact repeated-line count',
  )
  assertEqual(
    shape.blankLineCount,
    1,
    'the trailing newline should retain one final blank line',
  )
})

runCase('fixed estimates ignore width and clamp invalid small values', () => {
  const estimate = createFixedChatRowHeightEstimate(-100)
  assertEqual(
    resolveChatRowHeightEstimate(estimate, { viewportWidth: 291 }),
    30,
    'invalid fixed estimates should clamp to the minimum row height',
  )
  assertEqual(
    resolveChatRowHeightEstimate(estimate, { viewportWidth: 753 }),
    30,
    'fixed estimates should remain width independent',
  )
})

console.log('All chat row height estimate extreme tests passed.')
