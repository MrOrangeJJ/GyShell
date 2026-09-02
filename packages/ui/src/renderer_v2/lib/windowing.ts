import type { TerminalConfig } from './ipcTypes'
import {
  isValidTerminalRuntimeId,
  readOpaqueNonBlankWellFormedString,
} from '@gyshell/shared'
import {
  isPanelKind,
  isTabbedPanelKind,
  isTerminalBackedPanelKind,
  listPanels,
  makeLayoutId,
  normalizePanelTabBinding,
  parseStrictLayoutTree,
  readWindowingTabId,
  type LayoutPanelTabBinding,
  type LayoutTree,
  type PanelKind
} from '../layout'

export { readWindowingTabId } from '../layout'
import {
  parseStrictFileEditorSnapshot,
  type FileEditorSnapshot
} from './fileEditorSnapshot'
import type { TerminalConnectionRef } from './terminalConnectionModel'

export type RendererWindowRole = 'main' | 'detached'
export type WindowingTabKind = Extract<
  PanelKind,
  'chat' | 'terminal' | 'filesystem' | 'monitor'
>

export interface WindowingTabTarget {
  kind: WindowingTabKind
  tabId: string
}

export type WindowingTabOwnership = Partial<Record<WindowingTabKind, string[]>>

export interface OpenDetachedWindowOptions {
  focusTarget?: WindowingTabTarget
}

const DETACHED_STATE_KEY_PREFIX = 'gyshell.detachedState.'
const DETACHED_STATE_SESSION_KEY_PREFIX = 'gyshell.detachedStateSession.'
const TAB_DRAG_STATE_KEY_PREFIX = 'gyshell.tabDragState.'
const PANEL_DRAG_STATE_KEY_PREFIX = 'gyshell.panelDragState.'
const WINDOW_CLIENT_ID_KEY = 'gyshell.windowClientId'
export const WINDOWING_BROADCAST_CHANNEL = 'gyshell-windowing-v1'
const WINDOWING_STORAGE_CHANNEL_KEY_PREFIX = 'gyshell.windowingChannel.'
export const WINDOWING_STORAGE_CHANNEL_KEY = `${WINDOWING_STORAGE_CHANNEL_KEY_PREFIX}${WINDOWING_BROADCAST_CHANNEL}`

const getDetachedStateLocalKey = (token: string): string | null => {
  const normalizedToken = String(token || '').trim()
  if (!normalizedToken) return null
  return `${DETACHED_STATE_KEY_PREFIX}${normalizedToken}`
}

const getDetachedStateSessionKey = (token: string): string | null => {
  const normalizedToken = String(token || '').trim()
  if (!normalizedToken) return null
  return `${DETACHED_STATE_SESSION_KEY_PREFIX}${normalizedToken}`
}

export interface RendererWindowContext {
  role: RendererWindowRole
  detachedStateToken: string | null
  sourceClientId: string | null
  clientId: string
  safeMode: boolean
}

export interface DetachedWindowState {
  sourceClientId: string
  layoutTree: LayoutTree
  createdAt: number
  /**
   * Seeds a freshly opened detached file-editor window with the current editor
   * buffer. Closing that window still follows normal window-shutdown semantics
   * and does not roll editor state back into another renderer automatically.
   */
  fileEditorSnapshot?: FileEditorSnapshot
  /**
   * Terminal tabs that may not exist in the target renderer/backend inventory
   * yet. Detached windows use these snapshots to keep tab bindings intact until
   * the terminal view mounts and creates the real runtime.
   */
  terminalTabs?: WindowingTerminalTabSnapshot[]
}

export interface WindowingTerminalTabSnapshot {
  id: string
  title: string
  config: TerminalConfig
  connectionRef?: TerminalConnectionRef
  runtimeState?: 'initializing' | 'ready' | 'exited'
  lastExitCode?: number
}

export interface WindowingTabMovedMessage {
  type: 'tab-moved'
  sourceClientId: string
  targetClientId: string
  kind: PanelKind
  tabId: string
}

export interface WindowingPanelMovedMessage {
  type: 'panel-moved'
  sourceClientId: string
  targetClientId: string
  sourcePanelId: string
  kind: PanelKind
  tabIds: string[]
}

export interface WindowingDetachedClosingMessage {
  type: 'detached-closing'
  sourceClientId: string
  tabsByKind: Partial<Record<Extract<PanelKind, 'chat' | 'terminal' | 'filesystem' | 'monitor'>, string[]>>
}

/**
 * Broadcast when a drag starts in any window, so other windows can accept
 * the drop even when DataTransfer.getData() is restricted during dragover.
 */
export interface WindowingTabDragPayload {
  sourceClientId: string
  tabId: string
  kind: PanelKind
  sourcePanelId: string
  stateToken?: string
  terminalTab?: WindowingTerminalTabSnapshot
}

export interface WindowingPanelDragPayload {
  sourceClientId: string
  sourcePanelId: string
  kind: PanelKind
  /**
   * When present, the native drag payload only carries this token. The full
   * transferable panel state must be rehydrated from storage before import.
   */
  stateToken?: string
  tabBinding?: LayoutPanelTabBinding
  terminalTabs?: WindowingTerminalTabSnapshot[]
  fileEditorSnapshot?: FileEditorSnapshot
}

export interface WindowingDragStartMessage {
  type: 'drag-start'
  sourceClientId: string
  dragKind: 'tab' | 'panel'
  tabPayload?: WindowingTabDragPayload
  panelPayload?: WindowingPanelDragPayload
}

/**
 * Broadcast when a drag ends (drop or cancel) so other windows can clean up.
 */
export interface WindowingDragEndMessage {
  type: 'drag-end'
  sourceClientId: string
}

