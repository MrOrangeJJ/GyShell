import {
  hasOnlyPairedUtf16Surrogates,
  isValidTerminalRuntimeId,
  readOpaqueNonBlankWellFormedString
} from '@gyshell/shared'

export interface TerminalScopedFilePath {
  terminalId: string
  filePath: string
}

const TERMINAL_SCOPED_FILE_PATH_PREFIX = '@terminal('
const TERMINAL_SCOPED_FILE_PATH_REGEX = /^@terminal\(([^)]*)\):([\s\S]+)$/

/**
 * The scope component is an opaque terminal identity. URI encoding is made
 * canonical here so that equivalent-looking encodings cannot produce a second
 * spelling of the same transport metadata.
 */
const encodeTerminalScopeComponent = (terminalId: string): string =>
  encodeURIComponent(terminalId).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  )

const invalidTerminalIdMessage =
  'Error: terminalId must be a valid exact terminal runtime ID.'
const invalidFilePathMessage =
  'Error: filePath must be a non-blank, well-formed string.'

/**
 * Creates scoped metadata for a non-empty terminal identity. The empty
 * terminal-less case is intentionally represented by the raw file path rather
 * than by an empty @terminal() scope.
 */
export const encodeTerminalScopedFilePath = (
  terminalId: unknown,
  filePath: unknown
): string => {
  if (!isValidTerminalRuntimeId(terminalId)) {
    throw new TypeError(invalidTerminalIdMessage)
  }
  const path = readOpaqueNonBlankWellFormedString(filePath)
  if (path === undefined) {
    throw new TypeError(invalidFilePathMessage)
  }
  return `@terminal(${encodeTerminalScopeComponent(terminalId)}):${path}`
}

/**
 * Detects a possibly malformed scoped-path marker without coercing arbitrary
 * values into strings. Leading whitespace is treated as a malformed attempt at
 * scoped metadata, matching the historical transport admission rule.
 */
export const hasTerminalScopedFilePathPrefix = (rawPath: unknown): boolean =>
  typeof rawPath === 'string' &&
  rawPath.trimStart().startsWith(TERMINAL_SCOPED_FILE_PATH_PREFIX)

/**
 * Parses only the canonical scoped representation. The returned terminal ID
 * and file path are the original decoded/raw values; neither is trimmed or
 * otherwise rewritten.
 */
export const parseTerminalScopedFilePath = (
  rawPath: unknown
): TerminalScopedFilePath | null => {
  if (
    typeof rawPath !== 'string' ||
    !hasOnlyPairedUtf16Surrogates(rawPath)
  ) {
    return null
  }

  const matched = rawPath.match(TERMINAL_SCOPED_FILE_PATH_REGEX)
  if (!matched) return null

  const encodedTerminalId = matched[1]
  const filePath = readOpaqueNonBlankWellFormedString(matched[2])
  if (!encodedTerminalId || filePath === undefined) return null

  try {
    const terminalId = decodeURIComponent(encodedTerminalId)
    if (
      !isValidTerminalRuntimeId(terminalId) ||
      encodeTerminalScopeComponent(terminalId) !== encodedTerminalId
    ) {
      return null
    }
    return { terminalId, filePath }
  } catch {
    return null
  }
}

export type TerminalScopedFileTargetResolution =
  | { ok: true; terminalId: string; filePath: string }
  | { ok: false; message: string }

/**
 * A scoped file path is transport metadata, not an alternative selector. If
 * both forms are present they must identify the same terminal byte-for-byte.
 * All admission happens before callers are allowed to perform file I/O.
 */
export const resolveTerminalScopedFileTarget = (
  terminalId: unknown,
  rawPath: unknown
): TerminalScopedFileTargetResolution => {
  if (!isValidTerminalRuntimeId(terminalId)) {
    return { ok: false, message: invalidTerminalIdMessage }
  }
  if (
    typeof rawPath !== 'string' ||
    !hasOnlyPairedUtf16Surrogates(rawPath)
  ) {
    return { ok: false, message: invalidFilePathMessage }
  }

  const scoped = parseTerminalScopedFilePath(rawPath)
  if (!scoped) {
    if (hasTerminalScopedFilePathPrefix(rawPath)) {
      return {
        ok: false,
        message:
          'Error: filePath contains malformed @terminal(<encoded-id>):<path> metadata.'
      }
    }
    if (readOpaqueNonBlankWellFormedString(rawPath) === undefined) {
      return { ok: false, message: invalidFilePathMessage }
    }
    return { ok: true, terminalId, filePath: rawPath }
  }

  if (scoped.terminalId !== terminalId) {
    return {
      ok: false,
      message: `Error: terminalId=${JSON.stringify(terminalId)} conflicts with filePath terminal scope ${JSON.stringify(scoped.terminalId)}. Use the same exact terminal ID in both fields.`
    }
  }
  return { ok: true, terminalId, filePath: scoped.filePath }
}
