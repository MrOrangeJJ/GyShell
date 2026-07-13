import {
  getTerminalConnectionCapabilities,
  getTerminalConnectionTypeDefinition,
} from '@gyshell/shared'
import { createHmac, randomBytes } from 'node:crypto'
import { v4 as uuidv4 } from 'uuid'
import type {
  BackendSettings,
  GenericConnectionConfig,
  LocalConnectionConfig,
  SSHConnectionConfig,
  SSHConnectionEntry,
  TerminalConfig,
  TunnelEntry,
} from '../../types'

const LOCAL_SAVED_CONNECTION_ID = 'local'
const SSH_SAVED_CONNECTION_ID_PREFIX = 'ssh:'
const OPAQUE_SSH_SAVED_CONNECTION_ID_PREFIX = 'ssh-opaque:'
// Selectors are sent to the model. A process-local HMAC key keeps them
// version-bound without exposing a reusable digest of saved credentials.
const SAVED_CONNECTION_SELECTOR_KEY = randomBytes(32)

export const buildSavedSshConnectionSelector = (
  entry: SSHConnectionEntry,
  settings: BackendSettings | null | undefined,
): string | null => {
  if (typeof entry.id !== 'string' || entry.id.length === 0) return null
  const idPrefix = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(entry.id)
    ? `${SSH_SAVED_CONNECTION_ID_PREFIX}${entry.id}`
    : `${OPAQUE_SSH_SAVED_CONNECTION_ID_PREFIX}${authenticateSelectorPart(entry.id)}`
  const connectionFingerprint = authenticateSelectorPart(
    JSON.stringify(buildSshConnectionConfig(entry, settings)),
  )
  return `${idPrefix}:${connectionFingerprint}`
}

const authenticateSelectorPart = (value: string): string =>
  createHmac('sha256', SAVED_CONNECTION_SELECTOR_KEY)
    .update(value, 'utf8')
    .digest('base64url')

export const getSavedSshConnectionDisplayName = (
  entry: Pick<SSHConnectionEntry, 'name' | 'host'>,
): string =>
  String(entry.name || '').trim() ||
  String(entry.host || '').trim() ||
  'Unnamed SSH connection'

const asPositiveInt = (value: unknown, fallback: number): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return fallback
  }
  return Math.max(1, Math.floor(value))
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const resolveRequestedTerminalType = (value: unknown): string => {
  if (typeof value !== 'string') {
    return 'local'
  }
  const normalized = value.trim()
  return normalized || 'local'
}

export const resolveTerminalConnectionCapabilities = (value: {
  type: string
}) => getTerminalConnectionCapabilities(value.type)

export const createAutoTerminalConfig = (
  terminals: Array<{ id: string; title: string; type?: string }>,
  partial: Record<string, unknown> = {},
): Record<string, unknown> => {
  const requestedType = resolveRequestedTerminalType(partial.type)
  const typeDefinition = getTerminalConnectionTypeDefinition(requestedType)
  const ids = new Set(terminals.map((terminal) => terminal.id))
  const typeCount = terminals.filter((terminal) => {
    if (terminal.type === requestedType) {
      return true
    }
    return terminal.id.startsWith(`${typeDefinition.idPrefix}-`)
  }).length

  const nextTerminalId = (() => {
    if (
      typeof partial.id === 'string' &&
      partial.id.trim().length > 0
    ) {
      return partial.id.trim()
    }
    const base =
      requestedType === 'local' ? Math.max(2, typeCount + 1) : typeCount + 1
    let index = base
    let candidate = `${typeDefinition.idPrefix}-${index}`
    while (ids.has(candidate)) {
      index += 1
      candidate = `${typeDefinition.idPrefix}-${index}`
    }
    return candidate
  })()

  const cols =
    Number.isInteger(partial.cols) && Number(partial.cols) > 0
      ? Number(partial.cols)
      : 120
  const rows =
    Number.isInteger(partial.rows) && Number(partial.rows) > 0
      ? Number(partial.rows)
      : 32
  const title =
    typeof partial.title === 'string' && partial.title.trim().length > 0
      ? partial.title.trim()
      : `${typeDefinition.defaultTitle} (${typeCount + 1})`

  return {
    ...partial,
    type: requestedType,
    id: nextTerminalId,
    title,
    cols,
    rows,
  }
}

/**
 * Resolves a version-bound saved-connection selector into a one-shot terminal
 * config. The selector fingerprints the resolved connection so edits made
 * after a model pass fail closed instead of targeting a different endpoint.
 */
