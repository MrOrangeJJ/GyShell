import { z } from 'zod'
import { createTwoFilesPatch } from 'diff'
import type {
  TerminalRuntimeGuard,
  TerminalService
} from '../../TerminalService'
import type { TerminalTab } from '../../../types'
import type { ToolExecutionContext } from '../types'
import { resolveTerminalScopedFileTarget } from '../terminalScopedFilePath'
import { terminalIdSchema } from '../terminalIdContract'
import {
  formatTerminalUnavailableForTool,
  resolveTerminalForTool
} from './terminal_runtime_guard'
import {
  EDIT_FILE_TOOL_NAME,
  LEGACY_CREATE_OR_EDIT_TOOL_NAME,
  WRITE_FILE_TOOL_NAME
} from '../tool_capabilities'

export const editFileSchema = z.object({
  terminalId: terminalIdSchema,
  filePath: z
    .string()
    .describe(
      'File path to edit. Use an absolute path when possible. If a relative path is provided, it will be resolved from the terminal tab working directory.'
    ),
  oldString: z
    .string()
    .min(1, 'oldString must not be empty; use write_file to create or overwrite full files.')
    .describe(
      'Exact text to replace. Must match file content precisely (including indentation and line breaks). Provide enough surrounding context to make it unique.'
    ),
  newString: z
    .string()
    .describe('Replacement text (must be different from oldString). Keep indentation consistent.'),
  replaceAll: z
    .boolean()
    .optional()
    .describe('Replace all occurrences of oldString (default false). Use for safe bulk renames.')
}).strict()

export const writeFileSchema = z.object({
  terminalId: terminalIdSchema,
  filePath: z
    .string()
    .describe(
      'File path to write. Use an absolute path when possible. If a relative path is provided, it will be resolved from the terminal tab working directory.'
    ),
  content: z.string().describe('The full content to write to the file (overwrites existing content).')
}).strict()

export const writeAndEditSchema = z
  .object({
    terminalId: terminalIdSchema,
    filePath: z
      .string()
      .describe(
        'File path to edit or write. Use an absolute path when possible. If a relative path is provided, it will be resolved from the terminal tab working directory.'
      ),
    content: z.string().optional().describe('Full content to write (write mode).'),
    oldString: z.string().optional().describe('Exact text to replace (edit mode).'),
    newString: z.string().optional().describe('Replacement text (edit mode).'),
    replaceAll: z.boolean().optional().describe('Replace all occurrences when in edit mode.')
  })
  .strict()
  .superRefine((val, ctx) => {
    const hasContent = typeof val.content === 'string'
    const hasOld = typeof val.oldString === 'string'
    const hasNew = typeof val.newString === 'string'
    const hasMeaningfulContent = hasContent && val.content !== ''
    const hasMeaningfulEditField =
      (hasOld && val.oldString !== '') || (hasNew && val.newString !== '')

    if (hasMeaningfulContent && hasMeaningfulEditField) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Provide either content (write) OR oldString/newString (edit), not both.'
      })
      return
    }

    if (!hasMeaningfulContent && hasOld !== hasNew) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Both oldString and newString are required for edit mode.'
      })
      return
    }

    if (!hasContent && !hasOld) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Provide content for write mode or oldString/newString for edit mode.'
      })
    }
  })

export interface EditToolResult {
  output: string
  diff: string
  action: 'created' | 'edited'
  filePath: string
}

