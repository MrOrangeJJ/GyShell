import type { TerminalConfig } from './ipcTypes'
import {
  listPanels,
  makeLayoutId,
  type LayoutPanelTabBinding,
  type LayoutTree,
  type PanelKind
} from '../layout'
import {
  normalizeFileEditorSnapshot,
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
    clientId: ensureClientId()
  }
}

export const WINDOW_CONTEXT: RendererWindowContext = readWindowContext()

export const buildDetachedLayoutTree = (
  kind: PanelKind,
  tabBinding?: LayoutPanelTabBinding
): LayoutTree => {
  const panelId = makeLayoutId(`panel-${kind}`)
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
    ...(tabBinding
      ? {
          panelTabs: {
            [panelId]: {
              tabIds: tabBinding.tabIds || [],
              ...(tabBinding.activeTabId ? { activeTabId: tabBinding.activeTabId } : {})
            }
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
      const normalized = String(tabId || '').trim()
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
  if (!localKey) return false
  try {
    window.localStorage?.setItem(localKey, JSON.stringify(state))
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
  if (!sessionKey) return false
  try {
    window.sessionStorage?.setItem(sessionKey, JSON.stringify(state))
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

const parseDetachedWindowState = (raw: string): DetachedWindowState | null => {
  const parsed = JSON.parse(raw) as Partial<DetachedWindowState>
  if (!parsed || typeof parsed !== 'object') return null
  if (!parsed.layoutTree || typeof parsed.layoutTree !== 'object') return null
  const sourceClientId = typeof parsed.sourceClientId === 'string' ? parsed.sourceClientId.trim() : ''
  if (!sourceClientId) return null
  const fileEditorSnapshot = normalizeFileEditorSnapshot((parsed as any).fileEditorSnapshot)
  const terminalTabs = Array.isArray((parsed as any).terminalTabs)
    ? (parsed as any).terminalTabs
        .map((entry: unknown) => normalizeWindowingTerminalTabSnapshot(entry))
        .filter((entry: WindowingTerminalTabSnapshot | undefined): entry is WindowingTerminalTabSnapshot => !!entry)
    : undefined
  return {
    sourceClientId,
    layoutTree: parsed.layoutTree as LayoutTree,
    createdAt: Number.isFinite(parsed.createdAt) ? Number(parsed.createdAt) : Date.now(),
    ...(fileEditorSnapshot ? { fileEditorSnapshot } : {}),
    ...(terminalTabs && terminalTabs.length > 0 ? { terminalTabs } : {})
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

export const openDetachedWindowState = async (
  state: DetachedWindowState,
  options?: OpenDetachedWindowOptions
): Promise<boolean> => {
  const sourceClientId = String(state.sourceClientId || '').trim()
  if (!sourceClientId) {
    return false
  }

  const token = `detached-${makeLayoutId('state')}`
  const stashed = stashDetachedWindowState(token, state)
  if (!stashed) {
    return false
  }

  try {
    const result = await window.gyshell.windowing.openDetached(
      token,
      sourceClientId,
      {
        tabOwnership: collectLayoutTabOwnership(state.layoutTree),
        ...(options?.focusTarget ? { focusTarget: options.focusTarget } : {})
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

const normalizePanelTabBinding = (value: unknown): LayoutPanelTabBinding | undefined => {
  if (!value || typeof value !== 'object') {
    return undefined
  }
  const rawBinding = value as Partial<LayoutPanelTabBinding>
  const tabIds = Array.isArray(rawBinding.tabIds)
    ? rawBinding.tabIds.filter((tabId): tabId is string => typeof tabId === 'string' && tabId.trim().length > 0)
    : []
  const activeTabId =
    typeof rawBinding.activeTabId === 'string' && tabIds.includes(rawBinding.activeTabId)
      ? rawBinding.activeTabId
      : tabIds[0]
  return {
    tabIds,
    ...(activeTabId ? { activeTabId } : {})
  }
}

export const normalizeWindowingTerminalTabSnapshot = (value: unknown): WindowingTerminalTabSnapshot | undefined => {
  if (!value || typeof value !== 'object') {
    return undefined
  }
  const raw = value as Partial<WindowingTerminalTabSnapshot>
  const id = typeof raw.id === 'string' ? raw.id.trim() : ''
  const title = typeof raw.title === 'string' ? raw.title.trim() : ''
  const config = raw.config
  if (!id || !title || !config || typeof config !== 'object') {
    return undefined
  }
  const connectionRef =
    raw.connectionRef && typeof raw.connectionRef === 'object'
      ? (() => {
          const refType =
            typeof raw.connectionRef.type === 'string'
              ? raw.connectionRef.type.trim()
              : ''
          if (!refType) {
            return undefined
          }
          const entryId =
            typeof raw.connectionRef.entryId === 'string' &&
            raw.connectionRef.entryId.trim().length > 0
              ? raw.connectionRef.entryId.trim()
              : undefined
          return {
            type: refType,
            ...(entryId ? { entryId } : {}),
          }
        })()
      : undefined
  const runtimeState =
    raw.runtimeState === 'initializing' || raw.runtimeState === 'ready' || raw.runtimeState === 'exited'
      ? raw.runtimeState
      : undefined
  const lastExitCode = typeof raw.lastExitCode === 'number' && Number.isFinite(raw.lastExitCode) ? raw.lastExitCode : undefined
  return {
    id,
    title,
    config: config as TerminalConfig,
    ...(connectionRef ? { connectionRef } : {}),
    ...(runtimeState ? { runtimeState } : {}),
    ...(typeof lastExitCode === 'number' ? { lastExitCode } : {})
  }
}

const normalizePanelDragState = (value: unknown): WindowingPanelDragPayload | null => {
  if (!value || typeof value !== 'object') {
    return null
  }
  const parsed = value as Partial<WindowingPanelDragPayload>
  const sourceClientId = typeof parsed.sourceClientId === 'string' ? parsed.sourceClientId.trim() : ''
  const sourcePanelId = typeof parsed.sourcePanelId === 'string' ? parsed.sourcePanelId.trim() : ''
  const kind = parsed.kind
  const stateToken = typeof parsed.stateToken === 'string' ? parsed.stateToken.trim() : ''
  if (!sourceClientId || !sourcePanelId) {
    return null
  }
  if (kind !== 'chat' && kind !== 'terminal' && kind !== 'filesystem' && kind !== 'fileEditor' && kind !== 'monitor' && kind !== 'listPanel') {
    return null
  }
  const tabBinding = normalizePanelTabBinding(parsed.tabBinding)
  const terminalTabs = Array.isArray(parsed.terminalTabs)
    ? parsed.terminalTabs
        .map((entry) => normalizeWindowingTerminalTabSnapshot(entry))
        .filter((entry): entry is WindowingTerminalTabSnapshot => !!entry)
    : undefined
  const fileEditorSnapshot = normalizeFileEditorSnapshot(parsed.fileEditorSnapshot)
  return {
    sourceClientId,
    sourcePanelId,
    kind,
    ...(stateToken ? { stateToken } : {}),
    ...(tabBinding ? { tabBinding } : {}),
    ...(terminalTabs && terminalTabs.length > 0 ? { terminalTabs } : {}),
    ...(fileEditorSnapshot ? { fileEditorSnapshot } : {})
  }
}

const normalizeTabDragState = (value: unknown): WindowingTabDragPayload | null => {
  if (!value || typeof value !== 'object') {
    return null
  }
  const parsed = value as Partial<WindowingTabDragPayload>
  const sourceClientId = typeof parsed.sourceClientId === 'string' ? parsed.sourceClientId.trim() : ''
  const tabId = typeof parsed.tabId === 'string' ? parsed.tabId.trim() : ''
  const sourcePanelId = typeof parsed.sourcePanelId === 'string' ? parsed.sourcePanelId.trim() : ''
  const kind = parsed.kind
  const stateToken = typeof parsed.stateToken === 'string' ? parsed.stateToken.trim() : ''
  if (!sourceClientId || !tabId || !sourcePanelId) {
    return null
  }
  if (kind !== 'chat' && kind !== 'terminal' && kind !== 'filesystem' && kind !== 'fileEditor' && kind !== 'monitor' && kind !== 'listPanel') {
    return null
  }
  const terminalTab = normalizeWindowingTerminalTabSnapshot(parsed.terminalTab)
  return {
    sourceClientId,
    tabId,
    sourcePanelId,
    kind,
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
  const normalizedPayload = normalizeTabDragState(payload)
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
    return normalizeTabDragState(raw ? JSON.parse(raw) : null)
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
  const normalizedPayload = normalizePanelDragState(payload)
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
    return normalizePanelDragState(raw ? JSON.parse(raw) : null)
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
      const payload = JSON.parse(event.newValue) as WindowingMessage
      messageHandler?.({ data: payload })
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
