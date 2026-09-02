import os from 'os'
import { isValidTerminalRuntimeId } from '@gyshell/shared'
import type { TerminalService } from './TerminalService'
import type {
  ResourceSnapshot,
  CpuSnapshot,
  MemorySnapshot,
  DiskSnapshot,
  GpuSnapshot,
  NetworkSnapshot,
  NetworkConnectionSnapshot,
  ProcessSnapshot,
  ResourceSystemSnapshot,
  TerminalTab,
} from '../types'

const DEFAULT_POLL_INTERVAL_MS = 2000
const MIN_POLL_INTERVAL_MS = 500
const MAX_POLL_INTERVAL_MS = 30000
const SNAPSHOT_COMMAND_TIMEOUT_MS = 10000
const WINDOWS_SNAPSHOT_COMMAND_TIMEOUT_MS = 20000
const WINDOWS_SNAPSHOT_RETRY_TIMEOUT_MS = 25000
const SECTION_MARKER = '__GYSHELL_MONITOR_SECTION__::'
const ENRIGIN_GPU_QUERY_MARKER = '__GYSHELL_ENRIGIN_GPU_QUERY__'
const ENRIGIN_GPU_DMON_MARKER = '__GYSHELL_ENRIGIN_GPU_DMON__'
const MAX_TOP_PROCESSES = 16
const MAX_SOCKET_ROWS = 24
const UNIX_MONITOR_LOCALE_EXPORT =
  "LC_ALL='en_US.UTF-8'; LANG='en_US.UTF-8'; export LC_ALL LANG"

interface CpuCounters {
  user: number
  nice: number
  system: number
  idle: number
  iowait: number
  irq: number
  softirq: number
  steal: number
}

interface NetCounters {
  [iface: string]: { rxBytes: number; txBytes: number }
}

interface EnriginEcuQueryInfo {
  index: number
  name?: string
  memoryTotalMiB?: number
  memoryUsedMiB?: number
  temperatureC?: number
  powerUsageWatts?: number
  powerLimitWatts?: number
  powerState?: string
  memoryClockMHz?: number
}

interface EnriginEcuDmonInfo {
  index: number
  utilizationPercent?: number
  sipUtilizationPercent?: number
  memoryUsagePercent?: number
  memoryTotalMiB?: number
  temperatureC?: number
  powerUsageWatts?: number
  memoryClockMHz?: number
}

type MonitorTargetPlatform = 'linux' | 'darwin' | 'windows' | 'unknown'

interface RawSocketEntry {
  protocol: 'tcp' | 'udp'
  state?: string
  localAddress: string
  localPort?: number
  remoteAddress?: string
  remotePort?: number
  pid?: number
  processName?: string
  user?: string
}

interface ParsedDfEntry {
  filesystem: string
  mountPoint: string
  totalBytes: number
  usedBytes: number
  availableBytes: number
  usagePercent: number
}

interface DarwinDiskMetadata {
  deviceIdentifier: string
  containerReference?: string
  mountPoint?: string
  volumeName?: string
  content?: string
  osInternal?: boolean
  roles?: string[]
}

interface MonitorSession {
  sourceKey: string
  sourceTerminalId: string
  timer: ReturnType<typeof setInterval>
  intervalMs: number
  ownerIdsByTerminalId: Map<string, Set<string>>
  inFlight: boolean
  previousCpuCounters?: CpuCounters[]
  previousNetCounters?: NetCounters
  previousSampleTime?: number
  targetPlatform?: MonitorTargetPlatform
}

type CollectedSnapshot = Omit<ResourceSnapshot, 'timestamp' | 'terminalId' | 'system'> & {
  system?: Partial<ResourceSystemSnapshot>
}

type SnapshotPublisher = (channel: string, data: unknown) => void

export class ResourceMonitorService {
  private sessions = new Map<string, MonitorSession>()
  private sourceKeyByTerminalId = new Map<string, string>()
  private publisher: SnapshotPublisher | null = null

  constructor(private terminalService: TerminalService) {}

  setPublisher(publisher: SnapshotPublisher): void {
    this.publisher = publisher
  }

  start(terminalId: string, ownerId = 'default', intervalMs?: number): void {
    if (!isValidTerminalRuntimeId(terminalId)) {
      return
    }
    const normalizedOwnerId = String(ownerId || 'default').trim() || 'default'
    const sourceKey = this.resolveSourceKey(terminalId)
    const existing = this.sessions.get(sourceKey)
    if (existing) {
      this.addOwner(existing, terminalId, normalizedOwnerId)
      this.ensureSourceTerminal(existing, terminalId)
      return
    }

    const interval = Math.max(
      MIN_POLL_INTERVAL_MS,
      Math.min(MAX_POLL_INTERVAL_MS, intervalMs ?? DEFAULT_POLL_INTERVAL_MS)
    )

    const session: MonitorSession = {
      sourceKey,
      sourceTerminalId: terminalId,
      intervalMs: interval,
      ownerIdsByTerminalId: new Map<string, Set<string>>(),
      inFlight: false,
      timer: setInterval(() => {
        void this.collectAndPublish(sourceKey)
      }, interval),
    }

    this.addOwner(session, terminalId, normalizedOwnerId)
    this.sessions.set(sourceKey, session)
    void this.collectAndPublish(sourceKey)
  }

  stop(terminalId: string, ownerId = 'default'): void {
    if (!isValidTerminalRuntimeId(terminalId)) {
      return
    }
    const sourceKey =
      this.sourceKeyByTerminalId.get(terminalId) ||
      this.resolveSourceKey(terminalId)
    const session = this.sessions.get(sourceKey)
    if (!session) return
    const normalizedOwnerId = String(ownerId || 'default').trim() || 'default'
    const owners = session.ownerIdsByTerminalId.get(terminalId)
    if (!owners?.delete(normalizedOwnerId)) {
      return
    }
    if (owners.size === 0) {
      session.ownerIdsByTerminalId.delete(terminalId)
      this.sourceKeyByTerminalId.delete(terminalId)
      this.ensureSourceTerminal(session)
    }
    if (session.ownerIdsByTerminalId.size > 0) return
    clearInterval(session.timer)
    this.sessions.delete(sourceKey)
  }

  stopAll(): void {
    for (const session of this.sessions.values()) {
      clearInterval(session.timer)
    }
    this.sessions.clear()
    this.sourceKeyByTerminalId.clear()
  }

  isMonitoring(terminalId: string): boolean {
    if (!isValidTerminalRuntimeId(terminalId)) {
      return false
    }
    const session = this.getSessionForTerminal(terminalId)
    return !!session?.ownerIdsByTerminalId.has(terminalId)
  }