export async function runEditTool(
  args: z.infer<typeof editFileSchema>,
  opts: {
    terminalService: TerminalService
    terminal: TerminalTab
    runtimeGuard?: TerminalRuntimeGuard
    signal?: AbortSignal
  }
): Promise<EditToolResult> {
  const validation = editFileSchema.safeParse(args)
  if (!validation.success) {
    throw new Error(`Parameter validation error for edit_file: ${validation.error.message}`)
  }
  const validatedArgs = validation.data
  if (validatedArgs.oldString === validatedArgs.newString) {
    throw new Error('oldString and newString must be different')
  }

  const { terminalService, terminal, runtimeGuard, signal } = opts
  const filePath = validatedArgs.filePath

  if (signal?.aborted) throw new Error('AbortError')
  const stat = await terminalService.statFile(
    terminal.id,
    filePath,
    runtimeGuard
  )
  if (signal?.aborted) throw new Error('AbortError')

  if (!stat.exists) {
    throw new Error(`File not found: ${filePath}`)
  }
  if (stat.isDirectory) {
    throw new Error(`Path is a directory, not a file: ${filePath}`)
  }

  if (signal?.aborted) throw new Error('AbortError')
  const contentOld = (
    await terminalService.readFile(terminal.id, filePath, runtimeGuard)
  ).toString('utf8')
  if (signal?.aborted) throw new Error('AbortError')

  const contentNew = replace(
    contentOld,
    validatedArgs.oldString,
    validatedArgs.newString,
    validatedArgs.replaceAll
  )
  if (signal?.aborted) throw new Error('AbortError')
  await terminalService.writeFile(
    terminal.id,
    filePath,
    contentNew,
    runtimeGuard
  )
  if (signal?.aborted) throw new Error('AbortError')
  const contentAfter = (
    await terminalService.readFile(terminal.id, filePath, runtimeGuard)
  ).toString('utf8')
  if (signal?.aborted) throw new Error('AbortError')
  if (contentAfter !== contentNew) {
    throw new Error(
      'File verification failed after edit; the stored content does not match the intended replacement.'
    )
  }

  const diff = trimDiff(
    createTwoFilesPatch(
      filePath,
      filePath,
      normalizeLineEndings(contentOld),
      normalizeLineEndings(contentAfter)
    )
  )

  return {
    output: 'Edit applied and verified successfully.',
    diff,
    action: 'edited',
    filePath
  }
}

export interface WriteToolResult {
  output: string
  diff: string
  action: 'created' | 'edited'
  filePath: string
}

export async function runWriteTool(
  args: z.infer<typeof writeFileSchema>,
  opts: {
    terminalService: TerminalService
    terminal: TerminalTab
    runtimeGuard?: TerminalRuntimeGuard
    signal?: AbortSignal
  }
): Promise<WriteToolResult> {
  const validation = writeFileSchema.safeParse(args)
  if (!validation.success) {
    throw new Error(`Parameter validation error for write_file: ${validation.error.message}`)
  }
  const validatedArgs = validation.data
  const { terminalService, terminal, runtimeGuard, signal } = opts
  const filePath = validatedArgs.filePath
  if (signal?.aborted) throw new Error('AbortError')
  const stat = await terminalService.statFile(
    terminal.id,
    filePath,
    runtimeGuard
  )
  if (signal?.aborted) throw new Error('AbortError')

  if (stat.exists && stat.isDirectory) {
    throw new Error(`Path is a directory, not a file: ${filePath}`)
  }

  if (signal?.aborted) throw new Error('AbortError')
  const contentOld = stat.exists
    ? (
        await terminalService.readFile(
          terminal.id,
          filePath,
          runtimeGuard
        )
      ).toString('utf8')
    : ''
  if (signal?.aborted) throw new Error('AbortError')

  await terminalService.writeFile(
    terminal.id,
    filePath,
    validatedArgs.content,
    runtimeGuard
  )
  if (signal?.aborted) throw new Error('AbortError')
  const contentAfter = (
    await terminalService.readFile(terminal.id, filePath, runtimeGuard)
  ).toString('utf8')
  if (signal?.aborted) throw new Error('AbortError')
  if (contentAfter !== validatedArgs.content) {
    throw new Error(
      'File verification failed after write; the stored content does not match the requested content.'
    )
  }
  const diff = trimDiff(
    createTwoFilesPatch(filePath, filePath, contentOld, contentAfter)
  )

  return {
    output: 'Wrote file successfully. The stored content was verified after writing.',
    diff,
    action: stat.exists ? 'edited' : 'created',
    filePath
  }
}


function normalizeLineEndings(text: string): string {
  return text.split('\r\n').join('\n')
}

export type Replacer = (content: string, find: string) => Generator<string, void, unknown>