export type WindowingMessage =
  | WindowingPanelMovedMessage
  | WindowingTabMovedMessage
  | WindowingDetachedClosingMessage
  | WindowingDragStartMessage
  | WindowingDragEndMessage

const readTransportIdentifier = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined
  return readOpaqueNonBlankWellFormedString(value.trim())
}

export const normalizeWindowingMessage = (
  value: unknown,
): WindowingMessage | null => {
  if (!isWindowingRecord(value)) return null
  const raw = value
  const sourceClientId = readTransportIdentifier(raw.sourceClientId)
  if (!sourceClientId) return null

  if (raw.type === 'tab-moved') {
    if (
      !hasWindowingOnlyKeys(raw, [
        'type',
        'sourceClientId',
        'targetClientId',
        'kind',
        'tabId',
      ])
    ) {
      return null
    }
    const targetClientId = readTransportIdentifier(raw.targetClientId)
    const kind = raw.kind
    if (!targetClientId || !isTabbedPanelKind(kind as PanelKind)) return null
    const tabId = readWindowingTabId(kind as PanelKind, raw.tabId)
    return tabId
      ? {
          type: 'tab-moved',
          sourceClientId,
          targetClientId,
          kind: kind as WindowingTabKind,
          tabId
        }
      : null
  }

  if (raw.type === 'panel-moved') {
    if (
      !hasWindowingOnlyKeys(raw, [
        'type',
        'sourceClientId',
        'targetClientId',
        'sourcePanelId',
        'kind',
        'tabIds',
      ])
    ) {
      return null
    }
    const targetClientId = readTransportIdentifier(raw.targetClientId)
    const sourcePanelId = readOpaqueNonBlankWellFormedString(raw.sourcePanelId)
    const kind = raw.kind
    if (
      !targetClientId ||
      !sourcePanelId ||
      !isPanelKind(kind) ||
      !Array.isArray(raw.tabIds)
    ) {
      return null
    }
    const tabIds = isTabbedPanelKind(kind)
      ? raw.tabIds
          .map((tabId) => readWindowingTabId(kind, tabId))
          .filter((tabId): tabId is string => !!tabId)
      : []
    if (
      (isTabbedPanelKind(kind) && tabIds.length !== raw.tabIds.length) ||
      (!isTabbedPanelKind(kind) && raw.tabIds.length > 0)
    ) {
      return null
    }
    return {
      type: 'panel-moved',
      sourceClientId,
      targetClientId,
      sourcePanelId,
      kind,
      tabIds: Array.from(new Set(tabIds))
    }
  }

  if (raw.type === 'detached-closing') {
    if (
      !hasWindowingOnlyKeys(raw, [
        'type',
        'sourceClientId',
        'tabsByKind',
      ]) ||
      !isWindowingRecord(raw.tabsByKind) ||
      !hasWindowingOnlyKeys(raw.tabsByKind, [
        'chat',
        'terminal',
        'filesystem',
        'monitor',
      ])
    ) {
      return null
    }
    const rawTabsByKind = raw.tabsByKind
    const tabsByKind: WindowingTabOwnership = {}
    for (const kind of ['chat', 'terminal', 'filesystem', 'monitor'] as const) {
      const values = rawTabsByKind[kind]
      if (values === undefined) continue
      if (!Array.isArray(values)) return null
      const tabIds = values.map((tabId) => readWindowingTabId(kind, tabId))
      if (tabIds.some((tabId) => !tabId)) return null
      tabsByKind[kind] = Array.from(new Set(tabIds as string[]))
    }
    return { type: 'detached-closing', sourceClientId, tabsByKind }
  }

  if (raw.type === 'drag-start') {
    if (
      !hasWindowingOnlyKeys(raw, [
        'type',
        'sourceClientId',
        'dragKind',
        'tabPayload',
        'panelPayload',
      ])
    ) {
      return null
    }
    if (raw.dragKind === 'tab') {
      if (
        !hasWindowingOwnKey(raw, 'tabPayload') ||
        hasWindowingOwnKey(raw, 'panelPayload')
      ) {
        return null
      }
      const tabPayload = normalizeWindowingTabDragPayload(raw.tabPayload)
      return tabPayload && tabPayload.sourceClientId === sourceClientId
        ? {
            type: 'drag-start',
            sourceClientId,
            dragKind: 'tab',
            tabPayload
          }
        : null
    }
    if (raw.dragKind === 'panel') {
      if (
        !hasWindowingOwnKey(raw, 'panelPayload') ||
        hasWindowingOwnKey(raw, 'tabPayload')
      ) {
        return null
      }
      const panelPayload = normalizeWindowingPanelDragPayload(raw.panelPayload)
      return panelPayload && panelPayload.sourceClientId === sourceClientId
        ? {
            type: 'drag-start',
            sourceClientId,
            dragKind: 'panel',
            panelPayload
          }
        : null
    }
    return null
  }

  return raw.type === 'drag-end' &&
    hasWindowingOnlyKeys(raw, ['type', 'sourceClientId'])
    ? { type: 'drag-end', sourceClientId }
    : null
}

const safeRandomId = (): string => {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID()
  }
  return `${Math.random().toString(16).slice(2)}-${Date.now().toString(16)}`
}

const readSearchParams = (): URLSearchParams => {
  try {
    const search = typeof window !== 'undefined' ? window.location?.search || '' : ''
    return new URLSearchParams(search)
  } catch {
    return new URLSearchParams()
  }
}