  async collectSnapshot(terminalId: string): Promise<ResourceSnapshot> {
    if (!isValidTerminalRuntimeId(terminalId)) {
      return {
        timestamp: Date.now(),
        terminalId: typeof terminalId === 'string' ? terminalId : '',
        error: 'Invalid terminal ID',
      }
    }
    const session = this.getSessionForTerminal(terminalId)
    const sourceTerminalId = this.resolveCollectTerminalId(terminalId, session)
    const terminal = sourceTerminalId
      ? this.terminalService.getTerminalById(sourceTerminalId)
      : this.terminalService.getTerminalById(terminalId)
    if (!terminal) {
      return {
        timestamp: Date.now(),
        terminalId,
        error: 'Terminal not found',
      }
    }

    const now = Date.now()

    try {
      const platform = await this.resolveTargetPlatform(terminal, session)
      const baseSystem = this.buildSystemSnapshot(terminal, platform)

      if (platform === 'windows') {
        const snapshot = await this.collectWindowsSnapshot(terminal.id)
        const { system, ...rest } = snapshot
        return {
          timestamp: now,
          terminalId,
          ...rest,
          system: this.mergeSystemSnapshot(baseSystem, system),
        }
      }

      if (platform === 'darwin') {
        const snapshot = await this.collectDarwinSnapshot(terminal.id, session)
        if (session) {
          session.previousSampleTime = now
        }
        const { system, ...rest } = snapshot
        return {
          timestamp: now,
          terminalId,
          ...rest,
          system: this.mergeSystemSnapshot(baseSystem, system),
        }
      }

      if (platform === 'linux') {
        const snapshot = await this.collectLinuxSnapshot(terminal.id, session)
        if (session) {
          session.previousSampleTime = now
        }
        const { system, ...rest } = snapshot
        return {
          timestamp: now,
          terminalId,
          ...rest,
          system: this.mergeSystemSnapshot(baseSystem, system),
        }
      }

      return {
        timestamp: now,
        terminalId,
        system: baseSystem,
        error: 'Unsupported monitor platform',
      }
    } catch (error) {
      return {
        timestamp: now,
        terminalId,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  private addOwner(session: MonitorSession, terminalId: string, ownerId: string): void {
    const existing = session.ownerIdsByTerminalId.get(terminalId)
    if (existing) {
      existing.add(ownerId)
    } else {
      session.ownerIdsByTerminalId.set(terminalId, new Set([ownerId]))
    }
    this.sourceKeyByTerminalId.set(terminalId, session.sourceKey)
  }

  private getMonitorIdentity(terminalId: string): string | null {
    try {
      return this.terminalService.getMonitorIdentity(terminalId)
    } catch {
      return null
    }
  }

  private resolveSourceKey(terminalId: string): string {
    const existing = this.sourceKeyByTerminalId.get(terminalId)
    if (existing) {
      return existing
    }
    return this.getMonitorIdentity(terminalId) || `terminal://${terminalId}`
  }

  private getSessionForTerminal(terminalId: string): MonitorSession | undefined {
    if (!terminalId) {
      return undefined
    }
    const sourceKey =
      this.sourceKeyByTerminalId.get(terminalId) ||
      this.getMonitorIdentity(terminalId)
    if (!sourceKey) {
      return undefined
    }
    return this.sessions.get(sourceKey)
  }

  private ensureSourceTerminal(
    session: MonitorSession,
    preferredTerminalId?: string
  ): void {
    if (this.isReadyMonitorTerminal(session.sourceTerminalId)) {
      return
    }

    if (
      preferredTerminalId &&
      this.isReadyMonitorTerminal(preferredTerminalId)
    ) {
      if (session.sourceTerminalId !== preferredTerminalId) {
        session.sourceTerminalId = preferredTerminalId
        session.targetPlatform = undefined
      }
      return
    }

    for (const terminalId of session.ownerIdsByTerminalId.keys()) {
      if (this.isReadyMonitorTerminal(terminalId)) {
        session.sourceTerminalId = terminalId
        session.targetPlatform = undefined
        return
      }
    }

    const fallback = session.ownerIdsByTerminalId.keys().next().value
    if (typeof fallback === 'string' && fallback.length > 0) {
      session.sourceTerminalId = fallback
      session.targetPlatform = undefined
    }
  }

  private isReadyMonitorTerminal(terminalId: string | undefined): boolean {
    if (!terminalId) {
      return false
    }
    const terminal = this.terminalService.getTerminalById(terminalId)
    return (
      !!terminal &&
      terminal.runtimeState === 'ready' &&
      terminal.capabilities?.supportsMonitor !== false
    )
  }

  private resolveCollectTerminalId(
    requestedTerminalId: string,
    session?: MonitorSession
  ): string | null {
    if (!session) {
      return requestedTerminalId || null
    }
    this.ensureSourceTerminal(session, requestedTerminalId)
    return session.sourceTerminalId || requestedTerminalId || null
  }

  private async collectAndPublish(sourceKey: string): Promise<void> {
    const session = this.sessions.get(sourceKey)
    if (!session || session.inFlight) {
      return
    }
    session.inFlight = true
    try {
      this.ensureSourceTerminal(session)
      const terminalIds = Array.from(session.ownerIdsByTerminalId.keys())
      if (terminalIds.length === 0) {
        return
      }
      const sourceTerminalId = session.sourceTerminalId || terminalIds[0]
      const snapshot = await this.collectSnapshot(sourceTerminalId)
      if (this.publisher) {
        terminalIds.forEach((terminalId) => {
          this.publisher?.(
            'monitor:snapshot',
            terminalId === snapshot.terminalId ? snapshot : { ...snapshot, terminalId }
          )
        })
      }
    } finally {
      session.inFlight = false
    }
  }

  private async resolveTargetPlatform(
    terminal: TerminalTab,
    session?: MonitorSession
  ): Promise<MonitorTargetPlatform> {
    if (session?.targetPlatform && session.targetPlatform !== 'unknown') {
      return session.targetPlatform
    }

    const localPlatform = this.normalizePlatform(os.platform())
    if (terminal.type === 'local') {
      if (session) {
        session.targetPlatform = localPlatform
      }
      return localPlatform
    }

    const fromSystem = this.normalizePlatform(
      terminal.systemInfo?.platform || terminal.systemInfo?.os
    )
    if (fromSystem !== 'unknown') {
      if (session) {
        session.targetPlatform = fromSystem
      }
      return fromSystem
    }

    if (terminal.remoteOs === 'windows') {
      if (session) {
        session.targetPlatform = 'windows'
      }
      return 'windows'
    }

    const detectionCommand = [
      'uname -s 2>/dev/null',
      'sw_vers -productName 2>/dev/null',
      'cmd.exe /c ver 2>&1',
    ].join(' ; ')
    const result = await this.terminalService.execOnTerminal(
      terminal.id,
      detectionCommand,
      4000
    )
    const resolved = this.normalizePlatform(`${result?.stdout || ''}\n${result?.stderr || ''}`)
    if (session) {
      session.targetPlatform = resolved
    }
    return resolved
  }

  private buildSystemSnapshot(
    terminal: TerminalTab,
    platform: MonitorTargetPlatform
  ): ResourceSystemSnapshot {
    const info = terminal.systemInfo
    if (info) {
      const infoPlatform = this.normalizePlatform(info.platform || info.os)
      const useInfoFields = infoPlatform === 'unknown' || infoPlatform === platform
      return {
        connectionType: terminal.type,
        platform,
        hostname: useInfoFields ? this.sanitizeTextField(info.hostname) : undefined,
        osName: useInfoFields ? this.sanitizeTextField(info.os) : undefined,
        release: useInfoFields ? this.sanitizeTextField(info.release) : undefined,
        arch: useInfoFields ? this.sanitizeTextField(info.arch) : undefined,
        shell: useInfoFields ? this.sanitizeTextField(info.shell) : undefined,
      }
    }

    if (terminal.type === 'local') {
      return {
        connectionType: terminal.type,
        platform,
        hostname: os.hostname(),
        osName: os.platform(),
        release: os.release(),
        arch: os.arch(),
        shell:
          process.env.SHELL ||
          (platform === 'windows' ? process.env.ComSpec || 'powershell.exe' : undefined),
      }
    }

    return {
      connectionType: terminal.type,
      platform,
    }
  }

  private sanitizeTextField(value: unknown): string | undefined {
    const normalized = String(value || '').trim()
    if (!normalized) {
      return undefined
    }
    const lower = normalized.toLowerCase()
    if (lower === 'unknown' || lower === 'n/a' || lower === 'null' || lower === 'undefined') {
      return undefined
    }
    return normalized
  }

  private sanitizeDiskFilesystem(value: unknown, fallback: string): string {
    const normalized = String(value || '')
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (!normalized) {
      return fallback
    }

    const segments = normalized
      .split('·')
      .map((segment) => segment.trim())
      .filter((segment) => segment.length > 0)
    const hasCorruption = /�|\?{2,}/.test(normalized)

    if (!hasCorruption) {
      return normalized
    }

    const safeSegments = segments.filter((segment, index) => {
      if (index === 0) {
        return true
      }
      return !/�|\?{2,}/.test(segment)
    })

    if (safeSegments.length > 0) {
      return safeSegments.join(' · ')
    }

    return fallback
  }

  private mergeSystemSnapshot(
    base: ResourceSystemSnapshot,
    override?: Partial<ResourceSystemSnapshot>
  ): ResourceSystemSnapshot {
    return {
      ...base,
      ...(override?.hostname ? { hostname: override.hostname } : {}),
      ...(override?.osName ? { osName: override.osName } : {}),
      ...(override?.release ? { release: override.release } : {}),
      ...(override?.arch ? { arch: override.arch } : {}),
      ...(override?.shell ? { shell: override.shell } : {}),
    }
  }

  private normalizePlatform(value: unknown): MonitorTargetPlatform {
    const normalized = String(value || '').trim().toLowerCase()
    if (!normalized) return 'unknown'
    if (
      normalized.includes('win32') ||
      normalized.includes('windows') ||
      normalized.includes('mingw') ||
      normalized.includes('msys')
    ) {
      return 'windows'
    }
    if (
      normalized.includes('darwin') ||
      normalized.includes('mac') ||
      normalized.includes('osx')
    ) {
      return 'darwin'
    }
    if (
      normalized.includes('linux') ||
      normalized.includes('ubuntu') ||
      normalized.includes('debian') ||
      normalized.includes('fedora') ||
      normalized.includes('centos') ||
      normalized.includes('red hat') ||
      normalized.includes('rhel') ||
      normalized.includes('rocky') ||
      normalized.includes('alma') ||
      normalized.includes('arch') ||
      normalized.includes('suse') ||
      normalized.includes('alpine')
    ) {
      return 'linux'
    }
    return 'unknown'
  }

  private async collectLinuxSnapshot(
    terminalId: string,
    session?: MonitorSession
  ): Promise<CollectedSnapshot> {
    const result = await this.terminalService.execOnTerminal(
      terminalId,
      this.buildLinuxMonitorCommand(),
      SNAPSHOT_COMMAND_TIMEOUT_MS
    )
    if (!result) {
      return { error: 'Failed to execute Linux monitor command' }
    }

    const sections = this.parseSectionedOutput(result.stdout)
    const cpu = this.parseProcStatForCpu(sections.get('cpu') || '', session)
    const memory = this.parseLinuxMeminfo(sections.get('memory') || '')
    const disks = this.parseDfOutput(sections.get('disks') || '')
    const gpus = this.parseLinuxGpuOutput(sections.get('gpu') || '')
    const network = this.parseLinuxNetDevOutput(sections.get('network') || '', session)
    const processes = this.parseUnixProcessOutput(sections.get('processes') || '')
    const socketEntries = this.parseLinuxSocketEntries(sections.get('sockets') || '')
    const loadAverage = this.parseLoadAvg(sections.get('load') || '')
    const uptimeSeconds = this.parseUptime(sections.get('uptime') || '')
    const system = this.parseUnixSystemSection(sections.get('system') || '')

    return {
      system,
      loadAverage,
      cpu,
      memory,
      disks: disks.length > 0 ? disks : undefined,
      gpus: gpus.length > 0 ? gpus : undefined,
      network: network.length > 0 ? network : undefined,
      processes: processes.length > 0 ? processes : undefined,
      networkConnections:
        socketEntries.length > 0 ? this.aggregateSocketEntries(socketEntries) : undefined,
      uptimeSeconds,
    }
  }

  private async collectDarwinSnapshot(
    terminalId: string,
    session?: MonitorSession
  ): Promise<CollectedSnapshot> {
    const result = await this.terminalService.execOnTerminal(
      terminalId,
      this.buildDarwinMonitorCommand(),
      SNAPSHOT_COMMAND_TIMEOUT_MS
    )
    if (!result) {
      return { error: 'Failed to execute macOS monitor command' }
    }

    const sections = this.parseSectionedOutput(result.stdout)
    const memorySysctl = this.parseDarwinMemorySysctl(sections.get('memorySysctl') || '')
    const cpu = this.parseDarwinCpu(
      sections.get('cpu') || '',
      memorySysctl.logicalCoreCount,
      memorySysctl.modelName
    )
    const memory = this.parseDarwinMemory(
      sections.get('vmStat') || '',
      memorySysctl.totalBytes,
      sections.get('swap') || ''
    )
    const disks = this.parseDarwinDisks(
      sections.get('disks') || '',
      sections.get('diskList') || '',
      sections.get('diskApfs') || ''
    )
    const gpus = this.parseNvidiaSmiOutput(sections.get('gpu') || '')
    const network = this.parseDarwinNetstatInterfaces(sections.get('network') || '', session)
    const processes = this.parseUnixProcessOutput(sections.get('processes') || '')
    const socketEntries = this.parseMacLsofOutput(sections.get('sockets') || '')
    const loadAverage = this.parseDarwinLoadAvg(sections.get('load') || '')
    const uptimeSeconds = this.parseDarwinBootTime(sections.get('uptime') || '')
    const system = this.parseUnixSystemSection(sections.get('system') || '')

    return {
      system,
      loadAverage,
      cpu,
      memory,
      disks: disks.length > 0 ? disks : undefined,
      gpus: gpus.length > 0 ? gpus : undefined,
      network: network.length > 0 ? network : undefined,
      processes: processes.length > 0 ? processes : undefined,
      networkConnections:
        socketEntries.length > 0 ? this.aggregateSocketEntries(socketEntries) : undefined,
      uptimeSeconds,
    }
  }

  private async collectWindowsSnapshot(
    terminalId: string
  ): Promise<CollectedSnapshot> {
    const terminal = this.terminalService.getTerminalById(terminalId)
    const monitorScript = this.buildWindowsMonitorScript()
    const result = await this.executeWindowsMonitorCommand(
      terminalId,
      terminal,
      monitorScript
    )
    if (!result) {
      return { error: 'Failed to execute Windows monitor command' }
    }

    const raw = (result.stdout || '').trim()
    if (!raw) {
      return {
        error: result.stderr?.trim() || 'Windows monitor command returned no data',
      }
    }

    let parsed: any
    try {
      parsed = this.parseWindowsMonitorPayload(raw)
    } catch (error) {
      return {
        error:
          error instanceof Error
            ? `Failed to parse Windows monitor snapshot: ${error.message}`
            : 'Failed to parse Windows monitor snapshot',
      }
    }

    const parsedSystem = parsed.system ?? parsed.s
    const parsedCpu = parsed.cpu ?? parsed.c
    const parsedMemory = parsed.memory ?? parsed.m
    const parsedDisks = parsed.disks ?? parsed.d
    const parsedNetwork = parsed.network ?? parsed.n
    const parsedProcesses = parsed.processes ?? parsed.p
    const parsedSockets = parsed.sockets ?? parsed.k
    const parsedGpus = parsed.gpus ?? parsed.g
    const parsedUptime = parsed.uptimeSeconds ?? parsed.u

    const socketEntries: RawSocketEntry[] = this.coerceArray(parsedSockets)
      .map((entry: any) => this.normalizeSocketEntry(entry))
      .filter((entry: RawSocketEntry | null): entry is RawSocketEntry => entry !== null)

    const disks = this.coerceArray(parsedDisks)
      .map((entry: any) => this.normalizeDisk(entry))
      .filter((entry: DiskSnapshot) => entry.totalBytes > 0)
      .sort((left: DiskSnapshot, right: DiskSnapshot) => right.usedBytes - left.usedBytes)
    const gpus = this.coerceArray(parsedGpus).map((entry: any) => this.normalizeGpu(entry))
    const network = this.coerceArray(parsedNetwork)
      .map((entry: any) => this.normalizeNetwork(entry))
      .filter((entry: NetworkSnapshot | null): entry is NetworkSnapshot => entry !== null)
    const processes = this.coerceArray(parsedProcesses)
      .map((entry: any) => this.normalizeProcess(entry))
      .filter((entry: ProcessSnapshot | null): entry is ProcessSnapshot => entry !== null)

    return {
      system: parsedSystem ? this.normalizeWindowsSystem(parsedSystem) : undefined,
      cpu: parsedCpu ? this.normalizeWindowsCpu(parsedCpu) : undefined,
      memory: parsedMemory ? this.normalizeWindowsMemory(parsedMemory) : undefined,
      disks: disks.length > 0 ? disks : undefined,
      gpus: gpus.length > 0 ? gpus : undefined,
      network: network.length > 0 ? network : undefined,
      processes: processes.length > 0 ? processes : undefined,
      networkConnections:
        socketEntries.length > 0 ? this.aggregateSocketEntries(socketEntries) : undefined,
      uptimeSeconds: this.asNumber(parsedUptime),
    }
  }

  private async executeWindowsMonitorCommand(
    terminalId: string,
    _terminal: TerminalTab | undefined,
    monitorScript: string
  ): Promise<{ stdout: string; stderr: string } | null> {
    const attempts: Array<{
      command: string
      timeoutMs: number
      options?: { stdin?: string }
    }> = [
      {
        command: this.buildWindowsMonitorCommand(),
        timeoutMs: WINDOWS_SNAPSHOT_COMMAND_TIMEOUT_MS,
        options: { stdin: `${monitorScript}\r\n` }
      },
      {
        command: this.buildWindowsMonitorCommand(),
        timeoutMs: WINDOWS_SNAPSHOT_RETRY_TIMEOUT_MS,
        options: { stdin: `${monitorScript}\r\n` }
      }
    ]

    let lastResult: { stdout: string; stderr: string } | null = null
    for (const attempt of attempts) {
      const result = await this.terminalService.execOnTerminal(
        terminalId,
        attempt.command,
        attempt.timeoutMs,
        attempt.options
      )
      if (result?.stdout?.trim()) {
        return result
      }
      if (result) {
        lastResult = result
      }
    }

    return lastResult
  }

  private buildLinuxMonitorCommand(): string {
    return this.buildSectionedCommand([
      [
        'system',
        "hostname; (awk -F= '/^PRETTY_NAME=/{gsub(/\"/,\"\",$2); print $2; found=1; exit} /^ID=/{gsub(/\"/,\"\",$2); print $2; found=1; exit} END{if(!found) print \"Linux\"}' /etc/os-release 2>/dev/null || echo Linux); uname -r; uname -m; printf '%s\\n' \"${SHELL:-/bin/sh}\"",
      ],
      ['cpu', 'cat /proc/stat'],
      ['memory', 'cat /proc/meminfo'],
      ['disks', 'df -P -k'],
      ['gpu', this.buildLinuxGpuMonitorCommand()],
      ['network', 'cat /proc/net/dev'],
      ['load', 'cat /proc/loadavg'],
      ['uptime', 'cat /proc/uptime'],
      [
        'processes',
        `ps -Ao pid=,user=,state=,%cpu=,rss=,comm=,args= -r | sed -n '1,${MAX_TOP_PROCESSES}p'`,
      ],
      ['sockets', 'ss -H -tunap 2>/dev/null || netstat -tunap 2>/dev/null || true'],
    ])
  }

  private buildLinuxGpuMonitorCommand(): string {
    const nvidiaCommand =
      'if command -v nvidia-smi >/dev/null 2>&1; then nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total,utilization.memory,temperature.gpu --format=csv,noheader,nounits; fi'
    const enriginCommand = [
      'if command -v ersmi >/dev/null 2>&1; then',
      'gyshell_ersmi(){ ersmi "$@" || { command -v sudo >/dev/null 2>&1 && sudo -n ersmi "$@"; }; };',
      `printf '%s\\n' '${ENRIGIN_GPU_QUERY_MARKER}';`,
      'gyshell_ersmi -q;',
      `printf '%s\\n' '${ENRIGIN_GPU_DMON_MARKER}';`,
      'gyshell_ersmi -dmon -c 1;',
      'fi',
    ].join(' ')

    return [nvidiaCommand, enriginCommand].join('; ')
  }

  private buildDarwinMonitorCommand(): string {
    return this.buildSectionedCommand([
      [
        'system',
        "hostname; (sw_vers -productName 2>/dev/null || echo macOS); (sw_vers -productVersion 2>/dev/null || uname -r); uname -m; printf '%s\\n' \"${SHELL:-/bin/zsh}\"",
      ],
      ['cpu', "top -l 2 -n 0 | grep -E '^CPU usage' | tail -n 1"],
      ['vmStat', 'vm_stat'],
      ['memorySysctl', 'sysctl -n hw.memsize hw.logicalcpu hw.physicalcpu machdep.cpu.brand_string'],
      ['swap', 'sysctl vm.swapusage'],
      ['disks', 'df -P -k'],
      ['diskList', 'diskutil list -plist | plutil -convert json -o - -'],
      ['diskApfs', 'diskutil apfs list -plist | plutil -convert json -o - -'],
      [
        'gpu',
        'if command -v nvidia-smi >/dev/null 2>&1; then nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total,utilization.memory,temperature.gpu --format=csv,noheader,nounits; fi',
      ],
      ['network', 'netstat -ibn'],
      ['load', 'sysctl -n vm.loadavg'],
      ['uptime', 'sysctl -n kern.boottime'],
      [
        'processes',
        `ps -Ao pid=,user=,state=,%cpu=,rss=,comm=,args= -r | sed -n '1,${MAX_TOP_PROCESSES}p'`,
      ],
      ['sockets', 'lsof -nP -iTCP -iUDP -FpcLfnPT || true'],
    ])
  }

  private buildWindowsMonitorScript(): string {
    return [
      "$ErrorActionPreference='SilentlyContinue'",
      '$utf8=[System.Text.UTF8Encoding]::new($false)',
      '[Console]::OutputEncoding=$utf8',
      '$OutputEncoding=$utf8',
      "function nd($v){$t=[string]$v;if(!$t -or $t -match '^(N/A|\\[.*\\])$'){return $null};try{return [double]$t}catch{return $null}}",
      "function gn($o,$ns){foreach($n in $ns){$p=$o.PSObject.Properties[$n];if($p -and $null -ne $p.Value){$v=nd $p.Value;if($null -ne $v){return $v}}};$null}",
      "function gk($n){if($n -match 'phys_(\\d+)'){return 'phys:'+ $Matches[1]};if($n -match 'luid_0x[0-9A-Fa-f]+_0x[0-9A-Fa-f]+'){return $Matches[0]};$null}",
      "function gpi($n){if($n -match 'phys_(\\d+)'){return [int]$Matches[1]};$null}",
      "function gek($n){if($n -match 'eng_(\\d+)'){return 'eng:'+ $Matches[1]};if($n -match 'engtype_([A-Za-z0-9_]+)'){return 'type:'+ $Matches[1]};$n}",
      '$o=gcim Win32_OperatingSystem',
      '$c=gcim Win32_PerfFormattedData_PerfOS_Processor',
      "$t=$c|? Name -eq '_Total'|select -f 1",
      "$r=@($c|?{$_.Name -match '^\\d+$'}|sort {[int]$_.Name}|%{[double]$_.PercentProcessorTime})",
      '$pn=@{};ps|%{$pn[[int]$_.Id]=$_.ProcessName}',
      "$pp=@{};gcim Win32_PerfFormattedData_PerfProc_Process|?{$_.IDProcess -gt 0 -and $_.Name -notin @('_Total','Idle')}|%{$pp[[int]$_.IDProcess]=[double]$_.PercentProcessorTime}",
      `$p=@(ps|%{[pscustomobject]@{i=[int]$_.Id;n=$_.ProcessName;c=$(if($pp.ContainsKey([int]$_.Id)){$pp[[int]$_.Id]}else{$null});m=[int64]$_.WorkingSet64}}|sort @{Expression={if($_.c -ne $null){$_.c}else{-1}};Descending=$true}|select -f ${MAX_TOP_PROCESSES})`,
      "$n=@(gcim Win32_PerfFormattedData_Tcpip_NetworkInterface|?{$_.Name -and $_.Name -notmatch 'Loopback|isatap|Teredo'}|%{[pscustomobject]@{i=$_.Name;r=[int64]$_.BytesReceivedPersec;t=[int64]$_.BytesSentPersec}})",
      "$d=@(gcim Win32_Volume|?{$_.DriveType -eq 3 -and [int64]$_.Capacity -gt 0}|%{$s=[int64]$_.Capacity;$f=[int64]$_.FreeSpace;$u=$s-$f;$m=$(if($_.DriveLetter){[string]$_.DriveLetter+'\\\\'}elseif($_.Name){[string]$_.Name}else{[string]$_.DeviceID});$g=$(if($_.Label){(([string]$_.FileSystem)+' · '+([string]$_.Label))}elseif($_.FileSystem){[string]$_.FileSystem}else{[string]$_.DeviceID});[pscustomobject]@{f=$g;m=$m;t=$s;u=$u;a=$f;p=$(if($s -gt 0){[math]::Round(($u/$s)*100,1)}else{0})}}|sort u -Descending)",
      '$k=@()',
      `if(gcm Get-NetTCPConnection -ea 0){$k+=@(Get-NetTCPConnection|%{[pscustomobject]@{p='tcp';s="$($_.State)";la="$($_.LocalAddress)";lp=[int]$_.LocalPort;ra="$($_.RemoteAddress)";rp=[int]$_.RemotePort;i=[int]$_.OwningProcess;n=$pn[[int]$_.OwningProcess]}})}`,
      `if(gcm Get-NetUDPEndpoint -ea 0){$k+=@(Get-NetUDPEndpoint|%{[pscustomobject]@{p='udp';s='LISTEN';la="$($_.LocalAddress)";lp=[int]$_.LocalPort;ra=$null;rp=$null;i=[int]$_.OwningProcess;n=$pn[[int]$_.OwningProcess]}})}`,
      '$mt=[int64]$o.TotalVisibleMemorySize*1024',
      '$mf=[int64]$o.FreePhysicalMemory*1024',
      '$st=[int64]$o.SizeStoredInPagingFiles*1024',
      '$sf=[int64]$o.FreeSpaceInPagingFiles*1024',
      "$vc=@(gcim Win32_VideoController|?{$_.Name -and $_.Name -notmatch 'Microsoft Basic|Remote Display'})",
      '$g=@()',
      '$ng=@()',
      "if(gcm nvidia-smi -ea 0){$ng=@((& nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total,utilization.memory,temperature.gpu --format=csv,noheader,nounits 2>$null)|?{$_ -and $_.Trim()}|%{$v=@($_.Split(',')|%{$_.Trim()});$u=$(if($v.Count -gt 1){nd $v[1]}else{$null});$m=$(if($v.Count -gt 2){nd $v[2]}else{$null});$tt=$(if($v.Count -gt 3){nd $v[3]}else{$null});if($v.Count -ge 4 -and $null -ne $u -and $null -ne $m -and $null -ne $tt){$mu=$(if($v.Count -gt 4){nd $v[4]}else{$null});$tc=$(if($v.Count -gt 5){nd $v[5]}else{$null});[pscustomobject]@{n=$v[0];u=$u;m=$m;t=$tt;p=$(if($tt -gt 0){[math]::Round(($m/$tt)*100,1)}else{$null});mu=$mu;tc=$tc}}})}",
      "$g=$(if($ng.Count -gt 0){$ng}else{$gx=@{};@(gcim Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine)|%{$nm=[string]$_.Name;$k=gk $nm;if($k){if(!$gx.ContainsKey($k)){$gx[$k]=[ordered]@{x=(gpi $nm);e=@{};m=$null;s=$null}};$ek=gek $nm;$u=gn $_ @('UtilizationPercentage');if($null -ne $u){$cur=$(if($gx[$k].e.ContainsKey($ek)){[double]$gx[$k].e[$ek]}else{0});$gx[$k].e[$ek]=[math]::Min(100,[math]::Round($cur+$u,1))}}};@(gcim Win32_PerfFormattedData_GPUPerformanceCounters_GPUAdapterMemory)|%{$nm=[string]$_.Name;$k=gk $nm;if($k){if(!$gx.ContainsKey($k)){$gx[$k]=[ordered]@{x=(gpi $nm);e=@{};m=$null;s=$null}};$du=gn $_ @('DedicatedUsage');$su=gn $_ @('SharedUsage');if($null -ne $du){$gx[$k].m=[math]::Round($du/1MB,1)};if($null -ne $su){$gx[$k].s=[math]::Round($su/1MB,1)}}};$gi=0;$gg=@(($gx.GetEnumerator()|sort {$_.Value.x})|%{$gi=$gi+1;$ix=$_.Value.x;$v=$(if($null -ne $ix -and $ix -lt $vc.Count){$vc[$ix]}elseif(($gi-1) -lt $vc.Count){$vc[$gi-1]}else{$null});$busy=0;foreach($q in $_.Value.e.Values){if([double]$q -gt $busy){$busy=[double]$q}};$tt=$(if($v -and [double]$v.AdapterRAM -gt 0){[math]::Round([double]$v.AdapterRAM/1MB,1)}else{$null});$mm=$_.Value.m;$pp=$(if($null -ne $mm -and $null -ne $tt -and $tt -gt 0){[math]::Round(($mm/$tt)*100,1)}else{$null});[pscustomobject]@{n=$(if($v -and $v.Name){[string]$v.Name}else{\"GPU $gi\"});u=[math]::Round($busy,1);m=$(if($null -ne $mm){$mm}else{0});t=$(if($null -ne $tt){$tt}else{0});p=$pp;s=$_.Value.s}});if($gg.Count -gt 0){$gg}else{$gi=0;@($vc|%{$gi=$gi+1;$tt=$(if([double]$_.AdapterRAM -gt 0){[math]::Round([double]$_.AdapterRAM/1MB,1)}else{0});[pscustomobject]@{n=[string]$_.Name;u=0;m=0;t=$tt;p=$null}})}})",
      "$j=[pscustomobject]@{s=[pscustomobject]@{h=$o.CSName;o='Windows';r=$o.Version;a=$(if([Environment]::Is64BitOperatingSystem){'x64'}else{'x86'});sh='powershell.exe'};c=[pscustomobject]@{u=[double]$t.PercentProcessorTime;c=$r;l=[Environment]::ProcessorCount};m=[pscustomobject]@{t=$mt;u=($mt-$mf);a=$mf;f=$mf;p=$(if($mt -gt 0){[math]::Round((($mt-$mf)/$mt)*100,1)}else{0});s=$(if($st -gt 0){[pscustomobject]@{t=$st;u=($st-$sf)}}else{$null})};d=$d;g=$g;n=$n;p=$p;k=$k;u=[int]((Get-Date)-$o.LastBootUpTime).TotalSeconds}",
      '$json=$j|ConvertTo-Json -Depth 6 -Compress',
      '$bytes=$utf8.GetBytes($json)',
      '[Console]::OpenStandardOutput().Write($bytes,0,$bytes.Length)',
    ].join(';')
  }

  private buildWindowsMonitorCommand(): string {
    return 'powershell.exe -NoLogo -NoProfile -NonInteractive -Command -'
  }

  private parseWindowsMonitorPayload(raw: string): any {
    try {
      return JSON.parse(raw)
    } catch (error) {
      const lines = raw
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
      const jsonLine = [...lines].reverse().find((line) => line.startsWith('{') && line.endsWith('}'))
      if (jsonLine) {
        return JSON.parse(jsonLine)
      }
      throw error
    }
  }

  private buildSectionedCommand(sections: Array<[string, string]>): string {
    return sections
      .map(
        ([name, command]) =>
          `printf '%s\\n' '${SECTION_MARKER}${name}'; { ${UNIX_MONITOR_LOCALE_EXPORT}; ${command}; } 2>/dev/null; printf '\\n'`
      )
      .join('; ')
  }

  private parseSectionedOutput(output: string): Map<string, string> {
    const sections = new Map<string, string>()
    let currentKey: string | null = null
    let buffer: string[] = []

    for (const line of output.split(/\r?\n/)) {
      if (line.startsWith(SECTION_MARKER)) {
        if (currentKey) {
          sections.set(currentKey, buffer.join('\n').trim())
        }
        currentKey = line.slice(SECTION_MARKER.length).trim()
        buffer = []
        continue
      }
      if (currentKey) {
        buffer.push(line)
      }
    }

    if (currentKey) {
      sections.set(currentKey, buffer.join('\n').trim())
    }

    return sections
  }

  private parseUnixSystemSection(section: string): Partial<ResourceSystemSnapshot> | undefined {
    if (!section) {
      return undefined
    }
    const lines = section
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
    if (lines.length === 0) {
      return undefined
    }

    const hostname = this.sanitizeTextField(lines[0])
    const osName = this.sanitizeTextField(lines[1])
    const release = this.sanitizeTextField(lines[2])
    const arch = this.sanitizeTextField(lines[3])
    const shell = this.sanitizeTextField(lines[4])

    if (!hostname && !osName && !release && !arch && !shell) {
      return undefined
    }

    return {
      ...(hostname ? { hostname } : {}),
      ...(osName ? { osName } : {}),
      ...(release ? { release } : {}),
      ...(arch ? { arch } : {}),
      ...(shell ? { shell } : {}),
    }
  }

  private calcCpuDeltaPercent(prev: CpuCounters, curr: CpuCounters): number {
    const prevTotal =
      prev.user +
      prev.nice +
      prev.system +
      prev.idle +
      prev.iowait +
      prev.irq +
      prev.softirq +
      prev.steal
    const currTotal =
      curr.user +
      curr.nice +
      curr.system +
      curr.idle +
      curr.iowait +
      curr.irq +
      curr.softirq +
      curr.steal
    const totalDelta = currTotal - prevTotal
    const idleDelta = curr.idle + curr.iowait - (prev.idle + prev.iowait)
    if (totalDelta <= 0) return 0
    return ((totalDelta - idleDelta) / totalDelta) * 100
  }

  private parseProcStatForCpu(
    procStat: string,
    session?: MonitorSession
  ): CpuSnapshot | undefined {
    if (!procStat) return undefined

    const counters: CpuCounters[] = []
    for (const line of procStat.split('\n')) {
      const match = line.match(
        /^cpu(\d*)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*(\d*)/
      )
      if (!match) continue
      counters.push({
        user: parseInt(match[2], 10),
        nice: parseInt(match[3], 10),
        system: parseInt(match[4], 10),
        idle: parseInt(match[5], 10),
        iowait: parseInt(match[6], 10),
        irq: parseInt(match[7], 10),
        softirq: parseInt(match[8], 10),
        steal: match[9] ? parseInt(match[9], 10) : 0,
      })
    }

    if (counters.length === 0) return undefined

    const aggregate = counters[0]
    const cores = counters.slice(1)

    let usagePercent = 0
    let userPercent = 0
    let systemPercent = 0
    let idlePercent = 0
    let corePercents: number[] | undefined

    if (session?.previousCpuCounters && session.previousCpuCounters.length === counters.length) {
      const prevAggregate = session.previousCpuCounters[0]
      const prevTotal =
        prevAggregate.user +
        prevAggregate.nice +
        prevAggregate.system +
        prevAggregate.idle +
        prevAggregate.iowait +
        prevAggregate.irq +
        prevAggregate.softirq +
        prevAggregate.steal
      const currTotal =
        aggregate.user +
        aggregate.nice +
        aggregate.system +
        aggregate.idle +
        aggregate.iowait +
        aggregate.irq +
        aggregate.softirq +
        aggregate.steal
      const totalDelta = currTotal - prevTotal
      if (totalDelta > 0) {
        userPercent = (((aggregate.user + aggregate.nice) - (prevAggregate.user + prevAggregate.nice)) / totalDelta) * 100
        systemPercent = (((aggregate.system + aggregate.irq + aggregate.softirq) - (prevAggregate.system + prevAggregate.irq + prevAggregate.softirq)) / totalDelta) * 100
        idlePercent = (((aggregate.idle + aggregate.iowait) - (prevAggregate.idle + prevAggregate.iowait)) / totalDelta) * 100
      }
      usagePercent = this.calcCpuDeltaPercent(prevAggregate, aggregate)
      corePercents = cores.map((curr, index) =>
        this.calcCpuDeltaPercent(session.previousCpuCounters![index + 1], curr)
      )
    } else {
      const total =
        aggregate.user +
        aggregate.nice +
        aggregate.system +
        aggregate.idle +
        aggregate.iowait +
        aggregate.irq +
        aggregate.softirq +
        aggregate.steal
      if (total > 0) {
        userPercent = ((aggregate.user + aggregate.nice) / total) * 100
        systemPercent = ((aggregate.system + aggregate.irq + aggregate.softirq) / total) * 100
        idlePercent = ((aggregate.idle + aggregate.iowait) / total) * 100
      }
      usagePercent = 100 - idlePercent
      corePercents = cores.map((cpu) => {
        const coreTotal =
          cpu.user +
          cpu.nice +
          cpu.system +
          cpu.idle +
          cpu.iowait +
          cpu.irq +
          cpu.softirq +
          cpu.steal
        const coreIdle = cpu.idle + cpu.iowait
        return coreTotal > 0 ? ((coreTotal - coreIdle) / coreTotal) * 100 : 0
      })
    }

    if (session) {
      session.previousCpuCounters = counters
    }

    return {
      usagePercent: this.roundToTenth(usagePercent),
      corePercents: corePercents?.map((value) => this.roundToTenth(value)),
      logicalCoreCount: cores.length > 0 ? cores.length : undefined,
      userPercent: this.roundToTenth(userPercent),
      systemPercent: this.roundToTenth(systemPercent),
      idlePercent: this.roundToTenth(idlePercent),
    }
  }

  private parseLinuxMeminfo(meminfo: string): MemorySnapshot | undefined {
    if (!meminfo) return undefined

    const getValue = (key: string): number | undefined => {
      const match = meminfo.match(new RegExp(`^${key}:\\s+(\\d+)`, 'm'))
      return match ? parseInt(match[1], 10) * 1024 : undefined
    }

    const totalBytes = getValue('MemTotal')
    const freeBytes = getValue('MemFree')
    const availableBytes = getValue('MemAvailable') ?? freeBytes
    if (totalBytes === undefined || availableBytes === undefined) {
      return undefined
    }

    const cachedBytes =
      (getValue('Cached') || 0) + (getValue('Buffers') || 0) + (getValue('SReclaimable') || 0)
    const usedBytes = Math.max(0, totalBytes - availableBytes)
    const swapTotal = getValue('SwapTotal')
    const swapFree = getValue('SwapFree')

    return {
      totalBytes,
      usedBytes,
      availableBytes,
      freeBytes,
      cachedBytes: cachedBytes > 0 ? cachedBytes : undefined,
      usagePercent: this.percent(usedBytes, totalBytes),
      swap:
        swapTotal !== undefined && swapFree !== undefined && swapTotal > 0
          ? {
              totalBytes: swapTotal,
              usedBytes: Math.max(0, swapTotal - swapFree),
            }
          : undefined,
    }
  }

  private parseDfOutput(dfOutput: string): DiskSnapshot[] {
    return this.parseDfEntries(dfOutput)
      .filter(
        (entry) =>
          !entry.filesystem.startsWith('tmpfs') &&
          !entry.filesystem.startsWith('devtmpfs') &&
          entry.filesystem !== 'none' &&
          entry.filesystem !== 'overlay'
      )
      .map((entry) => ({
        filesystem: entry.filesystem,
        mountPoint: entry.mountPoint,
        totalBytes: entry.totalBytes,
        usedBytes: entry.usedBytes,
        availableBytes: entry.availableBytes,
        usagePercent: entry.usagePercent,
      }))
      .sort((left, right) => right.usedBytes - left.usedBytes)
  }

  private parseDfEntries(dfOutput: string): ParsedDfEntry[] {
    if (!dfOutput) return []

    return dfOutput
      .split('\n')
      .slice(1)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .flatMap((line) => {
        const parts = line.split(/\s+/)
        if (parts.length < 6) return []
        const totalKB = parseInt(parts[1], 10)
        const usedKB = parseInt(parts[2], 10)
        const availKB = parseInt(parts[3], 10)
        if (!Number.isFinite(totalKB) || totalKB <= 0) {
          return []
        }
        return [
          {
            filesystem: parts[0],
            mountPoint: parts.slice(5).join(' '),
            totalBytes: totalKB * 1024,
            usedBytes: usedKB * 1024,
            availableBytes: availKB * 1024,
            usagePercent: this.percent(usedKB, totalKB),
          },
        ]
      })
  }

  private parseDarwinDisks(
    dfOutput: string,
    diskListJson: string,
    diskApfsJson: string
  ): DiskSnapshot[] {
    const entries = this.parseDfEntries(dfOutput)
    if (entries.length === 0) return []

    const metadataByDevice = this.parseDarwinDiskMetadata(diskListJson, diskApfsJson)
    const hiddenRoles = new Set(['Preboot', 'Recovery', 'VM', 'Update', 'Hardware', 'xART'])

    return entries
      .flatMap((entry) => {
        if (!entry.filesystem.startsWith('/dev/disk')) {
          return []
        }

        const deviceIdentifier = entry.filesystem.replace(/^\/dev\//, '')
        const metadata = metadataByDevice.get(deviceIdentifier)
        const roles = metadata?.roles || []
        const mountPoint = metadata?.mountPoint || entry.mountPoint
        const containerReference = metadata?.containerReference
        const containerHasDataVolume = containerReference
          ? Array.from(metadataByDevice.values()).some(
              (candidate) =>
                candidate.containerReference === containerReference &&
                (candidate.roles || []).includes('Data')
            )
          : false

        if (roles.some((role) => hiddenRoles.has(role))) {
          return []
        }
        if (roles.includes('System') && containerHasDataVolume) {
          return []
        }
        if (
          mountPoint === '/' &&
          containerHasDataVolume &&
          !(roles.includes('Data') || roles.includes('System'))
        ) {
          return []
        }
        if (mountPoint.startsWith('/System/Volumes/') && !roles.includes('Data')) {
          return []
        }

        return [
          {
            filesystem:
              metadata?.volumeName || metadata?.content || entry.filesystem.replace(/^\/dev\//, ''),
            mountPoint,
            totalBytes: entry.totalBytes,
            usedBytes: entry.usedBytes,
            availableBytes: entry.availableBytes,
            usagePercent: entry.usagePercent,
          },
        ]
      })
      .sort((left, right) => right.usedBytes - left.usedBytes)
  }

  private parseDarwinDiskMetadata(
    diskListJson: string,
    diskApfsJson: string
  ): Map<string, DarwinDiskMetadata> {
    const metadataByDevice = new Map<string, DarwinDiskMetadata>()
    const listPayload = this.parseJsonObject(diskListJson)
    const apfsPayload = this.parseJsonObject(diskApfsJson)

    const upsertMetadata = (next: Partial<DarwinDiskMetadata> & { deviceIdentifier: string }) => {
      const current = metadataByDevice.get(next.deviceIdentifier) || {
        deviceIdentifier: next.deviceIdentifier,
      }
      metadataByDevice.set(next.deviceIdentifier, {
        ...current,
        ...next,
      })
    }

    const visitDiskListNode = (node: any, inherited?: Partial<DarwinDiskMetadata>) => {
      if (!node || typeof node !== 'object') {
        return
      }

      const inheritedFields: Partial<DarwinDiskMetadata> = inherited
        ? {
            containerReference: inherited.containerReference,
            osInternal: inherited.osInternal,
          }
        : {}

      if (typeof node.DeviceIdentifier === 'string') {
        upsertMetadata({
          deviceIdentifier: node.DeviceIdentifier,
          ...inheritedFields,
          mountPoint: typeof node.MountPoint === 'string' ? node.MountPoint : undefined,
          volumeName: typeof node.VolumeName === 'string' ? node.VolumeName : undefined,
          content: typeof node.Content === 'string' ? node.Content : undefined,
          osInternal:
            typeof node.OSInternal === 'boolean' ? node.OSInternal : inheritedFields.osInternal,
          containerReference:
            typeof inheritedFields.containerReference === 'string'
              ? inheritedFields.containerReference
              : undefined,
        })
      }

      const childInherited =
        typeof node.DeviceIdentifier === 'string' && String(node.Content || '').includes('APFS_Container')
          ? {
              containerReference: node.DeviceIdentifier,
              osInternal:
                typeof node.OSInternal === 'boolean' ? node.OSInternal : inheritedFields.osInternal,
            }
          : inheritedFields

      ;['Partitions', 'APFSVolumes', 'AllDisksAndPartitions'].forEach((key) => {
        const children = (node as Record<string, unknown>)[key]
        if (Array.isArray(children)) {
          children.forEach((child) => visitDiskListNode(child, childInherited))
        }
      })
    }

    visitDiskListNode(listPayload)

    const containers = Array.isArray(apfsPayload?.Containers) ? apfsPayload.Containers : []
    containers.forEach((container: any) => {
      const containerReference =
        typeof container?.ContainerReference === 'string' ? container.ContainerReference : undefined
      const volumes = Array.isArray(container?.Volumes) ? container.Volumes : []
      volumes.forEach((volume: any) => {
        if (typeof volume?.DeviceIdentifier !== 'string') {
          return
        }
        upsertMetadata({
          deviceIdentifier: volume.DeviceIdentifier,
          containerReference,
          volumeName: typeof volume?.Name === 'string' ? volume.Name : undefined,
          roles: Array.isArray(volume?.Roles)
            ? volume.Roles.filter((role: unknown): role is string => typeof role === 'string')
            : undefined,
        })
      })
    })

    return metadataByDevice
  }

  private parseJsonObject(raw: string): any {
    if (!raw) return null
    try {
      return JSON.parse(raw)
    } catch {
      return null
    }
  }

  private parseLinuxGpuOutput(output: string): GpuSnapshot[] {
    return [
      ...this.parseNvidiaSmiOutput(output),
      ...this.parseErsmiGpuOutput(output),
    ]
  }

  private parseNvidiaSmiOutput(output: string): GpuSnapshot[] {
    if (!output || output.trim().length === 0) return []

    const entries: GpuSnapshot[] = []
    for (const line of output.trim().split('\n')) {
      const parts = line.split(',').map((part) => part.trim())
      if (parts.length < 4) continue
      const util = this.asNumber(parts[1])
      const memUsed = this.asNumber(parts[2])
      const memTotal = this.asNumber(parts[3])
      const memoryUtilization =
        parts.length > 4 ? this.asNumber(parts[4]) : undefined
      const temperatureIndex = parts.length > 5 ? 5 : 4
      const temperature =
        parts.length > temperatureIndex ? this.asNumber(parts[temperatureIndex]) : undefined
      if (util === undefined || memUsed === undefined || memTotal === undefined) {
        continue
      }
      entries.push({
        name: parts[0] || undefined,
        utilizationPercent: util,
        memoryUsedMiB: memUsed,
        memoryTotalMiB: memTotal,
        memoryUsagePercent: memTotal > 0 ? this.percent(memUsed, memTotal) : undefined,
        memoryUtilizationPercent: memoryUtilization,
        temperatureC:
          temperature !== undefined && !Number.isNaN(temperature) ? temperature : undefined,
      })
    }
    return entries
  }

  private parseErsmiGpuOutput(output: string): GpuSnapshot[] {
    if (!output || output.trim().length === 0) return []

    const queryRegion = this.sliceErsmiRegion(
      output,
      ENRIGIN_GPU_QUERY_MARKER,
      ENRIGIN_GPU_DMON_MARKER
    )
    const dmonRegion = this.sliceErsmiRegion(output, ENRIGIN_GPU_DMON_MARKER)
    const queryInfo = this.parseErsmiQueryInfo(queryRegion)
    const dmonInfo = this.parseErsmiDmonInfo(dmonRegion)
    const indices = new Set<number>([...queryInfo.keys(), ...dmonInfo.keys()])

    return Array.from(indices)
      .sort((left, right) => left - right)
      .map((index) => {
        const query = queryInfo.get(index)
        const dmon = dmonInfo.get(index)
        const memoryTotalMiB = dmon?.memoryTotalMiB ?? query?.memoryTotalMiB ?? 0
        const memoryUsagePercent =
          dmon?.memoryUsagePercent ??
          (query?.memoryUsedMiB !== undefined && memoryTotalMiB > 0
            ? this.percent(query.memoryUsedMiB, memoryTotalMiB)
            : undefined)
        // ERSMI reports VRAM as a usage percentage of the total, so derive the
        // used MiB as `percent × total` (identical to the vendor `ersmi` tool),
        // falling back to the absolute figure from the `-q` query when present.
        const memoryUsedMiB =
          memoryUsagePercent !== undefined && memoryTotalMiB > 0
            ? this.roundToTenth((memoryTotalMiB * memoryUsagePercent) / 100)
            : query?.memoryUsedMiB ?? 0

        return {
          name: query?.name || `Enrigin ECU ${index}`,
          utilizationPercent:
            dmon?.utilizationPercent ?? dmon?.sipUtilizationPercent ?? 0,
          memoryUsedMiB,
          memoryTotalMiB,
          memoryUsagePercent,
          temperatureC: dmon?.temperatureC ?? query?.temperatureC,
          powerUsageWatts: dmon?.powerUsageWatts ?? query?.powerUsageWatts,
          powerLimitWatts: query?.powerLimitWatts,
          powerState: query?.powerState,
          memoryClockMHz: dmon?.memoryClockMHz ?? query?.memoryClockMHz,
        }
      })
  }

  // Isolate the text emitted between two ERSMI section markers so the `-q` and
  // `--dmon` outputs are parsed independently instead of scanning the combined
  // blob. Returns '' when the start marker is absent (e.g. ERSMI not installed).
  private sliceErsmiRegion(
    output: string,
    startMarker: string,
    endMarker?: string
  ): string {
    const startIndex = output.indexOf(startMarker)
    if (startIndex === -1) return ''
    const regionStart = startIndex + startMarker.length
    const regionEnd = endMarker ? output.indexOf(endMarker, regionStart) : -1
    return regionEnd === -1
      ? output.slice(regionStart)
      : output.slice(regionStart, regionEnd)
  }

  private parseErsmiQueryInfo(output: string): Map<number, EnriginEcuQueryInfo> {
    const entries = new Map<number, EnriginEcuQueryInfo>()
    const blockPattern = /(?:^|\n)\s*DEV\s+ID\s+(\d+)([\s\S]*?)(?=\n\s*DEV\s+ID\s+\d+|\s*$)/g
    let match: RegExpExecArray | null

    while ((match = blockPattern.exec(output)) !== null) {
      const index = parseInt(match[1], 10)
      if (!Number.isFinite(index)) continue
      const block = match[2] || ''
      const entry: EnriginEcuQueryInfo = { index }

      const name = this.extractErsmiLabeledValue(block, 'Dev Name')
      if (name) entry.name = name

      const memoryTotalMiB = this.parseErsmiMemoryMiB(
        this.extractErsmiLabeledValue(block, 'Mem Size')
      )
      if (memoryTotalMiB !== undefined) entry.memoryTotalMiB = memoryTotalMiB

      const memoryUsedMiB = this.parseErsmiMemoryMiB(
        this.extractErsmiLabeledValue(block, 'Mem Usage')
      )
      if (memoryUsedMiB !== undefined) entry.memoryUsedMiB = memoryUsedMiB

      const temperatureC = this.parseErsmiNumber(
        this.extractErsmiLabeledValue(block, 'ECU Temp')
      )
      if (temperatureC !== undefined) entry.temperatureC = temperatureC

      const powerUsageWatts = this.parseErsmiNumber(
        this.extractErsmiLabeledValue(block, 'Cur Power')
      )
      if (powerUsageWatts !== undefined) entry.powerUsageWatts = powerUsageWatts

      const powerLimitWatts = this.parseErsmiNumber(
        this.extractErsmiLabeledValue(block, 'En Power Capa') ??
          this.extractErsmiLabeledValue(block, 'Power Capa')
      )
      if (powerLimitWatts !== undefined) entry.powerLimitWatts = powerLimitWatts

      const powerState = this.extractErsmiLabeledValue(block, 'Dpm Level')
      if (powerState) entry.powerState = powerState

      const memoryClockMHz = this.parseErsmiNumber(
        this.extractErsmiLabeledValue(block, 'Mem CLK')
      )
      if (memoryClockMHz !== undefined) entry.memoryClockMHz = memoryClockMHz

      entries.set(index, entry)
    }

    return entries
  }

  // `ersmi -dmon -c 1` prints a fixed-width table whose data rows start with the
  // numeric device index and expose 12 columns. Column meaning (0-indexed),
  // matching the vendor tool:
  //   [0] idx  [1] power(W)  [2] temp(C)  [3] SIP util(%)  [7] VRAM used(%)
  //   [8] VRAM total(MiB)    [10] memory clock(MHz)
  // Header/unit rows (prefixed with # or *, or with a non-numeric first token)
  // are naturally skipped by the index/column-count guard.
  private parseErsmiDmonInfo(output: string): Map<number, EnriginEcuDmonInfo> {
    const entries = new Map<number, EnriginEcuDmonInfo>()

    for (const line of output.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue

      const parts = trimmed.split(/\s+/)
      if (parts.length < 12 || !/^\d+$/.test(parts[0] || '')) {
        continue
      }

      const index = this.asNumber(parts[0])
      if (index === undefined) continue

      const entry: EnriginEcuDmonInfo = { index }

      const powerUsageWatts = this.parseErsmiNumber(parts[1])
      if (powerUsageWatts !== undefined) entry.powerUsageWatts = powerUsageWatts

      const temperatureC = this.parseErsmiNumber(parts[2])
      if (temperatureC !== undefined) entry.temperatureC = temperatureC

      const sipUtilizationPercent = this.parseErsmiNumber(parts[3])
      if (sipUtilizationPercent !== undefined) {
        entry.sipUtilizationPercent = sipUtilizationPercent
        entry.utilizationPercent = sipUtilizationPercent
      }

      const memoryUsagePercent = this.parseErsmiNumber(parts[7])
      if (memoryUsagePercent !== undefined) {
        entry.memoryUsagePercent = memoryUsagePercent
      }

      const memoryTotalMiB = this.parseErsmiMemoryMiB(parts[8])
      if (memoryTotalMiB !== undefined) entry.memoryTotalMiB = memoryTotalMiB

      const memoryClockMHz = this.parseErsmiNumber(parts[10])
      if (memoryClockMHz !== undefined) {
        entry.memoryClockMHz = memoryClockMHz
      }

      entries.set(index, entry)
    }

    return entries
  }

  private extractErsmiLabeledValue(block: string, label: string): string | undefined {
    const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const match = block.match(new RegExp(`^\\s*${escapedLabel}\\s*:\\s*(.+?)\\s*$`, 'im'))
    return match ? this.sanitizeTextField(match[1]) : undefined
  }

  private parseErsmiMemoryMiB(value: string | undefined): number | undefined {
    const match = String(value || '').match(/([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)\s*([kmgt]?i?b|[kmgt]b)?/i)
    if (!match) return undefined
    const amount = Number(match[1])
    if (!Number.isFinite(amount)) return undefined
    const unit = (match[2] || 'mib').toLowerCase()
    if (unit.startsWith('k')) return this.roundToTenth(amount / 1024)
    if (unit.startsWith('g')) return this.roundToTenth(amount * 1024)
    if (unit.startsWith('t')) return this.roundToTenth(amount * 1024 * 1024)
    return this.roundToTenth(amount)
  }

  private parseErsmiNumber(value: string | undefined): number | undefined {
    const match = String(value || '').match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/i)
    if (!match) return undefined
    const parsed = Number(match[0])
    return Number.isFinite(parsed) ? this.roundToTenth(parsed) : undefined
  }

  private parseLinuxNetDevOutput(
    output: string,
    session?: MonitorSession
  ): NetworkSnapshot[] {
    if (!output) return []

    const currentCounters: NetCounters = {}
    const results: NetworkSnapshot[] = []

    for (const line of output.split('\n').slice(2)) {
      const match = line.match(
        /^\s*([^:]+):\s*(\d+)\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+(\d+)/
      )
      if (!match) continue

      const iface = match[1].trim()
      if (iface === 'lo') continue

      const rxBytes = parseInt(match[2], 10)
      const txBytes = parseInt(match[3], 10)
      currentCounters[iface] = { rxBytes, txBytes }

      const previous = session?.previousNetCounters?.[iface]
      const elapsedSeconds =
        session?.previousSampleTime !== undefined
          ? Math.max(0.001, (Date.now() - session.previousSampleTime) / 1000)
          : undefined

      results.push({
        interface: iface,
        rxBytesPerSec:
          previous && elapsedSeconds
            ? Math.max(0, Math.round((rxBytes - previous.rxBytes) / elapsedSeconds))
            : 0,
        txBytesPerSec:
          previous && elapsedSeconds
            ? Math.max(0, Math.round((txBytes - previous.txBytes) / elapsedSeconds))
            : 0,
      })
    }

    if (session) {
      session.previousNetCounters = currentCounters
    }

    return results.sort(
      (left, right) =>
        right.rxBytesPerSec + right.txBytesPerSec - (left.rxBytesPerSec + left.txBytesPerSec)
    )
  }

  private parseUnixProcessOutput(output: string): ProcessSnapshot[] {
    if (!output) return []

    const entries: ProcessSnapshot[] = []
    for (const line of output.split('\n')) {
      const match = line.match(
        /^\s*(\d+)\s+(\S+)\s+(\S+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s*(.*)$/
      )
      if (!match) continue

      const pid = parseInt(match[1], 10)
      const user = match[2]
      const state = match[3]
      const cpuPercent = parseFloat(match[4])
      const rssKb = parseInt(match[5], 10)
      const name = match[6]
      const command = match[7]?.trim() || name

      entries.push({
        pid,
        user,
        state,
        name,
        cpuPercent: Number.isNaN(cpuPercent) ? undefined : this.roundToTenth(cpuPercent),
        memoryBytes: Number.isFinite(rssKb) ? rssKb * 1024 : undefined,
        command,
        path: this.extractExecutablePath(command),
      })
    }
    return entries
  }

  private parseLinuxSocketEntries(output: string): RawSocketEntry[] {
    if (!output) return []
    if (output.includes('Proto ') || output.startsWith('Active Internet connections')) {
      return this.parseUnixNetstatSocketOutput(output)
    }
    return this.parseLinuxSsSocketOutput(output)
  }

  private parseLinuxSsSocketOutput(output: string): RawSocketEntry[] {
    const entries: RawSocketEntry[] = []

    for (const line of output.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      const parts = trimmed.split(/\s+/)
      if (parts.length < 6) continue

      const protocol = this.normalizeProtocol(parts[0])
      const state = parts[1]
      const local = this.parseSocketAddress(parts[4])
      const remote = this.parseSocketAddress(parts[5])
      const trailing = parts.slice(6).join(' ')
      const owner = this.parseSsOwner(trailing)

      entries.push({
        protocol,
        state,
        localAddress: local.address,
        localPort: local.port,
        remoteAddress: remote.address,
        remotePort: remote.port,
        pid: owner.pid,
        processName: owner.processName,
      })
    }

    return entries
  }

  private parseUnixNetstatSocketOutput(output: string): RawSocketEntry[] {
    const entries: RawSocketEntry[] = []

    for (const line of output.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('Proto') || trimmed.startsWith('Active ')) continue
      const parts = trimmed.split(/\s+/)
      if (parts.length < 5) continue

      const protocol = this.normalizeProtocol(parts[0])
      const local = this.parseSocketAddress(parts[3])
      const remote = this.parseSocketAddress(parts[4])
      const state = protocol === 'udp' ? 'LISTEN' : parts[5]
      const ownerToken = parts[protocol === 'udp' ? 5 : 6]
      const owner = this.parseNetstatOwner(ownerToken)

      entries.push({
        protocol,
        state,
        localAddress: local.address,
        localPort: local.port,
        remoteAddress: remote.address,
        remotePort: remote.port,
        pid: owner.pid,
        processName: owner.processName,
      })
    }

    return entries
  }

  private parseDarwinMemorySysctl(output: string): {
    totalBytes?: number
    logicalCoreCount?: number
    modelName?: string
  } {
    const lines = output
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
    return {
      totalBytes: lines[0] ? parseInt(lines[0], 10) : undefined,
      logicalCoreCount: lines[1] ? parseInt(lines[1], 10) : undefined,
      modelName: lines[3] || undefined,
    }
  }

  private parseDarwinCpu(
    output: string,
    logicalCoreCount?: number,
    modelName?: string
  ): CpuSnapshot | undefined {
    const line = output
      .split('\n')
      .map((entry) => entry.trim())
      .find((entry) => entry.startsWith('CPU usage'))
    if (!line) return undefined

    const user = this.parseLabeledPercent(line, 'user')
    const system = this.parseLabeledPercent(line, 'sys')
    const idle = this.parseLabeledPercent(line, 'idle')
    const usagePercent =
      idle !== undefined ? Math.max(0, this.roundToTenth(100 - idle)) : undefined

    if (usagePercent === undefined) return undefined

    return {
      usagePercent,
      logicalCoreCount,
      modelName,
      userPercent: user,
      systemPercent: system,
      idlePercent: idle,
    }
  }

  private parseDarwinMemory(
    vmStatOutput: string,
    totalBytes?: number,
    swapOutput?: string
  ): MemorySnapshot | undefined {
    if (!vmStatOutput || totalBytes === undefined || !Number.isFinite(totalBytes)) {
      return undefined
    }

    const pageSizeMatch = vmStatOutput.match(/page size of (\d+) bytes/i)
    const pageSize = pageSizeMatch ? parseInt(pageSizeMatch[1], 10) : 4096
    const pages = (name: string): number => {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const match = vmStatOutput.match(new RegExp(`^${escaped}:\\s+(\\d+)`, 'm'))
      return match ? parseInt(match[1], 10) : 0
    }

    const freeBytes = pages('Pages free') * pageSize
    const inactiveBytes = pages('Pages inactive') * pageSize
    const speculativeBytes = pages('Pages speculative') * pageSize
    const wiredBytes = pages('Pages wired down') * pageSize
    const compressedBytes = pages('Pages occupied by compressor') * pageSize
    const cachedBytes = inactiveBytes + speculativeBytes
    const availableBytes = freeBytes + inactiveBytes + speculativeBytes
    const usedBytes = Math.max(0, totalBytes - availableBytes)
    const swap = this.parseDarwinSwap(swapOutput || '')

    return {
      totalBytes,
      usedBytes,
      availableBytes,
      freeBytes,
      cachedBytes,
      wiredBytes: wiredBytes > 0 ? wiredBytes : undefined,
      compressedBytes: compressedBytes > 0 ? compressedBytes : undefined,
      usagePercent: this.percent(usedBytes, totalBytes),
      swap,
    }
  }

  private parseDarwinSwap(output: string): MemorySnapshot['swap'] | undefined {
    const totalMatch = output.match(/total\s*=\s*([\d.]+[KMGTP]?)/i)
    const usedMatch = output.match(/used\s*=\s*([\d.]+[KMGTP]?)/i)
    const totalBytes = totalMatch ? this.parseHumanBytes(totalMatch[1]) : undefined
    const usedBytes = usedMatch ? this.parseHumanBytes(usedMatch[1]) : undefined
    if (
      totalBytes === undefined ||
      usedBytes === undefined ||
      !Number.isFinite(totalBytes) ||
      totalBytes <= 0
    ) {
      return undefined
    }
    return {
      totalBytes,
      usedBytes,
    }
  }

  private parseDarwinNetstatInterfaces(
    output: string,
    session?: MonitorSession
  ): NetworkSnapshot[] {
    if (!output) return []

    const currentCounters: NetCounters = {}
    const rows: NetworkSnapshot[] = []

    for (const line of output.split('\n').slice(1)) {
      const trimmed = line.trim()
      if (!trimmed) continue
      const parts = trimmed.split(/\s+/)
      if (parts.length < 10) continue

      const rawName = parts[0].replace(/\*$/, '')
      const network = parts[2]
      if (!network.startsWith('<Link#') || rawName === 'lo0') continue

      const tail = parts.slice(3)
      if (tail.length < 7) continue

      const rxBytes = parseInt(tail[tail.length - 5], 10)
      const txBytes = parseInt(tail[tail.length - 2], 10)
      if (!Number.isFinite(rxBytes) || !Number.isFinite(txBytes)) continue

      currentCounters[rawName] = { rxBytes, txBytes }
      const previous = session?.previousNetCounters?.[rawName]
      const elapsedSeconds =
        session?.previousSampleTime !== undefined
          ? Math.max(0.001, (Date.now() - session.previousSampleTime) / 1000)
          : undefined

      rows.push({
        interface: rawName,
        rxBytesPerSec:
          previous && elapsedSeconds
            ? Math.max(0, Math.round((rxBytes - previous.rxBytes) / elapsedSeconds))
            : 0,
        txBytesPerSec:
          previous && elapsedSeconds
            ? Math.max(0, Math.round((txBytes - previous.txBytes) / elapsedSeconds))
            : 0,
      })
    }

    if (session) {
      session.previousNetCounters = currentCounters
    }

    return rows.sort(
      (left, right) =>
        right.rxBytesPerSec + right.txBytesPerSec - (left.rxBytesPerSec + left.txBytesPerSec)
    )
  }

  private parseMacLsofOutput(output: string): RawSocketEntry[] {
    if (!output) return []

    const entries: RawSocketEntry[] = []
    let currentPid: number | undefined
    let currentProcessName: string | undefined
    let currentUser: string | undefined
    let currentEntry: Partial<RawSocketEntry> | null = null

    const flushCurrent = () => {
      if (!currentEntry?.protocol || !currentEntry.localAddress) return
      entries.push({
        protocol: currentEntry.protocol,
        state: currentEntry.state,
        localAddress: currentEntry.localAddress,
        localPort: currentEntry.localPort,
        remoteAddress: currentEntry.remoteAddress,
        remotePort: currentEntry.remotePort,
        pid: currentPid,
        processName: currentProcessName,
        user: currentUser,
      })
    }

    for (const line of output.split('\n')) {
      if (!line) continue
      const tag = line[0]
      const value = line.slice(1)

      if (tag === 'p') {
        flushCurrent()
        currentEntry = null
        currentPid = parseInt(value, 10)
        currentProcessName = undefined
        currentUser = undefined
        continue
      }
      if (tag === 'c') {
        currentProcessName = value || undefined
        continue
      }
      if (tag === 'L') {
        currentUser = value || undefined
        continue
      }
      if (tag === 'f') {
        flushCurrent()
        currentEntry = {}
        continue
      }
      if (!currentEntry) continue

      if (tag === 'P') {
        currentEntry.protocol = this.normalizeProtocol(value)
        continue
      }
      if (tag === 'n') {
        const parsed = this.parseLsofAddress(value)
        currentEntry.localAddress = parsed.localAddress
        currentEntry.localPort = parsed.localPort
        currentEntry.remoteAddress = parsed.remoteAddress
        currentEntry.remotePort = parsed.remotePort
        continue
      }
      if (tag === 'T' && value.startsWith('ST=')) {
        currentEntry.state = value.slice(3)
      }
    }

    flushCurrent()
    return entries
  }

  private parseDarwinLoadAvg(output: string): [number, number, number] | undefined {
    if (!output) return undefined
    const matches = output.match(/[-+]?\d*\.?\d+/g)
    if (!matches || matches.length < 3) return undefined
    const values = matches.slice(0, 3).map((entry) => parseFloat(entry))
    if (values.some((value) => Number.isNaN(value))) return undefined
    return values as [number, number, number]
  }

  private parseDarwinBootTime(output: string): number | undefined {
    const match = output.match(/sec\s*=\s*(\d+)/)
    if (!match) return undefined
    const bootSeconds = parseInt(match[1], 10)
    return Number.isFinite(bootSeconds)
      ? Math.max(0, Math.floor(Date.now() / 1000) - bootSeconds)
      : undefined
  }

  private parseLoadAvg(output: string): [number, number, number] | undefined {
    if (!output) return undefined
    const parts = output.trim().split(/\s+/).slice(0, 3).map(Number)
    if (parts.length < 3 || parts.some((value) => Number.isNaN(value))) {
      return undefined
    }
    return parts as [number, number, number]
  }

  private parseUptime(output: string): number | undefined {
    if (!output) return undefined
    const match = output.match(/^([\d.]+)/)
    return match ? parseFloat(match[1]) : undefined
  }

  private parseLabeledPercent(line: string, label: string): number | undefined {
    const match = line.match(new RegExp(`([\\d.]+)%\\s+${label}`, 'i'))
    if (!match) return undefined
    const value = parseFloat(match[1])
    return Number.isNaN(value) ? undefined : this.roundToTenth(value)
  }

  private parseHumanBytes(value: string): number | undefined {
    const match = String(value || '').trim().match(/^([\d.]+)\s*([KMGTP]?)/i)
    if (!match) return undefined
    const amount = parseFloat(match[1])
    const unit = match[2].toUpperCase()
    if (!Number.isFinite(amount)) return undefined
    const multipliers: Record<string, number> = {
      '': 1,
      K: 1024,
      M: 1024 ** 2,
      G: 1024 ** 3,
      T: 1024 ** 4,
      P: 1024 ** 5,
    }
    return Math.round(amount * (multipliers[unit] || 1))
  }

  private parseSocketAddress(value: string): { address: string; port?: number } {
    const normalized = String(value || '').trim()
    if (!normalized) {
      return { address: '*' }
    }
    if (normalized === '*:*' || normalized === '*') {
      return { address: '*' }
    }

    if (normalized.startsWith('[')) {
      const idx = normalized.lastIndexOf(']:')
      if (idx >= 0) {
        const port = this.parsePortToken(normalized.slice(idx + 2))
        return {
          address: normalized.slice(1, idx),
          port,
        }
      }
      return { address: normalized.replace(/^\[|\]$/g, '') }
    }

    const lastColon = normalized.lastIndexOf(':')
    if (lastColon > 0) {
      const portToken = normalized.slice(lastColon + 1)
      const port = this.parsePortToken(portToken)
      if (port !== undefined || portToken === '*') {
        return {
          address: normalized.slice(0, lastColon) || '*',
          port,
        }
      }
    }

    return { address: normalized }
  }

  private parsePortToken(token: string): number | undefined {
    if (!token || token === '*' || token === '-') return undefined
    const parsed = parseInt(token, 10)
    return Number.isFinite(parsed) ? parsed : undefined
  }

  private parseSsOwner(trailing: string): { pid?: number; processName?: string } {
    const match = trailing.match(/users:\(\("([^"]+)",pid=(\d+)/)
    if (!match) return {}
    return {
      processName: match[1],
      pid: parseInt(match[2], 10),
    }
  }

  private parseNetstatOwner(token: string | undefined): { pid?: number; processName?: string } {
    if (!token || token === '-' || token === '0') return {}
    const match = token.match(/^(\d+)\/(.+)$/)
    if (!match) return {}
    return {
      pid: parseInt(match[1], 10),
      processName: match[2],
    }
  }

  private parseLsofAddress(value: string): {
    localAddress: string
    localPort?: number
    remoteAddress?: string
    remotePort?: number
  } {
    const [localPart, remotePart] = value.split('->')
    const local = this.parseSocketAddress(localPart || value)
    const remote = remotePart ? this.parseSocketAddress(remotePart) : undefined
    return {
      localAddress: local.address,
      localPort: local.port,
      remoteAddress: remote?.address,
      remotePort: remote?.port,
    }
  }

  private normalizeProtocol(value: string): 'tcp' | 'udp' {
    return String(value || '').toLowerCase().startsWith('udp') ? 'udp' : 'tcp'
  }

  private aggregateSocketEntries(entries: RawSocketEntry[]): NetworkConnectionSnapshot[] {
    const groups = new Map<
      string,
      NetworkConnectionSnapshot & {
        remoteHosts: Set<string>
      }
    >()

    const sortedEntries = entries
      .slice()
      .sort((left, right) => Number(this.isListeningState(right.protocol, right.state)) - Number(this.isListeningState(left.protocol, left.state)))

    for (const entry of sortedEntries) {
      const isListening = this.isListeningState(entry.protocol, entry.state)
      const key = this.resolveSocketGroupKey(entry, groups, isListening)
      let group = groups.get(key)
      if (!group) {
        group = {
          protocol: entry.protocol,
          localAddress: entry.localAddress,
          localPort: entry.localPort,
          state: entry.state ? String(entry.state).toUpperCase() : undefined,
          isListening,
          pid: entry.pid,
          processName: entry.processName,
          user: entry.user,
          remoteHostCount: 0,
          connectionCount: 0,
          remoteHosts: new Set<string>(),
        }
        groups.set(key, group)
      }

      if (entry.user && !group.user) {
        group.user = entry.user
      }
      if (entry.processName && !group.processName) {
        group.processName = entry.processName
      }
      if (isListening) {
        group.isListening = true
        group.state = String(entry.state || 'LISTEN').toUpperCase()
        continue
      }

      if (entry.remoteAddress && entry.remoteAddress !== '*' && entry.remoteAddress !== '0.0.0.0') {
        group.remoteHosts.add(entry.remoteAddress)
      }
      group.connectionCount += 1
      if (!group.state || group.state === 'LISTEN') {
        group.state = entry.state ? String(entry.state).toUpperCase() : group.state
      }
    }

    return Array.from(groups.values())
      .map(({ remoteHosts, ...entry }) => ({
        ...entry,
        remoteHostCount: remoteHosts.size,
      }))
      .sort((left, right) => {
        if (Boolean(left.isListening) !== Boolean(right.isListening)) {
          return left.isListening ? -1 : 1
        }
        if (right.connectionCount !== left.connectionCount) {
          return right.connectionCount - left.connectionCount
        }
        if (right.remoteHostCount !== left.remoteHostCount) {
          return right.remoteHostCount - left.remoteHostCount
        }
        return (left.localPort || 0) - (right.localPort || 0)
      })
      .slice(0, MAX_SOCKET_ROWS)
  }

  private resolveSocketGroupKey(
    entry: RawSocketEntry,
    groups: Map<string, NetworkConnectionSnapshot & { remoteHosts: Set<string> }>,
    isListening: boolean
  ): string {
    const exactKey = this.buildSocketGroupKey(entry.protocol, entry.pid, entry.processName, entry.localAddress, entry.localPort)
    if (isListening || entry.localPort === undefined) {
      return exactKey
    }

    const listenerGroups = Array.from(groups.entries()).filter(([, value]) => {
      if (!value.isListening) return false
      if (value.protocol !== entry.protocol) return false
      if ((value.pid ?? null) !== (entry.pid ?? null)) return false
      if ((value.processName ?? '') !== (entry.processName ?? '')) return false
      return (value.localPort ?? null) === entry.localPort
    })

    const exactListener = listenerGroups.find(([, value]) => value.localAddress === entry.localAddress)
    if (exactListener) {
      return exactListener[0]
    }

    const wildcardListener = listenerGroups.find(([, value]) => this.isWildcardAddress(value.localAddress))
    if (wildcardListener) {
      return wildcardListener[0]
    }

    return exactKey
  }

  private buildSocketGroupKey(
    protocol: RawSocketEntry['protocol'],
    pid: number | undefined,
    processName: string | undefined,
    localAddress: string,
    localPort: number | undefined
  ): string {
    return [protocol, pid ?? '', processName ?? '', localAddress, localPort ?? ''].join('|')
  }

  private isListeningState(protocol: 'tcp' | 'udp', state?: string): boolean {
    if (protocol === 'udp') return true
    const normalized = String(state || '').toUpperCase()
    return normalized === 'LISTEN' || normalized === 'BOUND' || normalized === 'UNCONN'
  }

  private isWildcardAddress(address: string): boolean {
    const normalized = String(address || '').trim()
    return normalized === '*' || normalized === '0.0.0.0' || normalized === '::'
  }

  private normalizeSocketEntry(entry: any): RawSocketEntry | null {
    if (!entry) return null
    const localAddress = String(entry.localAddress ?? entry.la ?? '').trim()
    if (!localAddress) return null
    return {
      protocol: this.normalizeProtocol(entry.protocol ?? entry.p ?? 'tcp'),
      state: entry.state ?? entry.s ? String(entry.state ?? entry.s) : undefined,
      localAddress,
      localPort: this.asNumber(entry.localPort ?? entry.lp),
      remoteAddress: entry.remoteAddress ?? entry.ra ? String(entry.remoteAddress ?? entry.ra) : undefined,
      remotePort: this.asNumber(entry.remotePort ?? entry.rp),
      pid: this.asNumber(entry.pid ?? entry.i),
      processName: entry.processName ?? entry.n ? String(entry.processName ?? entry.n) : undefined,
      user: entry.user ?? entry.u ? String(entry.user ?? entry.u) : undefined,
    }
  }

  private normalizeWindowsSystem(entry: any): Partial<ResourceSystemSnapshot> | undefined {
    if (!entry) {
      return undefined
    }
    const hostname = this.sanitizeTextField(entry.hostname ?? entry.h)
    const osName = this.sanitizeTextField(entry.osName ?? entry.o)
    const release = this.sanitizeTextField(entry.release ?? entry.r)
    const arch = this.sanitizeTextField(entry.arch ?? entry.a)
    const shell = this.sanitizeTextField(entry.shell ?? entry.sh)
    if (!hostname && !osName && !release && !arch && !shell) {
      return undefined
    }
    return {
      ...(hostname ? { hostname } : {}),
      ...(osName ? { osName } : {}),
      ...(release ? { release } : {}),
      ...(arch ? { arch } : {}),
      ...(shell ? { shell } : {}),
    }
  }

  private normalizeWindowsCpu(entry: any): CpuSnapshot | undefined {
    if (!entry) return undefined
    const usagePercent = this.asNumber(entry.usagePercent ?? entry.u)
    if (usagePercent === undefined) return undefined
    const rawCorePercents = entry.corePercents ?? entry.c
    const corePercents = Array.isArray(rawCorePercents)
      ? rawCorePercents
          .map((value: unknown) => this.asNumber(value))
          .filter((value: number | undefined): value is number => value !== undefined)
      : undefined
    return {
      usagePercent,
      corePercents: corePercents && corePercents.length > 0 ? corePercents : undefined,
      logicalCoreCount: this.asNumber(entry.logicalCoreCount ?? entry.l),
      modelName: entry.modelName ?? entry.m ? String(entry.modelName ?? entry.m) : undefined,
    }
  }

  private normalizeWindowsMemory(entry: any): MemorySnapshot | undefined {
    if (!entry) return undefined
    const totalBytes = this.asNumber(entry.totalBytes ?? entry.t)
    const usedBytes = this.asNumber(entry.usedBytes ?? entry.u)
    const availableBytes = this.asNumber(entry.availableBytes ?? entry.a)
    if (totalBytes === undefined || usedBytes === undefined || availableBytes === undefined) {
      return undefined
    }
    const swapEntry = entry.swap ?? entry.s
    const swapTotal = this.asNumber(swapEntry?.totalBytes ?? swapEntry?.t)
    const swapUsed = this.asNumber(swapEntry?.usedBytes ?? swapEntry?.u)
    return {
      totalBytes,
      usedBytes,
      availableBytes,
      freeBytes: this.asNumber(entry.freeBytes ?? entry.f),
      usagePercent: this.asNumber(entry.usagePercent ?? entry.p) ?? this.percent(usedBytes, totalBytes),
      swap:
        swapTotal !== undefined && swapUsed !== undefined
          ? {
              totalBytes: swapTotal,
              usedBytes: swapUsed,
            }
          : undefined,
    }
  }

  private normalizeDisk(entry: any): DiskSnapshot {
    const totalBytes = this.asNumber(entry.totalBytes ?? entry.t) || 0
    const usedBytes = this.asNumber(entry.usedBytes ?? entry.u) || 0
    const availableBytes = this.asNumber(entry.availableBytes ?? entry.a) || 0
    const rawMountPoint = String(entry.mountPoint ?? entry.m ?? '').trim()
    const mountPoint = rawMountPoint || String(entry.filesystem ?? entry.f ?? 'disk').trim() || 'disk'
    const filesystem = this.sanitizeDiskFilesystem(entry.filesystem ?? entry.f, mountPoint)
    return {
      filesystem,
      mountPoint,
      totalBytes,
      usedBytes,
      availableBytes,
      usagePercent:
        this.asNumber(entry.usagePercent ?? entry.p) ?? this.percent(usedBytes, totalBytes || 1),
    }
  }

  private normalizeGpu(entry: any): GpuSnapshot {
    const utilizationPercent = this.asNumber(entry.utilizationPercent ?? entry.u) || 0
    const memoryUsedMiB = this.asNumber(entry.memoryUsedMiB ?? entry.m) || 0
    const memoryTotalMiB = this.asNumber(entry.memoryTotalMiB ?? entry.t) || 0
    const derivedMemoryUsagePercent =
      memoryTotalMiB > 0 ? this.percent(memoryUsedMiB, memoryTotalMiB) : undefined
    return {
      name: entry.name ?? entry.n ? String(entry.name ?? entry.n) : undefined,
      utilizationPercent,
      memoryUsedMiB,
      memoryTotalMiB,
      memoryUsagePercent:
        this.asNumber(entry.memoryUsagePercent ?? entry.p) ?? derivedMemoryUsagePercent,
      memoryUtilizationPercent: this.asNumber(
        entry.memoryUtilizationPercent ?? entry.mu
      ),
      sharedMemoryUsedMiB: this.asNumber(entry.sharedMemoryUsedMiB ?? entry.s),
      temperatureC: this.asNumber(entry.temperatureC ?? entry.tc),
      powerUsageWatts: this.asNumber(entry.powerUsageWatts ?? entry.pw),
      powerLimitWatts: this.asNumber(entry.powerLimitWatts ?? entry.pl),
      powerState: entry.powerState ?? entry.ps ? String(entry.powerState ?? entry.ps) : undefined,
      memoryClockMHz: this.asNumber(entry.memoryClockMHz ?? entry.mc),
    }
  }

  private normalizeNetwork(entry: any): NetworkSnapshot | null {
    const iface = entry?.interface ?? entry?.i
    if (!iface) return null
    return {
      interface: String(iface),
      rxBytesPerSec: this.asNumber(entry.rxBytesPerSec ?? entry.r) || 0,
      txBytesPerSec: this.asNumber(entry.txBytesPerSec ?? entry.t) || 0,
    }
  }

  private normalizeProcess(entry: any): ProcessSnapshot | null {
    const pid = this.asNumber(entry?.pid ?? entry?.i)
    const name = entry?.name ?? entry?.n ? String(entry.name ?? entry.n) : ''
    if (pid === undefined || !name) return null
    return {
      pid,
      name,
      user: entry.user ?? entry.usr ? String(entry.user ?? entry.usr) : undefined,
      cpuPercent: this.asNumber(entry.cpuPercent ?? entry.c),
      memoryBytes: this.asNumber(entry.memoryBytes ?? entry.m),
      command: entry.command ?? entry.cmd ? String(entry.command ?? entry.cmd) : undefined,
      path: entry.path ?? entry.p ? String(entry.path ?? entry.p) : undefined,
      state: entry.state ?? entry.s ? String(entry.state ?? entry.s) : undefined,
    }
  }

  private extractExecutablePath(command: string | undefined): string | undefined {
    const normalized = String(command || '').trim()
    if (!normalized) return undefined
    const token = normalized.split(/\s+/)[0]
    if (token.startsWith('/') || /^[A-Za-z]:[\\/]/.test(token)) {
      return token
    }
    return undefined
  }

  private percent(used: number, total: number): number {
    if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) {
      return 0
    }
    return this.roundToTenth((used / total) * 100)
  }

  private roundToTenth(value: number): number {
    if (!Number.isFinite(value)) return 0
    return Math.round(value * 10) / 10
  }

  // PowerShell's `ConvertTo-Json` collapses single-element collections into a
  // bare object, so a host with exactly one GPU/disk/etc. arrives as an object
  // rather than an array. Coerce back to an array so single-item resources are
  // not silently dropped by downstream `Array.isArray` checks.
  private coerceArray(value: unknown): any[] {
    if (Array.isArray(value)) return value
    if (value === undefined || value === null) return []
    return [value]
  }

  private asNumber(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value
    }
    if (typeof value === 'string' && value.trim().length > 0) {
      const parsed = Number(value)
      return Number.isFinite(parsed) ? parsed : undefined
    }
    return undefined
  }
}