const SINGLE_CANDIDATE_SIMILARITY_THRESHOLD = 0.0
const MULTIPLE_CANDIDATES_SIMILARITY_THRESHOLD = 0.3

function levenshtein(a: string, b: string): number {
  if (a === '' || b === '') {
    return Math.max(a.length, b.length)
  }
  const matrix = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  )

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      matrix[i][j] = Math.min(matrix[i - 1][j] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j - 1] + cost)
    }
  }
  return matrix[a.length][b.length]
}

export const SimpleReplacer: Replacer = function* (_content, find) {
  yield find
}

export const LineTrimmedReplacer: Replacer = function* (content, find) {
  const originalLines = content.split('\n')
  const searchLines = find.split('\n')

  if (searchLines[searchLines.length - 1] === '') {
    searchLines.pop()
  }

  for (let i = 0; i <= originalLines.length - searchLines.length; i++) {
    let matches = true

    for (let j = 0; j < searchLines.length; j++) {
      const originalTrimmed = originalLines[i + j].trim()
      const searchTrimmed = searchLines[j].trim()

      if (originalTrimmed !== searchTrimmed) {
        matches = false
        break
      }
    }

    if (matches) {
      let matchStartIndex = 0
      for (let k = 0; k < i; k++) {
        matchStartIndex += originalLines[k].length + 1
      }

      let matchEndIndex = matchStartIndex
      for (let k = 0; k < searchLines.length; k++) {
        matchEndIndex += originalLines[i + k].length
        if (k < searchLines.length - 1) {
          matchEndIndex += 1
        }
      }

      yield content.substring(matchStartIndex, matchEndIndex)
    }
  }
}

export const BlockAnchorReplacer: Replacer = function* (content, find) {
  const originalLines = content.split('\n')
  const searchLines = find.split('\n')

  if (searchLines.length < 3) {
    return
  }

  if (searchLines[searchLines.length - 1] === '') {
    searchLines.pop()
  }

  const firstLineSearch = searchLines[0].trim()
  const lastLineSearch = searchLines[searchLines.length - 1].trim()
  const searchBlockSize = searchLines.length

  const candidates: Array<{ startLine: number; endLine: number }> = []
  for (let i = 0; i < originalLines.length; i++) {
    if (originalLines[i].trim() !== firstLineSearch) {
      continue
    }

    for (let j = i + 2; j < originalLines.length; j++) {
      if (originalLines[j].trim() === lastLineSearch) {
        candidates.push({ startLine: i, endLine: j })
        break
      }
    }
  }

  if (candidates.length === 0) {
    return
  }

  if (candidates.length === 1) {
    const { startLine, endLine } = candidates[0]
    const actualBlockSize = endLine - startLine + 1

    let similarity = 0
    let linesToCheck = Math.min(searchBlockSize - 2, actualBlockSize - 2)

    if (linesToCheck > 0) {
      for (let j = 1; j < searchBlockSize - 1 && j < actualBlockSize - 1; j++) {
        const originalLine = originalLines[startLine + j].trim()
        const searchLine = searchLines[j].trim()
        const maxLen = Math.max(originalLine.length, searchLine.length)
        if (maxLen === 0) {
          continue
        }
        const distance = levenshtein(originalLine, searchLine)
        similarity += (1 - distance / maxLen) / linesToCheck

        if (similarity >= SINGLE_CANDIDATE_SIMILARITY_THRESHOLD) {
          break
        }
      }
    } else {
      similarity = 1.0
    }

    if (similarity >= SINGLE_CANDIDATE_SIMILARITY_THRESHOLD) {
      let matchStartIndex = 0
      for (let k = 0; k < startLine; k++) {
        matchStartIndex += originalLines[k].length + 1
      }
      let matchEndIndex = matchStartIndex
      for (let k = startLine; k <= endLine; k++) {
        matchEndIndex += originalLines[k].length
        if (k < endLine) {
          matchEndIndex += 1
        }
      }
      yield content.substring(matchStartIndex, matchEndIndex)
    }
    return
  }

  let bestMatch: { startLine: number; endLine: number } | null = null
  let maxSimilarity = -1

  for (const candidate of candidates) {
    const { startLine, endLine } = candidate
    const actualBlockSize = endLine - startLine + 1

    let similarity = 0
    let linesToCheck = Math.min(searchBlockSize - 2, actualBlockSize - 2)

    if (linesToCheck > 0) {
      for (let j = 1; j < searchBlockSize - 1 && j < actualBlockSize - 1; j++) {
        const originalLine = originalLines[startLine + j].trim()
        const searchLine = searchLines[j].trim()
        const maxLen = Math.max(originalLine.length, searchLine.length)
        if (maxLen === 0) {
          continue
        }
        const distance = levenshtein(originalLine, searchLine)
        similarity += 1 - distance / maxLen
      }
      similarity /= linesToCheck
    } else {
      similarity = 1.0
    }

    if (similarity > maxSimilarity) {
      maxSimilarity = similarity
      bestMatch = candidate
    }
  }

  if (maxSimilarity >= MULTIPLE_CANDIDATES_SIMILARITY_THRESHOLD && bestMatch) {
    const { startLine, endLine } = bestMatch
    let matchStartIndex = 0
    for (let k = 0; k < startLine; k++) {
      matchStartIndex += originalLines[k].length + 1
    }
    let matchEndIndex = matchStartIndex
    for (let k = startLine; k <= endLine; k++) {
      matchEndIndex += originalLines[k].length
      if (k < endLine) {
        matchEndIndex += 1
      }
    }
    yield content.substring(matchStartIndex, matchEndIndex)
  }
}