const ensureClientId = (): string => {
  try {
    const existing = window.sessionStorage?.getItem(WINDOW_CLIENT_ID_KEY)
    if (existing && existing.trim().length > 0) {
      return existing
    }
    const next = `win-${safeRandomId()}`
    window.sessionStorage?.setItem(WINDOW_CLIENT_ID_KEY, next)
    return next
  } catch {
    return `win-${safeRandomId()}`
  }
}

const readWindowContext = (): RendererWindowContext => {
  const params = readSearchParams()
  const role = params.get('windowRole') === 'detached' ? 'detached' : 'main'
  const detachedStateToken = params.get('detachedStateToken')
  const sourceClientId = params.get('sourceClientId')
  return {
    role,
    detachedStateToken: detachedStateToken && detachedStateToken.trim().length > 0 ? detachedStateToken : null,
    sourceClientId: sourceClientId && sourceClientId.trim().length > 0 ? sourceClientId : null,
    clientId: ensureClientId(),
    safeMode: params.get('safeMode') === '1'
  }
}

export const WINDOW_CONTEXT: RendererWindowContext = readWindowContext()

export const buildDetachedLayoutTree = (
  kind: PanelKind,
  tabBinding?: LayoutPanelTabBinding
): LayoutTree => {
  const panelId = makeLayoutId(`panel-${kind}`)
  const normalizedTabBinding = normalizePanelTabBinding(kind, tabBinding)
  return {
    schemaVersion: 2,
    root: {
      type: 'panel',
      id: makeLayoutId('node'),
      panel: {
        id: panelId,
        kind
      }
    },
    focusedPanelId: panelId,
    ...(normalizedTabBinding
      ? {
          panelTabs: {
            [panelId]: normalizedTabBinding
          }
        }
      : {})
  }
}

export const collectLayoutTabOwnership = (
  layoutTree: LayoutTree
): WindowingTabOwnership => {
  const tabsByKind: Record<WindowingTabKind, Set<string>> = {
    chat: new Set<string>(),
    terminal: new Set<string>(),
    filesystem: new Set<string>(),
    monitor: new Set<string>()
  }

  listPanels(layoutTree).forEach((node) => {
    const kind = node.panel.kind
    if (
      kind !== 'chat' &&
      kind !== 'terminal' &&
      kind !== 'filesystem' &&
      kind !== 'monitor'
    ) {
      return
    }
    const tabIds = layoutTree.panelTabs?.[node.panel.id]?.tabIds || []
    tabIds.forEach((tabId) => {
      const normalized = readWindowingTabId(kind, tabId)
      if (normalized) {
        tabsByKind[kind].add(normalized)
      }
    })
  })

  return {
    chat: Array.from(tabsByKind.chat),
    terminal: Array.from(tabsByKind.terminal),
    filesystem: Array.from(tabsByKind.filesystem),
    monitor: Array.from(tabsByKind.monitor)
  }
}

export const stashDetachedWindowState = (token: string, state: DetachedWindowState): boolean => {
  const localKey = getDetachedStateLocalKey(token)
  const serialized = serializeDetachedWindowState(state)
  if (!localKey || !serialized) return false
  try {
    window.localStorage?.setItem(localKey, serialized.raw)
    return true
  } catch {
    return false
  }
}

/**
 * Detached windows refresh this renderer-local snapshot as layout/editor state
 * changes so reload recovery does not fall back to the stale "just detached"
 * payload from initial window creation.
 */
export const syncDetachedWindowState = (token: string, state: DetachedWindowState): boolean => {
  const sessionKey = getDetachedStateSessionKey(token)
  const serialized = serializeDetachedWindowState(state)
  if (!sessionKey || !serialized) return false
  try {
    window.sessionStorage?.setItem(sessionKey, serialized.raw)
    return true
  } catch {
    return false
  }
}

export const clearDetachedWindowState = (token: string): void => {
  const sessionKey = getDetachedStateSessionKey(token)
  const localKey = getDetachedStateLocalKey(token)
  try {
    if (sessionKey) {
      window.sessionStorage?.removeItem(sessionKey)
    }
  } catch {
    // ignore cleanup failures
  }
  try {
    if (localKey) {
      window.localStorage?.removeItem(localKey)
    }
  } catch {
    // ignore cleanup failures
  }
}

