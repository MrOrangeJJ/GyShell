import assert from 'node:assert/strict'
import { COMMAND_OUTPUT_IDENTIFIER_MAX_UTF8_BYTES } from '@gyshell/shared'
import { isValidTerminalRuntimeId } from '../terminal/terminalConnectionSupport'
import { terminalIdSchema } from './terminalIdContract'
import {
  encodeTerminalScopedFilePath,
  hasTerminalScopedFilePathPrefix,
  parseTerminalScopedFilePath,
  resolveTerminalScopedFileTarget
} from './terminalScopedFilePath'
import { editFileSchema, writeFileSchema } from './tools/edit_tools'
import { copyBetweenTabsSchema } from './tools/file_transfer_tools'
import { readFileSchema } from './tools/read_tools'
import {
  formatTerminalIdError,
  resolveTerminalForTool
} from './tools/terminal_runtime_guard'
import { closeTerminalTabSchema } from './tools/terminal_tab_lifecycle_tools'
import {
  execCommandSchema,
  readCommandOutputSchema,
  readTerminalTabSchema,
  reconnectTerminalTabSchema,
  writeStdinSchema
} from './tools/terminal_tools'
import { waitTerminalIdleSchema } from './tools/wait_tools'

function runCase(name: string, fn: () => void): void {
  try {
    fn()
    console.log(`ok - ${name}`)
  } catch (error) {
    console.error(`not ok - ${name}`)
    throw error
  }
}

runCase('terminal IDs are opaque and preserve valid Unicode and surrounding whitespace', () => {
  const terminalId = '  custom)(%/终端😀 ID  '
  const parsed = terminalIdSchema.parse(terminalId)
  assert.equal(parsed, terminalId)
  assert.equal(isValidTerminalRuntimeId(terminalId), true)
})

runCase('terminal ID validation rejects blank, control, and malformed Unicode values', () => {
  for (const invalid of [
    '',
    '   ',
    '\t',
    'terminal\nnewline',
    'terminal\u0000nul',
    'terminal\u007fdel',
    'terminal\u0085c1',
    `terminal${String.fromCharCode(0xd800)}`,
    `${String.fromCharCode(0xdc00)}terminal`
  ]) {
    assert.equal(
      terminalIdSchema.safeParse(invalid).success,
      false,
      `expected invalid terminal ID: ${JSON.stringify(invalid)}`
    )
    assert.equal(isValidTerminalRuntimeId(invalid), false)
  }
})

runCase('terminal ID validation enforces the exact UTF-8 byte boundary', () => {
  const asciiBoundary = 'a'.repeat(COMMAND_OUTPUT_IDENTIFIER_MAX_UTF8_BYTES)
  const unicodeBoundary = '😀'.repeat(
    COMMAND_OUTPUT_IDENTIFIER_MAX_UTF8_BYTES / 4
  )
  assert.equal(Buffer.byteLength(asciiBoundary, 'utf8'), 1024)
  assert.equal(Buffer.byteLength(unicodeBoundary, 'utf8'), 1024)
  assert.equal(terminalIdSchema.safeParse(asciiBoundary).success, true)
  assert.equal(terminalIdSchema.safeParse(unicodeBoundary).success, true)
  assert.equal(terminalIdSchema.safeParse(`${asciiBoundary}a`).success, false)
  assert.equal(terminalIdSchema.safeParse(`${unicodeBoundary}a`).success, false)
})

runCase('all model-visible terminal schemas reject legacy or mixed selectors', () => {
  const cases: Array<{
    schema: { safeParse(value: unknown): { success: boolean } }
    canonical: Record<string, unknown>
  }> = [
    {
      schema: execCommandSchema,
      canonical: { terminalId: 'exact', command: 'pwd', waitMode: 'wait' }
    },
    {
      schema: readTerminalTabSchema,
      canonical: { terminalId: 'exact', lines: 20 }
    },
    {
      schema: readCommandOutputSchema,
      canonical: { terminalId: 'exact', history_command_match_id: 'command-id' }
    },
    {
      schema: readFileSchema,
      canonical: { terminalId: 'exact', filePath: '/tmp/a' }
    },
    {
      schema: writeStdinSchema,
      canonical: { terminalId: 'exact', sequence: ['LF'] }
    },
    {
      schema: reconnectTerminalTabSchema,
      canonical: { terminalId: 'exact' }
    },
    {
      schema: closeTerminalTabSchema,
      canonical: { terminalId: 'exact' }
    },
    {
      schema: writeFileSchema,
      canonical: { terminalId: 'exact', filePath: '/tmp/a', content: 'x' }
    },
    {
      schema: editFileSchema,
      canonical: {
        terminalId: 'exact',
        filePath: '/tmp/a',
        oldString: 'x',
        newString: 'y'
      }
    },
    {
      schema: waitTerminalIdleSchema,
      canonical: { terminalId: 'exact' }
    }
  ]

  for (const { schema, canonical } of cases) {
    assert.equal(schema.safeParse(canonical).success, true)
    assert.equal(
      schema.safeParse({ ...canonical, tabIdOrName: 'legacy-title' }).success,
      false
    )
  }

  const canonicalCopy = {
    sourceTerminalId: 'source-id',
    sourcePaths: ['/tmp/a'],
    targetTerminalId: 'target-id',
    targetDirPath: '/tmp'
  }
  assert.equal(copyBetweenTabsSchema.safeParse(canonicalCopy).success, true)
  assert.equal(
    copyBetweenTabsSchema.safeParse({
      ...canonicalCopy,
      sourceTabIdOrName: 'legacy-source'
    }).success,
    false
  )
  assert.equal(
    copyBetweenTabsSchema.safeParse({
      ...canonicalCopy,
      targetTabIdOrName: 'legacy-target'
    }).success,
    false
  )
})