export const buildTerminalConfigFromSavedConnection = (
  settings: BackendSettings | null | undefined,
  connectionId: string,
): TerminalConfig | null => {
  const normalizedConnectionId = String(connectionId || '').trim()
  if (normalizedConnectionId === LOCAL_SAVED_CONNECTION_ID) {
    return {
      type: 'local',
      id: `local-${uuidv4()}`,
      title: 'Local',
      cols: 80,
      rows: 24,
    }
  }

  const entry = settings?.connections?.ssh?.find(
    (candidate) =>
      buildSavedSshConnectionSelector(candidate, settings) ===
      normalizedConnectionId,
  )
  if (!entry) return null

  return {
    ...buildSshConnectionConfig(entry, settings),
    id: `ssh-${uuidv4()}`,
  }
}

const buildSshConnectionConfig = (
  entry: SSHConnectionEntry,
  settings: BackendSettings | null | undefined,
): SSHConnectionConfig => {
  const proxy = entry.proxyId
    ? settings?.connections?.proxies?.find(
        (candidate) => candidate.id === entry.proxyId,
      )
    : undefined
  const tunnels = (entry.tunnelIds ?? [])
    .map((tunnelId) =>
      settings?.connections?.tunnels?.find(
        (candidate) => candidate.id === tunnelId,
      ),
    )
    .filter((tunnel): tunnel is TunnelEntry => Boolean(tunnel))

  return {
    type: 'ssh',
    id: entry.id,
    title: getSavedSshConnectionDisplayName(entry),
    cols: 80,
    rows: 24,
    host: entry.host,
    port: asPositiveInt(entry.port, 22),
    username: entry.username,
    authMethod: entry.authMethod,
    password: entry.password,
    privateKey: entry.privateKey,
    privateKeyPath: entry.privateKeyPath,
    passphrase: entry.passphrase,
    proxy,
    ...(tunnels.length > 0 ? { tunnels } : {}),
    ...(entry.jumpHost
      ? { jumpHost: buildSshConnectionConfig(entry.jumpHost, settings) }
      : {}),
  }
}

export const normalizePersistedTerminalConfig = (
  raw: unknown,
): TerminalConfig | null => {
  if (!isObject(raw)) return null
  const type = typeof raw.type === 'string' ? raw.type.trim() : ''
  if (!type) return null

  const id = typeof raw.id === 'string' ? raw.id.trim() : ''
  const title = typeof raw.title === 'string' ? raw.title.trim() : ''
  if (!id || !title) return null

  const cols = asPositiveInt(raw.cols, 80)
  const rows = asPositiveInt(raw.rows, 24)

  if (type === 'local') {
    const next: LocalConnectionConfig = {
      type: 'local',
      id,
      title,
      cols,
      rows,
      ...(typeof raw.cwd === 'string' && raw.cwd.trim()
        ? { cwd: raw.cwd }
        : {}),
      ...(typeof raw.shell === 'string' && raw.shell.trim()
        ? { shell: raw.shell }
        : {}),
    }
    return next
  }

  if (type === 'ssh') {
    if (typeof raw.host !== 'string' || !raw.host.trim()) return null
    const port = asPositiveInt(raw.port, 22)
    if (typeof raw.username !== 'string' || !raw.username.trim()) return null
    const authMethod =
      raw.authMethod === 'privateKey'
        ? 'privateKey'
        : raw.authMethod === 'password'
          ? 'password'
          : null
    if (!authMethod) return null

    const next: SSHConnectionConfig = {
      type: 'ssh',
      id,
      title,
      cols,
      rows,
      host: raw.host,
      port,
      username: raw.username,
      authMethod,
      ...(typeof raw.password === 'string' ? { password: raw.password } : {}),
      ...(typeof raw.privateKey === 'string'
        ? { privateKey: raw.privateKey }
        : {}),
      ...(typeof raw.privateKeyPath === 'string'
        ? { privateKeyPath: raw.privateKeyPath }
        : {}),
      ...(typeof raw.passphrase === 'string'
        ? { passphrase: raw.passphrase }
        : {}),
      ...(isObject(raw.proxy) ? { proxy: raw.proxy as any } : {}),
      ...(Array.isArray(raw.tunnels) ? { tunnels: raw.tunnels as any } : {}),
      ...(isObject(raw.jumpHost) ? { jumpHost: raw.jumpHost as any } : {}),
    }
    return next
  }

  const next: GenericConnectionConfig = {
    ...raw,
    type,
    id,
    title,
    cols,
    rows,
  }
  return next
}