export const WhitespaceNormalizedReplacer: Replacer = function* (content, find) {
  const normalizeWhitespace = (text: string) => text.replace(/\s+/g, ' ').trim()
  const normalizedFind = normalizeWhitespace(find)

  const lines = content.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (normalizeWhitespace(line) === normalizedFind) {
      yield line
    } else {
      const normalizedLine = normalizeWhitespace(line)
      if (normalizedLine.includes(normalizedFind)) {
        const words = find.trim().split(/\s+/)
        if (words.length > 0) {
          const pattern = words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+')
          try {
            const regex = new RegExp(pattern)
            const match = line.match(regex)
            if (match) {
              yield match[0]
            }
          } catch {
            // ignore
          }
        }
      }
    }
  }

  const findLines = find.split('\n')
  if (findLines.length > 1) {
    for (let i = 0; i <= lines.length - findLines.length; i++) {
      const block = lines.slice(i, i + findLines.length)
      if (normalizeWhitespace(block.join('\n')) === normalizedFind) {
        yield block.join('\n')
      }
    }
  }
}

export const IndentationFlexibleReplacer: Replacer = function* (content, find) {
  const removeIndentation = (text: string) => {
    const lines = text.split('\n')
    const nonEmptyLines = lines.filter((line) => line.trim().length > 0)
    if (nonEmptyLines.length === 0) return text

    const minIndent = Math.min(
      ...nonEmptyLines.map((line) => {
        const match = line.match(/^(\s*)/)
        return match ? match[1].length : 0
      })
    )

    return lines.map((line) => (line.trim().length === 0 ? line : line.slice(minIndent))).join('\n')
  }

  const normalizedFind = removeIndentation(find)
  const contentLines = content.split('\n')
  const findLines = find.split('\n')

  for (let i = 0; i <= contentLines.length - findLines.length; i++) {
    const block = contentLines.slice(i, i + findLines.length).join('\n')
    if (removeIndentation(block) === normalizedFind) {
      yield block
    }
  }
}