runCase('terminal scoped paths round-trip opaque IDs and preserve path bytes', () => {
  const terminalId = '  id)(%/终端😀  '
  const filePath = '\n /tmp/(report)%/终端.txt \n'
  const encoded = encodeTerminalScopedFilePath(terminalId, filePath)
  assert.match(encoded, /^@terminal\([^)]*\):/)
  assert.equal(encoded.includes('%28'), true)
  assert.equal(encoded.includes('%29'), true)
  assert.deepEqual(parseTerminalScopedFilePath(encoded), {
    terminalId,
    filePath
  })
  assert.deepEqual(resolveTerminalScopedFileTarget(terminalId, encoded), {
    ok: true,
    terminalId,
    filePath
  })
})

runCase('terminal scoped paths fail closed on malformed or conflicting metadata', () => {
  for (const malformed of [
    '@terminal(%E0%A4%A):/tmp/a',
    '@terminal(id):',
    '@terminal():/tmp/a',
    ' @terminal(id):/tmp/a'
  ]) {
    assert.equal(hasTerminalScopedFilePathPrefix(malformed), true)
    const result = resolveTerminalScopedFileTarget('id', malformed)
    assert.equal(result.ok, false)
  }

  const conflict = resolveTerminalScopedFileTarget(
    'terminal-A',
    encodeTerminalScopedFilePath('terminal-B', '/tmp/a')
  )
  assert.equal(conflict.ok, false)
  assert.match(conflict.ok ? '' : conflict.message, /conflicts/)
})

runCase('runtime resolution is exact-ID-only and never falls back to a title', () => {
  const terminal = {
    id: 'Exact-ID',
    title: 'Friendly Name',
    type: 'local',
    runtimeState: 'ready'
  }
  let legacyResolverCalls = 0
  const terminalService = {
    getTerminalById: (terminalId: string) =>
      terminalId === terminal.id ? terminal : undefined,
    getDisplayTerminals: () => [terminal],
    getTerminalRuntimeSnapshot: (terminalId: string) =>
      terminalId === terminal.id
        ? {
            ...terminal,
            isInitializing: false,
            reconnectable: false,
            canRunCommand: true,
            canWrite: true,
            canUseFilesystem: true
          }
        : null,
    resolveTerminal: () => {
      legacyResolverCalls += 1
      return { found: [terminal], bestMatch: terminal }
    }
  }

  assert.equal(
    resolveTerminalForTool({ terminalService } as any, terminal.id).ok,
    true
  )
  const titleResult = resolveTerminalForTool(
    { terminalService } as any,
    terminal.title
  )
  assert.equal(titleResult.ok, false)
  assert.match(titleResult.ok ? '' : titleResult.message, /Exact-ID/)
  assert.equal(
    resolveTerminalForTool({ terminalService } as any, 'exact-id').ok,
    false
  )
  assert.equal(legacyResolverCalls, 0)
})

runCase('terminal resolution diagnostics remain within a total UTF-8 budget', () => {
  const availableTerminals = Array.from({ length: 100 }, (_, index) => ({
    id: `${String(index).padStart(3, '0')}-${'界'.repeat(339)}`
  }))
  const message = formatTerminalIdError(
    'terminal tab',
    'supplied-'.repeat(10_000),
    availableTerminals
  )
  assert.equal(Buffer.byteLength(message, 'utf8') <= 16 * 1024, true)
  const resolutionLine = message
    .split('\n')
    .find((line) => line.startsWith('terminal_id_resolution: '))
  assert.ok(resolutionLine)
  const resolution = JSON.parse(
    resolutionLine.slice('terminal_id_resolution: '.length)
  )
  assert.equal(resolution.status, 'not_found')
  assert.equal(resolution.suppliedTerminalIdTruncated, true)
  assert.equal(resolution.suppliedTerminalIdUtf8Bytes, 90_000)
  assert.equal(resolution.availableTerminalIds.length <= 64, true)
  assert.equal(resolution.availableTerminalIdsTruncated, true)
  assert.equal(resolution.availableTerminalCount, 100)
})
