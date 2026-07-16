import type { ChatMessage } from '../../stores/ChatStore'
import {
  SEAMLESS_DETAIL_PREVIEW_LIMIT,
  buildSeamlessStepPresentation,
  getSeamlessDiffLineTone,
  getSeamlessGroupTone,
} from './seamlessToolPresentation'

const assertEqual = <T>(actual: T, expected: T, message: string): void => {
  if (actual !== expected) {
    throw new Error(
      `${message}. expected=${String(expected)} actual=${String(actual)}`,
    )
  }
}

const assertCondition = (condition: unknown, message: string): void => {
  if (!condition) throw new Error(message)
}

const createMessage = (
  overrides: Partial<ChatMessage> & Pick<ChatMessage, 'type'>,
): ChatMessage => ({
  id: 'message-1',
  role: 'assistant',
  type: overrides.type,
  content: overrides.content || '',
  timestamp: 1,
  ...(overrides.metadata ? { metadata: overrides.metadata } : {}),
  ...(typeof overrides.streaming === 'boolean'
    ? { streaming: overrides.streaming }
    : {}),
})

const runCase = (name: string, fn: () => void): void => {
  fn()
  console.log(`PASS ${name}`)
}

runCase(
  'skill activities expose the skill name and rich result details',
  () => {
    const presentation = buildSeamlessStepPresentation(
      createMessage({
        type: 'sub_tool',
        metadata: {
          subToolTitle: 'Skill',
          subToolHint: 'anysearch...',
          output:
            'name: anysearch\ndescription: Search the web\npath: /skills/anysearch/SKILL.md',
        },
      }),
    )

    assertEqual(
      presentation.fullSummary,
      'Skill · anysearch',
      'the collapsed summary should add information instead of repeating Skill',
    )
    assertEqual(
      presentation.details[0]?.label,
      'Result',
      'expanded Skill activity should expose its loaded result',
    )
    assertCondition(
      presentation.details[0]?.content.includes('/skills/anysearch/SKILL.md'),
      'the useful skill path should remain visible in expanded details',
    )
  },
)

runCase('tool calls format JSON input and keep result details separate', () => {
  const presentation = buildSeamlessStepPresentation(
    createMessage({
      type: 'tool_call',
      content: '{"query":"seamless mode","limit":5}',
      metadata: {
        toolName: 'search',
        output: '5 results',
      },
    }),
  )

  assertEqual(
    presentation.fullSummary,
    'search · query: seamless mode · limit: 5',
    'tool input should become a readable single-line summary',
  )
  assertEqual(
    presentation.details[0]?.content,
    '{\n  "query": "seamless mode",\n  "limit": 5\n}',
    'expanded input should be pretty-printed',
  )
  assertEqual(
    presentation.details[1]?.content,
    '5 results',
    'tool results should be retained as a distinct section',
  )
})

runCase('tool failures receive an error tone without false positives', () => {
  const failed = buildSeamlessStepPresentation(
    createMessage({
      type: 'tool_call',
      content: '{}',
      metadata: {
        toolName: 'read_command_output',
        output: 'Error: command history not found',
      },
    }),
  )
  const successful = buildSeamlessStepPresentation(
    createMessage({
      type: 'tool_call',
      content: '{}',
      metadata: {
        toolName: 'inspect_logs',
        output: 'Completed. The log contains Error: as quoted source text.',
      },
    }),
  )

  assertEqual(
    failed.tone,
    'error',
    'strong failure prefixes should be classified as failures',
  )
  assertEqual(
    successful.tone,
    'neutral',
    'error text embedded later in a successful result should stay neutral',
  )
})

runCase('structured tool failures receive an error tone', () => {
  const statusFailure = buildSeamlessStepPresentation(
    createMessage({
      type: 'tool_call',
      metadata: {
        toolName: 'structured_tool',
        output: JSON.stringify({ status: 'error', message: 'not available' }),
      },
    }),
  )
  const booleanFailure = buildSeamlessStepPresentation(
    createMessage({
      type: 'tool_call',
      metadata: {
        toolName: 'structured_tool',
        output: JSON.stringify({ ok: false, reason: 'blocked' }),
      },
    }),
  )
  const success = buildSeamlessStepPresentation(
    createMessage({
      type: 'tool_call',
      metadata: {
        toolName: 'structured_tool',
        output: JSON.stringify({ status: 'success', ok: true }),
      },
    }),
  )

  assertEqual(
    statusFailure.tone,
    'error',
    'error status should be classified as a failure',
  )
  assertEqual(
    booleanFailure.tone,
    'error',
    'ok=false should be classified as a failure',
  )
  assertEqual(success.tone, 'neutral', 'successful JSON should stay neutral')
})

