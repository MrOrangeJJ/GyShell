import {
  hasOnlyPairedUtf16Surrogates,
  isValidTerminalRuntimeId
} from '@gyshell/shared'

export const FILESYSTEM_PANEL_DRAG_MIME = 'application/x-gyshell-filesystem-items'

export interface FileSystemPanelDragEntry {
  name: string
  path: string
  isDirectory: boolean
  size?: number
}

export interface FileSystemPanelDragPayload {
  version: 1
  sourceTerminalId: string
  sourceBasePath: string
  entries: FileSystemPanelDragEntry[]
}

export interface TerminalScopedFilePath {
  terminalId: string
  filePath: string
}

export type NativeFilePathResolver = (file: File) => string | null | undefined

const TERMINAL_SCOPED_FILE_PATTERN = /^@terminal\(([^)]*)\):([\s\S]+)$/

const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
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
  allowedKeys: readonly string[]
): boolean => {
  const allowed = new Set(allowedKeys)
  return Reflect.ownKeys(value).every(
    (key) => typeof key === 'string' && allowed.has(key)
  )
}

const hasOwn = (value: Record<string, unknown>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key)

const hasOwnKeys = (
  value: Record<string, unknown>,
  requiredKeys: readonly string[]
): boolean => requiredKeys.every((key) => hasOwn(value, key))

const readPathValue = (value: unknown): string | undefined => {
  if (typeof value !== 'string' || !hasOnlyPairedUtf16Surrogates(value)) {
    return undefined
  }
  return value.length > 0 && value.trim().length > 0 ? value : undefined
}

const encodeTerminalScopeComponent = (terminalId: string): string =>
  encodeURIComponent(terminalId).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  )

const parseFileSystemPanelDragEntry = (
  value: unknown
): FileSystemPanelDragEntry | null => {
  if (
    !isPlainRecord(value) ||
    !hasOnlyKeys(value, ['name', 'path', 'isDirectory', 'size']) ||
    !hasOwnKeys(value, ['name', 'path', 'isDirectory'])
  ) {
    return null
  }

  const name = readPathValue(value.name)
  const path = readPathValue(value.path)
  if (!name || !path || typeof value.isDirectory !== 'boolean') {
    return null
  }

  let size: number | undefined
  if (hasOwn(value, 'size')) {
    if (
      typeof value.size !== 'number' ||
      !Number.isSafeInteger(value.size) ||
      value.size < 0
    ) {
      return null
    }
    size = value.size
  }

  return {
    name,
    path,
    isDirectory: value.isDirectory,
    ...(size !== undefined ? { size } : {})
  }
}

/**
 * Applies the complete admission contract to a decoded in-app drag payload.
 * Keeping this separate from DataTransfer parsing lets callers and tests
 * exercise the same boundary with objects that cannot be represented in JSON
 * (for example explicit undefined or symbol keys).
 */
export const normalizeFileSystemPanelDragPayload = (
  value: unknown
): FileSystemPanelDragPayload | null => {
  try {
    if (
      !isPlainRecord(value) ||
      !hasOnlyKeys(value, [
        'version',
        'sourceTerminalId',
        'sourceBasePath',
        'entries'
      ]) ||
      !hasOwnKeys(value, [
        'version',
        'sourceTerminalId',
        'sourceBasePath',
        'entries'
      ]) ||
      value.version !== 1 ||
      !isValidTerminalRuntimeId(value.sourceTerminalId) ||
      !readPathValue(value.sourceBasePath) ||
      !Array.isArray(value.entries) ||
      value.entries.length === 0
    ) {
      return null
    }

    const entries: FileSystemPanelDragEntry[] = []
    for (const candidate of value.entries) {
      const entry = parseFileSystemPanelDragEntry(candidate)
      if (!entry) return null
      entries.push(entry)
    }

    return {
      version: 1,
      sourceTerminalId: value.sourceTerminalId,
      sourceBasePath: value.sourceBasePath as string,
      entries
    }
  } catch {
    return null
  }
}