export const EscapeNormalizedReplacer: Replacer = function* (content, find) {
  const unescapeString = (str: string): string => {
    return str.replace(/\\(n|t|r|'|"|`|\\|\n|\$)/g, (match, capturedChar) => {
      switch (capturedChar) {
        case 'n':
          return '\n'
        case 't':
          return '\t'
        case 'r':
          return '\r'
        case "'":
          return "'"
        case '"':
          return '"'
        case '`':
          return '`'
        case '\\':
          return '\\'
        case '\n':
          return '\n'
        case '$':
          return '$'
        default:
          return match
      }
    })
  }

  const unescapedFind = unescapeString(find)

  if (content.includes(unescapedFind)) {
    yield unescapedFind
  }

  const lines = content.split('\n')
  const findLines = unescapedFind.split('\n')

  for (let i = 0; i <= lines.length - findLines.length; i++) {
    const block = lines.slice(i, i + findLines.length).join('\n')
    const unescapedBlock = unescapeString(block)

    if (unescapedBlock === unescapedFind) {
      yield block
    }
  }
}

export const MultiOccurrenceReplacer: Replacer = function* (content, find) {
  let startIndex = 0

  while (true) {
    const index = content.indexOf(find, startIndex)
    if (index === -1) break

    yield find
    startIndex = index + find.length
  }
}

export const TrimmedBoundaryReplacer: Replacer = function* (content, find) {
  const trimmedFind = find.trim()

  if (trimmedFind === find) {
    return
  }

  if (content.includes(trimmedFind)) {
    yield trimmedFind
  }

  const lines = content.split('\n')
  const findLines = find.split('\n')

  for (let i = 0; i <= lines.length - findLines.length; i++) {
    const block = lines.slice(i, i + findLines.length).join('\n')

    if (block.trim() === trimmedFind) {
      yield block
    }
  }
}

export const ContextAwareReplacer: Replacer = function* (content, find) {
  const findLines = find.split('\n')
  if (findLines.length < 3) {
    return
  }

  if (findLines[findLines.length - 1] === '') {
    findLines.pop()
  }

  const contentLines = content.split('\n')

  const firstLine = findLines[0].trim()
  const lastLine = findLines[findLines.length - 1].trim()

  for (let i = 0; i < contentLines.length; i++) {
    if (contentLines[i].trim() !== firstLine) continue

    for (let j = i + 2; j < contentLines.length; j++) {
      if (contentLines[j].trim() === lastLine) {
        const blockLines = contentLines.slice(i, j + 1)
        const block = blockLines.join('\n')

        if (blockLines.length === findLines.length) {
          let matchingLines = 0
          let totalNonEmptyLines = 0

          for (let k = 1; k < blockLines.length - 1; k++) {
            const blockLine = blockLines[k].trim()
            const findLine = findLines[k].trim()

            if (blockLine.length > 0 || findLine.length > 0) {
              totalNonEmptyLines++
              if (blockLine === findLine) {
                matchingLines++
              }
            }
          }

          if (totalNonEmptyLines === 0 || matchingLines / totalNonEmptyLines >= 0.5) {
            yield block
            break
          }
        }
        break
      }
    }
  }
}

export function trimDiff(diff: string): string {
  const lines = diff.split('\n')
  const contentLines = lines.filter(
    (line) =>
      (line.startsWith('+') || line.startsWith('-') || line.startsWith(' ')) &&
      !line.startsWith('---') &&
      !line.startsWith('+++')
  )

  if (contentLines.length === 0) return diff

  let min = Infinity
  for (const line of contentLines) {
    const content = line.slice(1)
    if (content.trim().length > 0) {
      const match = content.match(/^(\s*)/)
      if (match) min = Math.min(min, match[1].length)
    }
  }
  if (min === Infinity || min === 0) return diff
  const trimmedLines = lines.map((line) => {
    if (
      (line.startsWith('+') || line.startsWith('-') || line.startsWith(' ')) &&
      !line.startsWith('---') &&
      !line.startsWith('+++')
    ) {
      const prefix = line[0]
      const content = line.slice(1)
      return prefix + content.slice(min)
    }
    return line
  })

  return trimmedLines.join('\n')
}

