import { isValidTerminalRuntimeId } from '@gyshell/shared'

export type FileEditorSnapshotMode = 'idle' | 'loading' | 'text' | 'image' | 'pdf' | 'error'

export interface FileEditorSnapshot {
  terminalId: string | null
  filePath: string | null
  mode: FileEditorSnapshotMode
  content: string
  dirty: boolean
  errorMessage: string | null
  statusMessage: string | null
}

const normalizeOptionalString = (value: unknown): string | null => {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return normalized.length > 0 ? normalized : null
}

const normalizeTerminalId = (value: unknown): string | null =>
  isValidTerminalRuntimeId(value) ? value : null

const normalizeMode = (value: unknown): FileEditorSnapshotMode | null => {
  if (
    value === 'idle' ||
    value === 'loading' ||
    value === 'text' ||
    value === 'image' ||
    value === 'pdf' ||
    value === 'error'
  ) {
    return value
  }
  return null
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  try {
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
  } catch {
    return false
  }
}

const hasOnlyKeys = (
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
): boolean => {
  const allowed = new Set(allowedKeys)
  return Object.keys(value).every((key) => allowed.has(key))
}

const hasOwn = (value: Record<string, unknown>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key)

const readStrictNullableDisplayString = (
  value: unknown,
): { ok: true; value: string | null } | { ok: false } => {
  if (value === null) {
    return { ok: true, value: null }
  }
  if (typeof value !== 'string') {
    return { ok: false }
  }
  const normalized = value.trim()
  return { ok: true, value: normalized.length > 0 ? normalized : null }
}

/**
 * Validates a file-editor snapshot at an untrusted detached-window boundary.
 * Unlike normalizeFileEditorSnapshot(), this function never repairs an
 * explicitly malformed field or silently discards unknown keys.
 */
export const parseStrictFileEditorSnapshot = (
  value: unknown,
): FileEditorSnapshot | null => {
  if (!isRecord(value)) return null
  const raw = value
  const snapshotKeys = [
    'terminalId',
    'filePath',
    'mode',
    'content',
    'dirty',
    'errorMessage',
    'statusMessage',
  ] as const
  if (
    !hasOnlyKeys(raw, snapshotKeys) ||
    snapshotKeys.some((key) => !hasOwn(raw, key))
  ) {
    return null
  }

  const mode = normalizeMode(raw.mode)
  if (!mode || typeof raw.content !== 'string' || typeof raw.dirty !== 'boolean') {
    return null
  }

  const errorMessage = readStrictNullableDisplayString(raw.errorMessage)
  const statusMessage = readStrictNullableDisplayString(raw.statusMessage)
  if (!errorMessage.ok || !statusMessage.ok) {
    return null
  }

  const hasDocument = mode !== 'idle'
  let terminalId: string | null = null
  let filePath: string | null = null
  if (hasDocument) {
    if (!isValidTerminalRuntimeId(raw.terminalId)) return null
    if (typeof raw.filePath !== 'string' || raw.filePath.trim().length === 0) {
      return null
    }
    terminalId = raw.terminalId
    filePath = raw.filePath.trim()
  } else if (raw.terminalId !== null || raw.filePath !== null) {
    return null
  }

  // Non-text modes never carry an editable buffer or dirty state. Rejecting
  // those values is important here: silently clearing them would turn a
  // corrupted detached payload into a different editor state.
  if (mode !== 'text' && (raw.content !== '' || raw.dirty !== false)) {
    return null
  }

  return {
    terminalId,
    filePath,
    mode,
    content: raw.content,
    dirty: raw.dirty,
    errorMessage: errorMessage.value,
    statusMessage: statusMessage.value,
  }
}

export const normalizeFileEditorSnapshot = (value: unknown): FileEditorSnapshot | null => {
  if (!value || typeof value !== 'object') return null
  const raw = value as Partial<FileEditorSnapshot>
  const mode = normalizeMode(raw.mode)
  if (!mode) return null

  const hasDocument = mode === 'loading' || mode === 'text' || mode === 'image' || mode === 'pdf' || mode === 'error'
  const terminalId = hasDocument ? normalizeTerminalId(raw.terminalId) : null
  const filePath = hasDocument ? normalizeOptionalString(raw.filePath) : null
  if (hasDocument && (!terminalId || !filePath)) {
    return null
  }

  return {
    terminalId,
    filePath,
    mode,
    content: mode === 'text' && typeof raw.content === 'string' ? raw.content : '',
    dirty: mode === 'text' && raw.dirty === true,
    errorMessage: normalizeOptionalString(raw.errorMessage),
    statusMessage: normalizeOptionalString(raw.statusMessage)
  }
}
