import type { IWindowsPty } from '@xterm/xterm'

export type TerminalRemoteOs = 'unix' | 'windows'

export interface TerminalSystemInfoLike {
  release?: string
}

const CONPTY_MIN_WINDOWS_BUILD = 18309
const UNKNOWN_WINDOWS_BUILD = CONPTY_MIN_WINDOWS_BUILD

export const parseWindowsBuildNumber = (release?: string): number | undefined => {
  if (typeof release !== 'string') return undefined
  const normalized = release.trim()
  if (!normalized) return undefined

  const match = normalized.match(/^\d+\.\d+\.(\d+)/)
  if (!match) return undefined

  const parsed = Number.parseInt(match[1], 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
}

export const resolveTerminalWindowsPty = (
  remoteOs?: TerminalRemoteOs,
  systemInfo?: TerminalSystemInfoLike
): IWindowsPty | undefined => {
  if (remoteOs !== 'windows') {
    return undefined
  }

  const buildNumber = parseWindowsBuildNumber(systemInfo?.release) ?? UNKNOWN_WINDOWS_BUILD

  return {
    backend: buildNumber >= CONPTY_MIN_WINDOWS_BUILD ? 'conpty' : 'winpty',
    // A zero build is falsy in xterm 6.0 and accidentally enables POSIX reflow.
    // GyShell's supported Windows PTY implementations use ConPTY, so keep the
    // conservative pre-reflow ConPTY behavior until the exact build arrives.
    buildNumber
  }
}

export const resolveTerminalWindowsPtyTransition = (
  current: IWindowsPty | undefined,
  remoteOs?: TerminalRemoteOs,
  systemInfo?: TerminalSystemInfoLike
): IWindowsPty | undefined => {
  const next = resolveTerminalWindowsPty(remoteOs, systemInfo)
  if (
    remoteOs === 'windows' &&
    parseWindowsBuildNumber(systemInfo?.release) === undefined &&
    ((current?.backend === 'conpty' &&
      (current.buildNumber ?? 0) > UNKNOWN_WINDOWS_BUILD) ||
      (current?.backend === 'winpty' && (current.buildNumber ?? 0) > 0))
  ) {
    return current
  }
  return next
}

export const windowsPtyOptionsEqual = (
  left?: IWindowsPty,
  right?: IWindowsPty
): boolean =>
  (left?.backend || undefined) === (right?.backend || undefined) &&
  (left?.buildNumber ?? undefined) === (right?.buildNumber ?? undefined)