export function replace(content: string, oldString: string, newString: string, replaceAll = false): string {
  if (oldString === newString) {
    throw new Error('oldString and newString must be different')
  }

  let notFound = true

  for (const replacer of [
    SimpleReplacer,
    LineTrimmedReplacer,
    BlockAnchorReplacer,
    WhitespaceNormalizedReplacer,
    IndentationFlexibleReplacer,
    EscapeNormalizedReplacer,
    TrimmedBoundaryReplacer,
    ContextAwareReplacer,
    MultiOccurrenceReplacer
  ]) {
    for (const search of replacer(content, oldString)) {
      const index = content.indexOf(search)
      if (index === -1) continue
      notFound = false
      if (replaceAll) {
        return content.split(search).join(newString)
      }
      const lastIndex = content.lastIndexOf(search)
      if (index !== lastIndex) continue
      return content.substring(0, index) + newString + content.substring(index + search.length)
    }
  }

  if (notFound) {
    throw new Error('oldString not found in content')
  }
  throw new Error('Found multiple matches for oldString. Provide more surrounding lines in oldString to identify the correct match.')
}

type FileMutationArgs = {
  terminalId: string
  filePath: string
}

type FileMutationResult = WriteToolResult | EditToolResult

function formatFileMutationOutput(result: FileMutationResult): string {
  const actionLine =
    result.action === 'created' ? `Created file: ${result.filePath}` : `Edited file: ${result.filePath}`
  return result.diff ? `${actionLine}\n${result.output}\n\n${result.diff}` : `${actionLine}\n${result.output}`
}

async function runFileMutationTool(
  args: FileMutationArgs,
  context: ToolExecutionContext,
  toolName: string,
  unavailableOperation: string,
  runner: (params: {
    terminalId: string
    filePath: string
    terminalService: TerminalService
    terminal: TerminalTab
    runtimeGuard?: TerminalRuntimeGuard
    signal?: AbortSignal
  }) => Promise<FileMutationResult>
): Promise<string> {
  const target = resolveTerminalScopedFileTarget(
    args.terminalId,
    args.filePath
  )
  const filePathInput = target.ok ? target.filePath : args.filePath
  const { terminalService, sessionId, messageId, sendEvent } = context
  
  if (context.signal?.aborted) throw new Error('AbortError')

  if (!target.ok) {
    sendEvent(sessionId, {
      messageId,
      type: 'tool_call',
      toolName,
      input: JSON.stringify(args),
      output: target.message
    })
    return target.message
  }

  const resolved = resolveTerminalForTool(context, target.terminalId)
  if (!resolved.ok) {
    const errorText = resolved.message
    sendEvent(sessionId, {
      messageId,
      type: 'tool_call',
      toolName,
      input: JSON.stringify(args),
      output: errorText
    })
    return errorText
  }
  const bestMatch = resolved.terminal

  if (!resolved.snapshot.canUseFilesystem) {
    const errorText =
      bestMatch.capabilities?.supportsFilesystem !== true &&
      resolved.snapshot.runtimeState === 'ready'
        ? `Error: Terminal tab "${bestMatch.title || bestMatch.id}" (id=${bestMatch.id}, type=${bestMatch.type}) does not support filesystem operations.`
        : formatTerminalUnavailableForTool(
            resolved.snapshot,
            unavailableOperation
          )
    sendEvent(sessionId, {
      messageId,
      type: 'file_edit',
      toolName,
      output: errorText,
      filePath: filePathInput,
      action: 'error',
      diff: ''
    })
    return errorText
  }

  let outputText = ''
  let diffText = ''
  let action: 'created' | 'edited' | 'error' = 'edited'
  let filePath = filePathInput
  try {
    const result = await runner({
      terminalId: target.terminalId,
      filePath: filePathInput,
      terminalService,
      terminal: bestMatch,
      runtimeGuard: resolved.runtimeGuard,
      signal: context.signal
    })
    outputText = formatFileMutationOutput(result)
    diffText = result.diff
    action = result.action
    filePath = result.filePath
  } catch (err) {
    if (
      context.signal?.aborted ||
      (err instanceof Error &&
        (err.name === 'AbortError' || err.message === 'AbortError'))
    ) {
      const abortError = new Error('AbortError')
      abortError.name = 'AbortError'
      throw abortError
    }
    outputText = err instanceof Error ? err.message : String(err)
    action = 'error'
  }

  if (context.signal?.aborted) {
    const abortError = new Error('AbortError')
    abortError.name = 'AbortError'
    throw abortError
  }
  sendEvent(sessionId, {
    messageId,
    type: 'file_edit',
    toolName,
    output: outputText,
    filePath,
    action,
    diff: diffText
  })

  return outputText
}