const isWindowingRecord = (
  value: unknown,
): value is Record<string, unknown> => {
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

const hasWindowingOnlyKeys = (
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
): boolean => {
  const allowed = new Set(allowedKeys)
  return Object.keys(value).every((key) => allowed.has(key))
}

const hasWindowingOwnKey = (
  value: Record<string, unknown>,
  key: string,
): boolean => Object.prototype.hasOwnProperty.call(value, key)

const hasWindowingOwnKeys = (
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean => keys.every((key) => hasWindowingOwnKey(value, key))

const readWindowingTransportId = readTransportIdentifier

const readPositiveInteger = (value: unknown): number | undefined =>
  typeof value === 'number' &&
  Number.isSafeInteger(value) &&
  value > 0
    ? value
    : undefined

const readOptionalConfigString = (
  record: Record<string, unknown>,
  key: string,
): string | undefined => {
  if (!hasWindowingOwnKey(record, key)) return undefined
  const value = readOpaqueNonBlankWellFormedString(record[key])
  // Empty optional strings are legal for credentials and are handled by the
  // caller. This helper is for fields where a non-blank value is required.
  return value
}

const cloneWindowingJsonValue = (
  value: unknown,
  depth = 0,
): unknown | undefined => {
  if (depth > 12) return undefined
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return value
  }
  if (Array.isArray(value)) {
    const cloned: unknown[] = []
    for (const item of value) {
      const next = cloneWindowingJsonValue(item, depth + 1)
      if (next === undefined && item !== undefined) return undefined
      if (item === undefined) return undefined
      cloned.push(next)
    }
    return cloned
  }
  if (!isWindowingRecord(value)) return undefined
  const cloned = Object.create(null) as Record<string, unknown>
  for (const key of Object.keys(value)) {
    const next = cloneWindowingJsonValue(value[key], depth + 1)
    if (next === undefined && value[key] !== undefined) return undefined
    if (value[key] === undefined) return undefined
    cloned[key] = next
  }
  return cloned
}

const parseStrictTransferProxy = (
  value: unknown,
): Record<string, unknown> | undefined => {
  if (!isWindowingRecord(value)) return undefined
  if (
    !hasWindowingOnlyKeys(value, [
      'id',
      'name',
      'type',
      'host',
      'port',
      'username',
      'password',
    ]) ||
    !hasWindowingOwnKeys(value, ['id', 'name', 'type', 'host', 'port'])
  ) {
    return undefined
  }
  const id = readOptionalConfigString(value, 'id')
  const name = readOptionalConfigString(value, 'name')
  const host = readOptionalConfigString(value, 'host')
  const type = value.type === 'socks5' || value.type === 'http' ? value.type : undefined
  const port = readPositiveInteger(value.port)
  if (!id || !name || !host || !type || port === undefined) return undefined
  for (const key of ['username', 'password'] as const) {
    if (
      hasWindowingOwnKey(value, key) &&
      (typeof value[key] !== 'string' ||
        !readOpaqueNonBlankWellFormedString(value[key]) && value[key] !== '')
    ) {
      return undefined
    }
  }
  const cloned = cloneWindowingJsonValue(value)
  return isWindowingRecord(cloned) ? cloned : undefined
}

const parseStrictTransferTunnel = (
  value: unknown,
): Record<string, unknown> | undefined => {
  if (!isWindowingRecord(value)) return undefined
  if (
    !hasWindowingOnlyKeys(value, [
      'id',
      'name',
      'type',
      'host',
      'port',
      'targetAddress',
      'targetPort',
      'viaConnectionId',
    ]) ||
    !hasWindowingOwnKeys(value, ['id', 'name', 'type', 'host', 'port'])
  ) {
    return undefined
  }
  const id = readOptionalConfigString(value, 'id')
  const name = readOptionalConfigString(value, 'name')
  const host = readOptionalConfigString(value, 'host')
  const type =
    value.type === 'Local' || value.type === 'Remote' || value.type === 'Dynamic'
      ? value.type
      : undefined
  const port = readPositiveInteger(value.port)
  if (!id || !name || !host || !type || port === undefined) return undefined
  for (const key of ['targetAddress', 'viaConnectionId'] as const) {
    if (
      hasWindowingOwnKey(value, key) &&
      (typeof value[key] !== 'string' ||
        !readOpaqueNonBlankWellFormedString(value[key]))
    ) {
      return undefined
    }
  }
  if (
    hasWindowingOwnKey(value, 'targetPort') &&
    readPositiveInteger(value.targetPort) === undefined
  ) {
    return undefined
  }
  const cloned = cloneWindowingJsonValue(value)
  return isWindowingRecord(cloned) ? cloned : undefined
}

const BASE_TERMINAL_CONFIG_KEYS = [
  'type',
  'id',
  'title',
  'cols',
  'rows',
] as const

const LOCAL_TERMINAL_CONFIG_KEYS = [
  ...BASE_TERMINAL_CONFIG_KEYS,
  'cwd',
  'shell',
] as const

const SSH_TERMINAL_CONFIG_KEYS = [
  ...BASE_TERMINAL_CONFIG_KEYS,
  'host',
  'port',
  'username',
  'authMethod',
  'password',
  'privateKey',
  'privateKeyPath',
  'passphrase',
  'proxy',
  'tunnels',
  'jumpHost',
] as const

const hasValidOptionalConfigString = (
  record: Record<string, unknown>,
  key: string,
): boolean => {
  if (!hasWindowingOwnKey(record, key)) return true
  const value = record[key]
  return (
    typeof value === 'string' &&
    (value === '' || readOpaqueNonBlankWellFormedString(value) !== undefined)
  )
}

const parseStrictTerminalConfig = (
  value: unknown,
  expectedId: string,
  depth = 0,
): TerminalConfig | undefined => {
  if (
    !isWindowingRecord(value) ||
    depth > 4 ||
    !hasWindowingOwnKeys(value, BASE_TERMINAL_CONFIG_KEYS)
  ) {
    return undefined
  }

  const typeValue = readOpaqueNonBlankWellFormedString(value.type)
  const type = typeValue?.trim()
  const id = isValidTerminalRuntimeId(value.id) ? value.id : undefined
  const titleValue = readOpaqueNonBlankWellFormedString(value.title)
  const title = titleValue?.trim()
  const cols = readPositiveInteger(value.cols)
  const rows = readPositiveInteger(value.rows)
  if (
    !type ||
    !id ||
    id !== expectedId ||
    !title ||
    cols === undefined ||
    rows === undefined
  ) {
    return undefined
  }

  if (type === 'local') {
    if (!hasWindowingOnlyKeys(value, LOCAL_TERMINAL_CONFIG_KEYS)) {
      return undefined
    }
    if (
      !hasValidOptionalConfigString(value, 'cwd') ||
      !hasValidOptionalConfigString(value, 'shell')
    ) {
      return undefined
    }
  } else if (type === 'ssh') {
    if (!hasWindowingOnlyKeys(value, SSH_TERMINAL_CONFIG_KEYS)) {
      return undefined
    }
    const host = readOptionalConfigString(value, 'host')
    const username = readOptionalConfigString(value, 'username')
    const port = readPositiveInteger(value.port)
    const authMethod =
      value.authMethod === 'password' || value.authMethod === 'privateKey'
        ? value.authMethod
        : undefined
    if (!host || !username || port === undefined || !authMethod) {
      return undefined
    }
    for (const key of [
      'password',
      'privateKey',
      'privateKeyPath',
      'passphrase',
    ] as const) {
      if (!hasValidOptionalConfigString(value, key)) return undefined
    }
    if (
      hasWindowingOwnKey(value, 'proxy') &&
      !parseStrictTransferProxy(value.proxy)
    ) {
      return undefined
    }
    if (hasWindowingOwnKey(value, 'tunnels')) {
      if (
        !Array.isArray(value.tunnels) ||
        value.tunnels.some((tunnel) => !parseStrictTransferTunnel(tunnel))
      ) {
        return undefined
      }
    }
    if (hasWindowingOwnKey(value, 'jumpHost')) {
      const jumpHost = isWindowingRecord(value.jumpHost)
        ? value.jumpHost
        : undefined
      const jumpId = jumpHost && isValidTerminalRuntimeId(jumpHost.id)
        ? jumpHost.id
        : undefined
      if (
        !jumpHost ||
        !jumpId ||
        jumpHost.type !== 'ssh' ||
        !parseStrictTerminalConfig(jumpHost, jumpId, depth + 1)
      ) {
        return undefined
      }
    }
  }
  // Generic connection configurations deliberately retain JSON extension
  // fields. The required base fields above remain strict and identity-safe.

  const cloned = cloneWindowingJsonValue(value)
  if (!isWindowingRecord(cloned)) return undefined
  cloned.type = type
  cloned.id = id
  cloned.title = title
  cloned.cols = cols
  cloned.rows = rows
  return cloned as unknown as TerminalConfig
}

export const normalizeWindowingTerminalTabSnapshot = (
  value: unknown,
): WindowingTerminalTabSnapshot | undefined => {
  if (!isWindowingRecord(value)) return undefined
  if (
    !hasWindowingOwnKeys(value, ['id', 'title', 'config']) ||
    !hasWindowingOnlyKeys(value, [
      'id',
      'title',
      'config',
      'connectionRef',
      'runtimeState',
      'lastExitCode',
    ])
  ) {
    return undefined
  }
  const id = readWindowingTabId('terminal', value.id)
  const titleValue = readOpaqueNonBlankWellFormedString(value.title)
  const title = titleValue?.trim()
  if (!id || !title) return undefined
  const config = parseStrictTerminalConfig(value.config, id)
  if (!config) return undefined

  let connectionRef: TerminalConnectionRef | undefined
  if (hasWindowingOwnKey(value, 'connectionRef')) {
    const rawConnectionRef = value.connectionRef
    if (!isWindowingRecord(rawConnectionRef)) return undefined
    const refTypeValue = readOpaqueNonBlankWellFormedString(
      rawConnectionRef.type,
    )
    if (
      !hasWindowingOnlyKeys(rawConnectionRef, ['type', 'entryId']) ||
      !hasWindowingOwnKey(rawConnectionRef, 'type') ||
      !refTypeValue
    ) {
      return undefined
    }
    const refType = refTypeValue.trim()
    if (!refType) return undefined
    let entryId: string | undefined
    if (hasWindowingOwnKey(rawConnectionRef, 'entryId')) {
      entryId = readOpaqueNonBlankWellFormedString(rawConnectionRef.entryId)
      if (!entryId) return undefined
    }
    connectionRef = {
      type: refType,
      ...(entryId !== undefined ? { entryId } : {}),
    }
  }

  let runtimeState: WindowingTerminalTabSnapshot['runtimeState']
  if (hasWindowingOwnKey(value, 'runtimeState')) {
    if (
      value.runtimeState !== 'initializing' &&
      value.runtimeState !== 'ready' &&
      value.runtimeState !== 'exited'
    ) {
      return undefined
    }
    runtimeState = value.runtimeState
  }

  let lastExitCode: number | undefined
  if (hasWindowingOwnKey(value, 'lastExitCode')) {
    if (
      typeof value.lastExitCode !== 'number' ||
      !Number.isSafeInteger(value.lastExitCode)
    ) {
      return undefined
    }
    lastExitCode = value.lastExitCode
  }

  return {
    id,
    title,
    config,
    ...(connectionRef ? { connectionRef } : {}),
    ...(runtimeState !== undefined ? { runtimeState } : {}),
    ...(lastExitCode !== undefined ? { lastExitCode } : {}),
  }
}

export const parseDetachedWindowState = (
  raw: string,
): DetachedWindowState | null => {
  let parsedValue: unknown
  try {
    parsedValue = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isWindowingRecord(parsedValue)) return null
  if (
    !hasWindowingOnlyKeys(parsedValue, [
      'sourceClientId',
      'layoutTree',
      'createdAt',
      'fileEditorSnapshot',
      'terminalTabs',
    ]) ||
    !hasWindowingOwnKey(parsedValue, 'sourceClientId') ||
    !hasWindowingOwnKey(parsedValue, 'layoutTree') ||
    !hasWindowingOwnKey(parsedValue, 'createdAt')
  ) {
    return null
  }

  const sourceClientId = readWindowingTransportId(parsedValue.sourceClientId)
  const layoutTree = parseStrictLayoutTree(parsedValue.layoutTree)
  if (
    !sourceClientId ||
    !layoutTree ||
    typeof parsedValue.createdAt !== 'number' ||
    !Number.isSafeInteger(parsedValue.createdAt) ||
    parsedValue.createdAt < 0
  ) {
    return null
  }

  let fileEditorSnapshot: FileEditorSnapshot | undefined
  if (hasWindowingOwnKey(parsedValue, 'fileEditorSnapshot')) {
    fileEditorSnapshot = parseStrictFileEditorSnapshot(
      parsedValue.fileEditorSnapshot,
    ) ?? undefined
    if (!fileEditorSnapshot) return null
    const hasFileEditorPanel = listPanels(layoutTree).some(
      (panel) => panel.panel.kind === 'fileEditor',
    )
    if (fileEditorSnapshot.mode !== 'idle' && !hasFileEditorPanel) {
      return null
    }
  }

  const terminalBindingIds = new Set<string>()
  listPanels(layoutTree).forEach((panel) => {
    if (!isTerminalBackedPanelKind(panel.panel.kind)) return
    const binding = layoutTree.panelTabs?.[panel.panel.id]
    for (const tabId of binding?.tabIds || []) {
      const normalized = readWindowingTabId(panel.panel.kind, tabId)
      if (normalized) terminalBindingIds.add(normalized)
    }
  })

  let terminalTabs: WindowingTerminalTabSnapshot[] | undefined
  if (hasWindowingOwnKey(parsedValue, 'terminalTabs')) {
    if (!Array.isArray(parsedValue.terminalTabs)) return null
    const seenIds = new Set<string>()
    const normalizedTabs: WindowingTerminalTabSnapshot[] = []
    for (const candidate of parsedValue.terminalTabs) {
      const snapshot = normalizeWindowingTerminalTabSnapshot(candidate)
      if (!snapshot || seenIds.has(snapshot.id) || !terminalBindingIds.has(snapshot.id)) {
        return null
      }
      seenIds.add(snapshot.id)
      normalizedTabs.push(snapshot)
    }
    terminalTabs = normalizedTabs
  }

  return {
    sourceClientId,
    layoutTree,
    createdAt: parsedValue.createdAt,
    ...(fileEditorSnapshot ? { fileEditorSnapshot } : {}),
    ...(terminalTabs !== undefined ? { terminalTabs } : {}),
  }
}

const serializeDetachedWindowState = (
  value: unknown,
): { state: DetachedWindowState; raw: string } | null => {
  try {
    const inputRaw = JSON.stringify(value)
    if (typeof inputRaw !== 'string') return null
    const state = parseDetachedWindowState(inputRaw)
    if (!state) return null
    return {
      state,
      raw: JSON.stringify(state),
    }
  } catch {
    return null
  }
}

export const readDetachedWindowState = (token: string): DetachedWindowState | null => {
  const localKey = getDetachedStateLocalKey(token)
  const sessionKey = getDetachedStateSessionKey(token)
  if (!localKey || !sessionKey) return null
  try {
    const sessionRaw = window.sessionStorage?.getItem(sessionKey)
    if (sessionRaw) {
      const parsed = parseDetachedWindowState(sessionRaw)
      if (parsed) {
        return parsed
      }
      window.sessionStorage?.removeItem(sessionKey)
    }

    const localRaw = window.localStorage?.getItem(localKey)
    if (!localRaw) return null
    const parsed = parseDetachedWindowState(localRaw)
    if (!parsed) {
      window.localStorage?.removeItem(localKey)
      return null
    }
    // Detached-state payloads can include large file-editor buffers. Mirror the
    // initial payload into sessionStorage for reload survival, then remove the
    // persistent localStorage copy so repeated detach/close cycles do not leak.
    try {
      window.sessionStorage?.setItem(sessionKey, localRaw)
      window.localStorage?.removeItem(localKey)
    } catch {
      // If sessionStorage is unavailable, keep localStorage as a fallback.
    }
    return parsed
  } catch {
    return null
  }
}

export const normalizeWindowingTabTarget = (
  value: unknown,
): WindowingTabTarget | null => {
  if (
    !isWindowingRecord(value) ||
    !hasWindowingOnlyKeys(value, ['kind', 'tabId']) ||
    !hasWindowingOwnKeys(value, ['kind', 'tabId']) ||
    !isTabbedPanelKind(value.kind as PanelKind)
  ) {
    return null
  }
  const kind = value.kind as WindowingTabKind
  const tabId = readWindowingTabId(kind, value.tabId)
  return tabId ? { kind, tabId } : null
}

export const openDetachedWindowState = async (
  state: DetachedWindowState,
  options?: OpenDetachedWindowOptions
): Promise<boolean> => {
  const serialized = serializeDetachedWindowState(state)
  if (!serialized) return false
  const normalizedState = serialized.state
  const sourceClientId = normalizedState.sourceClientId
  const focusTarget = options?.focusTarget
    ? normalizeWindowingTabTarget(options.focusTarget)
    : null
  if (options?.focusTarget && !focusTarget) {
    return false
  }
  const tabOwnership = collectLayoutTabOwnership(normalizedState.layoutTree)
  if (
    focusTarget &&
    !(tabOwnership[focusTarget.kind] || []).includes(focusTarget.tabId)
  ) {
    return false
  }

  const token = `detached-${makeLayoutId('state')}`
  const stashed = stashDetachedWindowState(token, normalizedState)
  if (!stashed) {
    return false
  }

  try {
    const result = await window.gyshell.windowing.openDetached(
      token,
      sourceClientId,
      {
        tabOwnership,
        ...(focusTarget ? { focusTarget } : {})
      }
    )
    if (result?.ok) {
      if (result.reused) {
        clearDetachedWindowState(token)
      }
      return true
    }
  } catch {
    // noop
  }

  clearDetachedWindowState(token)
  return false
}

const readLocalStorage = (): Storage | null => {
  try {
    return window.localStorage ?? null
  } catch {
    return null
  }
}

export const normalizeWindowingPanelDragPayload = (
  value: unknown,
): WindowingPanelDragPayload | null => {
  if (
    !isWindowingRecord(value) ||
    !hasWindowingOnlyKeys(value, [
      'sourceClientId',
      'sourcePanelId',
      'kind',
      'stateToken',
      'tabBinding',
      'terminalTabs',
      'fileEditorSnapshot',
    ])
  ) {
    return null
  }
  if (!hasWindowingOwnKeys(value, ['sourceClientId', 'sourcePanelId', 'kind'])) {
    return null
  }
  const parsed = value as unknown as Partial<WindowingPanelDragPayload>
  const sourceClientId = readTransportIdentifier(parsed.sourceClientId)
  const sourcePanelId = readOpaqueNonBlankWellFormedString(parsed.sourcePanelId)
  const kind = parsed.kind
  const hasStateToken = hasWindowingOwnKey(value, 'stateToken')
  const stateToken = hasStateToken
    ? readTransportIdentifier(parsed.stateToken)
    : undefined
  if (
    !sourceClientId ||
    !sourcePanelId ||
    !isPanelKind(kind) ||
    (hasStateToken && !stateToken)
  ) {
    return null
  }

  const hasTabBinding = hasWindowingOwnKey(value, 'tabBinding')
  if (
    hasTabBinding &&
    (!isWindowingRecord(parsed.tabBinding) ||
      !hasWindowingOnlyKeys(parsed.tabBinding, ['tabIds', 'activeTabId']))
  ) {
    return null
  }
  const tabBinding = hasTabBinding
    ? normalizePanelTabBinding(kind, parsed.tabBinding)
    : undefined
  if (hasTabBinding && (!isTabbedPanelKind(kind) || !tabBinding)) {
    return null
  }

  let terminalTabs: WindowingTerminalTabSnapshot[] | undefined
  const hasTerminalTabs = hasWindowingOwnKey(value, 'terminalTabs')
  if (hasTerminalTabs) {
    if (!isTerminalBackedPanelKind(kind) || !Array.isArray(parsed.terminalTabs) || !tabBinding) {
      return null
    }
    const normalizedTerminalTabs = parsed.terminalTabs.map((entry) =>
      normalizeWindowingTerminalTabSnapshot(entry),
    )
    if (normalizedTerminalTabs.some((entry) => !entry)) {
      return null
    }
    terminalTabs = normalizedTerminalTabs as WindowingTerminalTabSnapshot[]
    const seenTerminalIds = new Set<string>()
    for (const terminalTab of terminalTabs) {
      if (
        seenTerminalIds.has(terminalTab.id) ||
        !tabBinding.tabIds.includes(terminalTab.id)
      ) {
        return null
      }
      seenTerminalIds.add(terminalTab.id)
    }
  }

  const hasFileEditorSnapshot = hasWindowingOwnKey(
    value,
    'fileEditorSnapshot',
  )
  const fileEditorSnapshot = hasFileEditorSnapshot
    ? parseStrictFileEditorSnapshot(parsed.fileEditorSnapshot) ?? undefined
    : undefined
  if (
    (hasFileEditorSnapshot && !fileEditorSnapshot) ||
    (fileEditorSnapshot && kind !== 'fileEditor')
  ) {
    return null
  }

  return {
    sourceClientId,
    sourcePanelId,
    kind,
    ...(stateToken ? { stateToken } : {}),
    ...(tabBinding ? { tabBinding } : {}),
    ...(terminalTabs !== undefined ? { terminalTabs } : {}),
    ...(fileEditorSnapshot ? { fileEditorSnapshot } : {})
  }
}

export const normalizeWindowingTabDragPayload = (
  value: unknown,
): WindowingTabDragPayload | null => {
  if (
    !isWindowingRecord(value) ||
    !hasWindowingOnlyKeys(value, [
      'sourceClientId',
      'tabId',
      'kind',
      'sourcePanelId',
      'stateToken',
      'terminalTab',
    ])
  ) {
    return null
  }
  if (
    !hasWindowingOwnKeys(value, [
      'sourceClientId',
      'tabId',
      'kind',
      'sourcePanelId',
    ])
  ) {
    return null
  }
  const parsed = value as unknown as Partial<WindowingTabDragPayload>
  const sourceClientId = readTransportIdentifier(parsed.sourceClientId)
  const sourcePanelId = readOpaqueNonBlankWellFormedString(parsed.sourcePanelId)
  const kind = parsed.kind
  const hasStateToken = hasWindowingOwnKey(value, 'stateToken')
  const stateToken = hasStateToken
    ? readTransportIdentifier(parsed.stateToken)
    : undefined
  if (
    !sourceClientId ||
    !sourcePanelId ||
    !isTabbedPanelKind(kind as PanelKind) ||
    (hasStateToken && !stateToken)
  ) {
    return null
  }
  const tabId = readWindowingTabId(kind as PanelKind, parsed.tabId)
  if (!tabId) {
    return null
  }

  const hasTerminalTab = hasWindowingOwnKey(value, 'terminalTab')
  const terminalTab = hasTerminalTab
    ? normalizeWindowingTerminalTabSnapshot(parsed.terminalTab)
    : undefined
  if (
    (hasTerminalTab && !terminalTab) ||
    (terminalTab &&
      (!isTerminalBackedPanelKind(kind as PanelKind) || terminalTab.id !== tabId))
  ) {
    return null
  }

  return {
    sourceClientId,
    tabId,
    sourcePanelId,
    kind: kind as WindowingTabKind,
    ...(stateToken ? { stateToken } : {}),
    ...(terminalTab ? { terminalTab } : {})
  }
}

const getTabDragStateStorageKey = (token: string): string | null => {
  const normalizedToken = String(token || '').trim()
  if (!normalizedToken) {
    return null
  }
  return `${TAB_DRAG_STATE_KEY_PREFIX}${normalizedToken}`
}

/**
 * Tab drags cross BrowserWindows much more reliably when the native payload
 * stays lightweight. Mirror the panel strategy and stash the full tab snapshot
 * in localStorage behind a token.
 */
export const stashTabDragState = (token: string, payload: WindowingTabDragPayload): boolean => {
  const key = getTabDragStateStorageKey(token)
  const storage = readLocalStorage()
  const normalizedPayload = normalizeWindowingTabDragPayload(payload)
  if (!key || !storage || !normalizedPayload) {
    return false
  }
  try {
    storage.setItem(key, JSON.stringify(normalizedPayload))
    return true
  } catch {
    return false
  }
}

export const readTabDragState = (token: string): WindowingTabDragPayload | null => {
  const key = getTabDragStateStorageKey(token)
  const storage = readLocalStorage()
  if (!key || !storage) {
    return null
  }
  try {
    const raw = storage.getItem(key)
    return normalizeWindowingTabDragPayload(raw ? JSON.parse(raw) : null)
  } catch {
    return null
  }
}

export const clearTabDragState = (token: string): void => {
  const key = getTabDragStateStorageKey(token)
  const storage = readLocalStorage()
  if (!key || !storage) {
    return
  }
  try {
    storage.removeItem(key)
  } catch {
    // ignore cleanup failures
  }
}

const getPanelDragStateStorageKey = (token: string): string | null => {
  const normalizedToken = String(token || '').trim()
  if (!normalizedToken) {
    return null
  }
  return `${PANEL_DRAG_STATE_KEY_PREFIX}${normalizedToken}`
}

/**
 * Electron cross-window native drag sessions are far more reliable when the
 * drag payload stays small. For panels, stash the full transferable state in
 * localStorage and only put a lightweight token into DataTransfer/windowing.
 */
export const stashPanelDragState = (token: string, payload: WindowingPanelDragPayload): boolean => {
  const key = getPanelDragStateStorageKey(token)
  const storage = readLocalStorage()
  const normalizedPayload = normalizeWindowingPanelDragPayload(payload)
  if (!key || !storage || !normalizedPayload) {
    return false
  }
  try {
    storage.setItem(key, JSON.stringify(normalizedPayload))
    return true
  } catch {
    return false
  }
}

/**
 * Resolve the full stashed panel drag state for a transport token. This keeps
 * cross-window drag payloads small while preserving the complete panel state.
 */
export const readPanelDragState = (token: string): WindowingPanelDragPayload | null => {
  const key = getPanelDragStateStorageKey(token)
  const storage = readLocalStorage()
  if (!key || !storage) {
    return null
  }
  try {
    const raw = storage.getItem(key)
    return normalizeWindowingPanelDragPayload(raw ? JSON.parse(raw) : null)
  } catch {
    return null
  }
}

/**
 * The source window owns the stashed drag state and is responsible for removing
 * it after drag-end or once the target confirms the move.
 */
export const clearPanelDragState = (token: string): void => {
  const key = getPanelDragStateStorageKey(token)
  const storage = readLocalStorage()
  if (!key || !storage) {
    return
  }
  try {
    storage.removeItem(key)
  } catch {
    // ignore cleanup failures
  }
}

/**
 * A channel interface compatible with BroadcastChannel for cross-window messaging.
 * For file:// renderer windows, BroadcastChannel is not reliable because those
 * documents are usually treated as opaque origins. In that case we fall back to
 * localStorage + the storage event, similar to VS Code's renderer-side channel.
 */
export interface WindowingChannel {
  postMessage(message: WindowingMessage): void
  onmessage: ((event: { data: WindowingMessage }) => void) | null
  close(): void
}

const createStorageWindowingChannel = (): WindowingChannel | null => {
  if (typeof window === 'undefined') {
    return null
  }

  const storage = readLocalStorage()
  if (!storage) {
    return null
  }

  let messageHandler: ((event: { data: WindowingMessage }) => void) | null = null
  const handleStorage = (event: StorageEvent) => {
    if (event.key !== WINDOWING_STORAGE_CHANNEL_KEY || !event.newValue) {
      return
    }
    try {
      const payload = normalizeWindowingMessage(JSON.parse(event.newValue))
      if (payload) {
        messageHandler?.({ data: payload })
      }
    } catch {
      // ignore malformed windowing payloads
    }
  }

  window.addEventListener('storage', handleStorage)
  return {
    postMessage(message: WindowingMessage) {
      try {
        storage?.removeItem(WINDOWING_STORAGE_CHANNEL_KEY)
        storage?.setItem(WINDOWING_STORAGE_CHANNEL_KEY, JSON.stringify(message))
      } catch {
        // ignore storage broadcast errors
      }
    },
    get onmessage() {
      return messageHandler
    },
    set onmessage(handler: ((event: { data: WindowingMessage }) => void) | null) {
      messageHandler = handler
    },
    close() {
      window.removeEventListener('storage', handleStorage)
      messageHandler = null
    }
  }
}

export const createWindowingChannel = (): WindowingChannel | null => {
  const isFileProtocol = (() => {
    try {
      return window.location?.protocol === 'file:'
    } catch {
      return false
    }
  })()

  if (!isFileProtocol && typeof BroadcastChannel !== 'undefined') {
    try {
      return new BroadcastChannel(WINDOWING_BROADCAST_CHANNEL) as unknown as WindowingChannel
    } catch {
      return createStorageWindowingChannel()
    }
  }

  return createStorageWindowingChannel()
}