const collectUniquePaths = (
  paths: Array<string | null | undefined>
): string[] => {
  const seen = new Set<string>()
  const next: string[] = []
  for (const candidate of paths) {
    const normalized = typeof candidate === 'string' ? candidate.trim() : ''
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    next.push(normalized)
  }
  return next
}

const normalizeNativeFilePath = (value: string | null | undefined): string => {
  return typeof value === 'string' ? value.trim() : ''
}

export const resolveNativeFilePath = (
  file: File,
  resolvePath?: NativeFilePathResolver
): string => {
  const fromResolver = (() => {
    if (!resolvePath) return ''
    try {
      return normalizeNativeFilePath(resolvePath(file))
    } catch {
      return ''
    }
  })()
  if (fromResolver) return fromResolver
  const legacyPath = (file as File & { path?: unknown }).path
  return normalizeNativeFilePath(typeof legacyPath === 'string' ? legacyPath : '')
}

/**
 * Resolves the preload-exposed native file path resolver (Electron `webUtils.getPathForFile`).
 * Electron removed `File.path`, so renderer drop handlers must go through this bridge.
 * Returns `undefined` when unavailable (older Electron / tests), letting callers fall back to legacy `path`.
 */
export const getNativeFilePathResolver = (): NativeFilePathResolver | undefined => {
  const resolver = (globalThis as { gyshell?: { system?: { getPathForFile?: unknown } } })
    .gyshell?.system?.getPathForFile
  return typeof resolver === 'function' ? (resolver as NativeFilePathResolver) : undefined
}

export const encodeFileSystemPanelDragPayload = (payload: FileSystemPanelDragPayload): string =>
  JSON.stringify(payload)

export const parseFileSystemPanelDragPayload = (
  dataTransfer: Pick<DataTransfer, 'types' | 'getData'> | null | undefined
): FileSystemPanelDragPayload | null => {
  if (!dataTransfer) return null

  try {
    const types = Array.from(dataTransfer.types || [])
    if (!types.includes(FILESYSTEM_PANEL_DRAG_MIME)) return null
    const raw = dataTransfer.getData(FILESYSTEM_PANEL_DRAG_MIME)
    if (typeof raw !== 'string' || raw.length === 0) return null

    const parsedValue: unknown = JSON.parse(raw)
    return normalizeFileSystemPanelDragPayload(parsedValue)
  } catch {
    return null
  }
}

export type FileSystemPanelDragAdmission =
  | { kind: 'absent' }
  | { kind: 'accepted'; payload: FileSystemPanelDragPayload }
  | { kind: 'rejected' }

/**
 * Performs the custom MIME admission once for every renderer drop consumer.
 * `rejected` is deliberately distinct from `absent`: an advertised but
 * malformed in-app payload owns the drop and must not fall through to native
 * `Files`, which would discard its source-terminal binding.
 */
export const admitFileSystemPanelDragPayload = (
  dataTransfer: Pick<DataTransfer, 'types' | 'getData'> | null | undefined
): FileSystemPanelDragAdmission => {
  if (!hasFileSystemPanelDragPayloadType(dataTransfer)) {
    return { kind: 'absent' }
  }
  const payload = parseFileSystemPanelDragPayload(dataTransfer)
  return payload ? { kind: 'accepted', payload } : { kind: 'rejected' }
}

export const hasFileSystemPanelDragPayloadType = (
  dataTransfer: Pick<DataTransfer, 'types'> | null | undefined
): boolean => {
  if (!dataTransfer) return false
  try {
    const types = Array.from(dataTransfer.types || [])
    return types.includes(FILESYSTEM_PANEL_DRAG_MIME)
  } catch {
    return false
  }
}

export const hasNativeFileDragType = (
  dataTransfer: Pick<DataTransfer, 'types'> | null | undefined
): boolean => {
  if (!dataTransfer) return false
  try {
    const types = Array.from(dataTransfer.types || [])
    return types.includes('Files')
  } catch {
    return false
  }
}

export const extractNativeDropFilePaths = (
  dataTransfer: Pick<DataTransfer, 'files'> | null | undefined,
  resolvePath?: NativeFilePathResolver
): string[] => {
  if (!dataTransfer?.files) return []
  try {
    const paths = Array.from(dataTransfer.files).map((file) => {
      return resolveNativeFilePath(file, resolvePath)
    })
    return collectUniquePaths(paths)
  } catch {
    return []
  }
}