export async function writeFile(
  args: z.infer<typeof writeFileSchema>,
  context: ToolExecutionContext,
  toolName = WRITE_FILE_TOOL_NAME
): Promise<string> {
  const validation = writeFileSchema.safeParse(args)
  if (!validation.success) {
    return `Parameter validation error for ${toolName}: ${validation.error.message}`
  }
  const validatedArgs = validation.data
  return await runFileMutationTool(
    validatedArgs,
    context,
    toolName,
    'write files through this terminal',
    async ({
      terminalId,
      filePath,
      terminalService,
      terminal,
      runtimeGuard,
      signal
    }) =>
      await runWriteTool(
        { terminalId, filePath, content: validatedArgs.content },
        { terminalService, terminal, runtimeGuard, signal }
      )
  )
}

export async function editFile(
  args: z.infer<typeof editFileSchema>,
  context: ToolExecutionContext,
  toolName = EDIT_FILE_TOOL_NAME
): Promise<string> {
  const validation = editFileSchema.safeParse(args)
  if (!validation.success) {
    return `Parameter validation error for ${toolName}: ${validation.error.message}`
  }
  const validatedArgs = validation.data
  return await runFileMutationTool(
    validatedArgs,
    context,
    toolName,
    'edit files through this terminal',
    async ({
      terminalId,
      filePath,
      terminalService,
      terminal,
      runtimeGuard,
      signal
    }) =>
      await runEditTool(
        {
          terminalId,
          filePath,
          oldString: validatedArgs.oldString,
          newString: validatedArgs.newString,
          replaceAll: validatedArgs.replaceAll
        },
        { terminalService, terminal, runtimeGuard, signal }
      )
  )
}

function normalizeLegacyWriteAndEditArgs(args: any):
  | { mode: 'write'; args: z.infer<typeof writeFileSchema> }
  | { mode: 'edit'; args: z.infer<typeof editFileSchema> } {
  const hasContent = typeof args.content === 'string'
  const hasOld = typeof args.oldString === 'string'
  const hasNew = typeof args.newString === 'string'
  const hasMeaningfulEditField =
    (hasOld && args.oldString !== '') || (hasNew && args.newString !== '')

  if (hasContent && !hasMeaningfulEditField) {
    return {
      mode: 'write',
      args: {
        terminalId: args.terminalId,
        filePath: args.filePath,
        content: args.content
      }
    }
  }

  if (hasOld && hasNew && args.oldString === '') {
    if (args.newString === '') {
      throw new Error('Provide content for write mode or a non-empty oldString for edit mode.')
    }
    return {
      mode: 'write',
      args: {
        terminalId: args.terminalId,
        filePath: args.filePath,
        content: args.newString
      }
    }
  }

  if (hasOld && hasNew) {
    return {
      mode: 'edit',
      args: {
        terminalId: args.terminalId,
        filePath: args.filePath,
        oldString: args.oldString,
        newString: args.newString,
        replaceAll: args.replaceAll
      }
    }
  }

  throw new Error('Provide content for write mode or oldString/newString for edit mode.')
}

export async function writeAndEdit(args: any, context: ToolExecutionContext): Promise<string> {
  const validation = writeAndEditSchema.safeParse(args)
  if (!validation.success) {
    return `Parameter validation error for ${LEGACY_CREATE_OR_EDIT_TOOL_NAME}: ${validation.error.message}`
  }
  const normalized = normalizeLegacyWriteAndEditArgs(validation.data)
  if (normalized.mode === 'write') {
    return await writeFile(normalized.args, context, LEGACY_CREATE_OR_EDIT_TOOL_NAME)
  }
  return await editFile(normalized.args, context, LEGACY_CREATE_OR_EDIT_TOOL_NAME)
}