runCase('explicit tool error levels handle unstructured exception messages', () => {
  const presentation = buildSeamlessStepPresentation(
    createMessage({
      type: 'tool_call',
      metadata: {
        toolName: 'mcp_server_call',
        output: 'Network timeout',
        subToolLevel: 'error',
      },
    }),
  )

  assertEqual(
    presentation.tone,
    'error',
    'producer-level error metadata should override unstructured output text',
  )
})

runCase('sub-tool failure output overrides a legacy info level', () => {
  const presentation = buildSeamlessStepPresentation(
    createMessage({
      type: 'sub_tool',
      metadata: {
        subToolTitle: 'Create terminal tab',
        subToolLevel: 'info',
        output: 'Failed to create terminal tab: connection refused',
      },
    }),
  )

  assertEqual(
    presentation.tone,
    'error',
    'legacy sub-tool failures should not render as completed activity',
  )
})

runCase(
  'commands expose execution state and output without repeating input',
  () => {
    const presentation = buildSeamlessStepPresentation(
      createMessage({
        type: 'command',
        content: 'npm run typecheck:web',
        metadata: {
          tabName: 'Local',
          exitCode: 0,
          output: 'Typecheck passed',
        },
      }),
    )

    assertEqual(
      presentation.fullSummary,
      '$ npm run typecheck:web · on Local',
      'the terminal target should be visible without another row',
    )
    assertEqual(
      presentation.meta,
      'Exit 0',
      'exit status should remain visible',
    )
    assertEqual(
      presentation.details[0]?.content,
      'Typecheck passed',
      'expanded commands should show output',
    )
  },
)

runCase('expanded details preserve whitespace-sensitive output', () => {
  const output = '  aligned\n'
  const presentation = buildSeamlessStepPresentation(
    createMessage({
      type: 'command',
      content: 'printf output',
      metadata: { output },
    }),
  )

  assertEqual(
    presentation.details[0]?.content,
    output,
    'preformatted output should keep its leading spaces and trailing newline',
  )
})

runCase('multiline commands retain their exact expanded input', () => {
  const rawCommand = "cat <<'EOF'\nfirst  value\nEOF"
  const presentation = buildSeamlessStepPresentation(
    createMessage({
      type: 'command',
      content: rawCommand,
    }),
  )

  assertEqual(
    presentation.details[0]?.label,
    'Command',
    'non-compact command input should receive a dedicated detail section',
  )
  assertEqual(
    presentation.details[0]?.content,
    rawCommand,
    'expanded input should retain newlines and repeated whitespace',
  )
})

runCase('long one-line commands remain expandable after truncation', () => {
  const rawCommand = `echo ${'x'.repeat(180)}`
  const presentation = buildSeamlessStepPresentation(
    createMessage({
      type: 'command',
      content: rawCommand,
    }),
  )

  assertEqual(
    presentation.summary.length,
    96,
    'the collapsed command should retain the compact summary limit',
  )
  assertEqual(
    presentation.details[0]?.content,
    rawCommand,
    'truncated commands should expose their full exact input on expansion',
  )
})

runCase('background commands keep their async sentinel out of error state', () => {
  const presentation = buildSeamlessStepPresentation(
    createMessage({
      type: 'command',
      content: 'npm run build',
      metadata: {
        exitCode: -3,
        isNowait: true,
      },
    }),
  )

  assertEqual(presentation.meta, 'Async', 'nowait commands should read Async')
  assertEqual(
    presentation.tone,
    'neutral',
    'the nowait transition sentinel is not a command failure',
  )
})

runCase('async commands still surface real startup failures', () => {
  const presentation = buildSeamlessStepPresentation(
    createMessage({
      type: 'command',
      content: 'blocked-command',
      metadata: {
        exitCode: -1,
        isNowait: true,
      },
    }),
  )

  assertEqual(
    presentation.meta,
    'Exit -1',
    'a real async startup failure should show its exit code',
  )
  assertEqual(
    presentation.tone,
    'error',
    'only the -3 background transition sentinel is non-failing',
  )
})

runCase('file edits expose diff counts and the actual diff preview', () => {
  const presentation = buildSeamlessStepPresentation(
    createMessage({
      type: 'file_edit',
      metadata: {
        action: 'edited',
        filePath: '/workspace/app.ts',
        diff: '@@ -1 +1 @@\n-old\n+new',
      },
    }),
  )

  assertEqual(presentation.meta, '+1 / −1', 'diff totals should be summarized')
  assertEqual(
    presentation.details[0]?.kind,
    'diff',
    'the expanded section should preserve diff semantics',
  )
})