export const getFileSystemPanelDragPayloadPaths = (
  payload: FileSystemPanelDragPayload
): string[] => collectUniquePaths(payload.entries.map((entry) => entry.path))

export const extractFileSystemPayloadPaths = (
  dataTransfer: Pick<DataTransfer, 'types' | 'getData'> | null | undefined
): string[] => {
  const payload = parseFileSystemPanelDragPayload(dataTransfer)
  return payload ? getFileSystemPanelDragPayloadPaths(payload) : []
}

export const resolveTerminalDropPaths = (
  dataTransfer: Pick<DataTransfer, 'types' | 'getData' | 'files'> | null | undefined,
  resolvePath?: NativeFilePathResolver
): string[] => {
  // A declared in-app payload is authoritative. Never fall back to native
  // files when its body is malformed, since that would bypass the source-tab
  // binding carried by the custom payload.
  if (hasFileSystemPanelDragPayloadType(dataTransfer)) {
    const payload = parseFileSystemPanelDragPayload(dataTransfer)
    return payload ? getFileSystemPanelDragPayloadPaths(payload) : []
  }
  return extractNativeDropFilePaths(dataTransfer, resolvePath)
}

export const resolveTerminalDropPathsForTarget = (
  dataTransfer: Pick<DataTransfer, 'types' | 'getData' | 'files'> | null | undefined,
  targetTerminalId: string,
  resolvePath?: NativeFilePathResolver
): string[] => {
  if (!isValidTerminalRuntimeId(targetTerminalId)) return []

  if (hasFileSystemPanelDragPayloadType(dataTransfer)) {
    const payload = parseFileSystemPanelDragPayload(dataTransfer)
    if (!payload || payload.sourceTerminalId !== targetTerminalId) return []
    return getFileSystemPanelDragPayloadPaths(payload)
  }
  return extractNativeDropFilePaths(dataTransfer, resolvePath)
}

export const encodeTerminalScopedFilePath = (
  terminalId: string,
  filePath: string
): string => {
  if (terminalId === '') {
    if (
      typeof filePath !== 'string' ||
      !hasOnlyPairedUtf16Surrogates(filePath) ||
      filePath.trim().length === 0
    ) {
      throw new TypeError('filePath must be a non-blank well-formed string')
    }
    return filePath
  }
  if (!isValidTerminalRuntimeId(terminalId)) {
    throw new TypeError('terminalId must be a valid terminal runtime id')
  }
  if (
    typeof filePath !== 'string' ||
    !hasOnlyPairedUtf16Surrogates(filePath) ||
    filePath.trim().length === 0
  ) {
    throw new TypeError('filePath must be a non-blank well-formed string')
  }
  return `@terminal(${encodeTerminalScopeComponent(terminalId)}):${filePath}`
}

export const decodeTerminalScopedFilePath = (
  rawPath: string
): TerminalScopedFilePath | null => {
  if (typeof rawPath !== 'string' || !hasOnlyPairedUtf16Surrogates(rawPath)) {
    return null
  }
  const matched = rawPath.match(TERMINAL_SCOPED_FILE_PATTERN)
  if (!matched) return null
  const encodedTerminalId = matched[1]
  const filePath = matched[2]
  if (!encodedTerminalId || !filePath || !hasOnlyPairedUtf16Surrogates(filePath)) {
    return null
  }
  try {
    const terminalId = decodeURIComponent(encodedTerminalId)
    if (
      !isValidTerminalRuntimeId(terminalId) ||
      encodeTerminalScopeComponent(terminalId) !== encodedTerminalId
    ) {
      return null
    }
    return {
      terminalId,
      filePath
    }
  } catch {
    return null
  }
}

export const getFileMentionDisplayName = (rawPath: string): string => {
  if (typeof rawPath !== 'string') return ''
  const normalized = decodeTerminalScopedFilePath(rawPath)?.filePath ?? rawPath
  const trimmed = normalized.trim()
  if (!trimmed) return ''
  return trimmed.split(/[/\\]/).pop() || trimmed
}