runCase('long pathless file-edit errors remain expandable', () => {
  const error = `Failure: ${'x'.repeat(160)}`
  const presentation = buildSeamlessStepPresentation(
    createMessage({
      type: 'file_edit',
      content: error,
      metadata: { action: 'error' },
    }),
  )

  assertEqual(
    presentation.details[0]?.content,
    error,
    'a truncated pathless error should retain its full result',
  )
})

runCase('diff content beginning with repeated signs is not a file header', () => {
  const presentation = buildSeamlessStepPresentation(
    createMessage({
      type: 'file_edit',
      metadata: {
        action: 'edited',
        filePath: '/workspace/counter.ts',
        diff: '--- a/counter.ts\n+++ b/counter.ts\n---counter\n+++counter',
      },
    }),
  )

  assertEqual(
    presentation.meta,
    '+1 / −1',
    'content lines beginning with ++ or -- should count as changes',
  )
  assertEqual(
    getSeamlessDiffLineTone('+++ b/counter.ts'),
    'metadata',
    'spaced unified-diff file headers should remain metadata',
  )
  assertEqual(
    getSeamlessDiffLineTone('+++counter'),
    'addition',
    'unspaced changed content should retain addition coloring',
  )
  assertEqual(
    getSeamlessDiffLineTone('+++'),
    'addition',
    'an exact +++ hunk line is changed content, not a file header',
  )
  assertEqual(
    getSeamlessDiffLineTone('---'),
    'removal',
    'an exact --- hunk line is changed content, not a file header',
  )
})

runCase('case-sensitive tool results are not deduplicated', () => {
  const presentation = buildSeamlessStepPresentation(
    createMessage({
      type: 'tool_call',
      content: 'HELLO',
      metadata: {
        toolName: 'case_check',
        output: 'hello',
      },
    }),
  )

  assertEqual(
    presentation.details.length,
    2,
    'case-distinct input and output should both remain inspectable',
  )
  assertEqual(
    presentation.details[1]?.content,
    'hello',
    'the result casing should be preserved',
  )
})

runCase('large outputs are bounded and clearly marked as previews', () => {
  const presentation = buildSeamlessStepPresentation(
    createMessage({
      type: 'sub_tool',
      metadata: {
        subToolTitle: 'Large result',
        output: 'x'.repeat(SEAMLESS_DETAIL_PREVIEW_LIMIT + 200),
      },
    }),
  )
  const detail = presentation.details[0]

  assertEqual(detail?.truncated, true, 'oversized content should be bounded')
  assertCondition(
    (detail?.content.length || 0) <= SEAMLESS_DETAIL_PREVIEW_LIMIT + 2,
    'bounded previews should not render the full oversized result',
  )
})

runCase('large tool inputs are bounded before JSON formatting work', () => {
  const presentation = buildSeamlessStepPresentation(
    createMessage({
      type: 'tool_call',
      content: JSON.stringify({ payload: 'x'.repeat(50_000) }),
      metadata: { toolName: 'large_input' },
    }),
  )
  const detail = presentation.details[0]

  assertEqual(detail?.truncated, true, 'large inputs should become previews')
  assertCondition(
    (detail?.content.length || 0) <= SEAMLESS_DETAIL_PREVIEW_LIMIT + 2,
    'large input details should stay inside the shared preview limit',
  )
})

runCase('primitive JSON values remain visible in collapsed summaries', () => {
  const primitiveCases = [
    ['0', '0'],
    ['false', 'false'],
    ['null', 'null'],
  ]
  primitiveCases.forEach(([content, expected]) => {
    const presentation = buildSeamlessStepPresentation(
      createMessage({
        type: 'tool_call',
        content,
        metadata: { toolName: 'primitive' },
      }),
    )
    assertEqual(
      presentation.subtitle,
      expected,
      `${content} should remain visible`,
    )
  })
})

runCase('group tone preserves earlier failures and warnings', () => {
  const neutral = buildSeamlessStepPresentation(
    createMessage({ type: 'sub_tool', content: 'Done' }),
  )
  const warning = buildSeamlessStepPresentation(
    createMessage({
      type: 'sub_tool',
      content: 'Warning',
      metadata: { subToolLevel: 'warning' },
    }),
  )
  const error = buildSeamlessStepPresentation(
    createMessage({
      type: 'command',
      content: 'false',
      metadata: { exitCode: 1 },
    }),
  )

  assertEqual(
    getSeamlessGroupTone([error, neutral]),
    'error',
    'a later success must not hide an earlier failure',
  )
  assertEqual(
    getSeamlessGroupTone([warning, neutral]),
    'warning',
    'a later neutral step must not hide an earlier warning',
  )
})

console.log('All seamless tool presentation extreme tests passed.')
