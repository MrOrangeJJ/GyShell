import fs from 'node:fs'
import path from 'node:path'
import type {
  TerminalActivitySnapshot,
  TerminalSessionBoundary,
} from '@gyshell/shared'
import {
  openBetterSqlite3Database,
  type DatabaseHandle,
} from '../history/betterSqlite3Runtime'
import {
  AGENT_COMMAND_CAPTURE_RETENTION_BUDGET_BYTES,
  AGENT_COMMAND_CAPTURE_RETENTION_MAX_RECORDS,
  AGENT_COMMAND_TOMBSTONE_MAX_RECORDS,
  type AgentCommandSummary,
  type PersistedAgentCommandRecord,
} from './agentCommandRecord'

export type { PersistedAgentCommandRecord } from './agentCommandRecord'
import { TERMINAL_ACTIVITY_RETENTION_MAX_RECORDS } from './TerminalActivityStore'
import { splitUtf8Bounded, utf8ByteLength } from './utf8Text'
import { AgentCommandRepository } from './persistence/AgentCommandRepository'
import {
  classifySqliteCorruption,
  isSqliteCorruptionError,
  TerminalPersistenceUnsupportedVersionError,
} from './persistence/errors'
import { initializeTerminalPersistenceSchema } from './persistence/schema'
import { SessionBoundaryRepository } from './persistence/SessionBoundaryRepository'
import {
  compareActivities,
  TerminalActivityRepository,
} from './persistence/TerminalActivityRepository'
import {
  VisibleHistoryRepository,
  type VisibleHistoryTail,
  type VisibleSegment,
} from './persistence/VisibleHistoryRepository'

const DEFAULT_VISIBLE_HISTORY_MAX_UTF8_BYTES = 4 * 1024 * 1024
const DEFAULT_RESTORE_MAX_VISIBLE_CHARACTERS = 200_000
const DEFAULT_VISIBLE_HISTORY_MAX_SEGMENTS = 4096
/** Pending visible data is coalesced into segments of at most this size. */
const VISIBLE_SEGMENT_MAX_UTF8_BYTES = 64 * 1024

export interface TerminalPersistenceRestoreSnapshot {
  visible: VisibleHistoryTail
  activities: TerminalActivitySnapshot[]
}

export interface TerminalRestoreOptions {
  /** Size of the in-memory visible buffer the restored tail must fit into. */
  maxVisibleCharacters: number
  now?: number
}

export interface TerminalPersistenceStoreOptions {
  visibleHistoryMaxUtf8Bytes?: number
  visibleHistoryMaxSegments?: number
  activityRetentionMaxRecords?: number
  agentCaptureRetentionBudgetBytes?: number
  agentCaptureRetentionMaxRecords?: number
  agentTombstoneMaxRecords?: number
}

type AgentCommandKey = { terminalId: string; commandId: string }

const isSafeNonNegativeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

const positiveLimit = (value: number | undefined, fallback: number): number =>
  Math.max(1, Math.floor(value ?? fallback))

const recordKey = (terminalId: string, recordId: string): string =>
  `${terminalId}\u0000${recordId}`

const cloneAgentCommand = (
  record: PersistedAgentCommandRecord,
): PersistedAgentCommandRecord => ({ ...record, capture: { ...record.capture } })

/** Same order as AgentCommandRepository.list: newest first. */
const compareAgentCommandsNewestFirst = (
  left: { startedAt: number; commandId: string },
  right: { startedAt: number; commandId: string },
): number =>
  right.startedAt - left.startedAt ||
  (left.commandId < right.commandId ? 1 : left.commandId > right.commandId ? -1 : 0)

/**
 * Durable terminal-domain facts: the visible stream, Activities, session
 * boundaries and Agent command transcripts. Runtime RingBuffers, xterm
 * instances and the ActivityStore remain disposable projections over it.
 *
 * Writes are buffered in a pending batch and applied by `flush()` in one
 * transaction. Reads overlay the pending batch so callers never observe a
 * write disappearing between enqueue and flush.
 *
 * Agent command records intentionally outlive their terminal tab: a chat may
 * still reference a command after the tab was closed or the app restarted.
 * They are bounded globally by the shared Agent command retention policy;
 * everything else is per terminal and removed with the terminal.
 */
export class TerminalPersistenceStore {
  private readonly db: DatabaseHandle
  private readonly visibleHistory: VisibleHistoryRepository
  private readonly activities: TerminalActivityRepository
  private readonly agentCommands: AgentCommandRepository
  private readonly sessionBoundaries: SessionBoundaryRepository
  private pendingVisibleSegments: VisibleSegment[] = []
  private readonly lastPendingSegmentByTerminal = new Map<string, VisibleSegment>()
  private readonly pendingActivities = new Map<string, TerminalActivitySnapshot>()
  private readonly pendingAgentCommands = new Map<string, PersistedAgentCommandRecord>()
  private readonly pendingAgentCommandDeletes = new Map<string, AgentCommandKey>()
  private pendingUtf8Bytes = 0
  private closed = false

  constructor(filePath: string, options?: TerminalPersistenceStoreOptions) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    this.db = openBetterSqlite3Database(filePath)
    try {
      initializeTerminalPersistenceSchema(this.db)
    } catch (error) {
      // Release the file so the caller can quarantine it.
      this.db.close()
      throw error
    }
    this.visibleHistory = new VisibleHistoryRepository(this.db, {
      maxUtf8Bytes: positiveLimit(
        options?.visibleHistoryMaxUtf8Bytes,
        DEFAULT_VISIBLE_HISTORY_MAX_UTF8_BYTES,
      ),
      maxSegments: positiveLimit(
        options?.visibleHistoryMaxSegments,
        DEFAULT_VISIBLE_HISTORY_MAX_SEGMENTS,
      ),
    })
    this.activities = new TerminalActivityRepository(
      this.db,
      positiveLimit(
        options?.activityRetentionMaxRecords,
        TERMINAL_ACTIVITY_RETENTION_MAX_RECORDS,
      ),
    )
    this.agentCommands = new AgentCommandRepository(this.db, {
      captureBudgetBytes: positiveLimit(
        options?.agentCaptureRetentionBudgetBytes,
        AGENT_COMMAND_CAPTURE_RETENTION_BUDGET_BYTES,
      ),
      captureMaxRecords: positiveLimit(
        options?.agentCaptureRetentionMaxRecords,
        AGENT_COMMAND_CAPTURE_RETENTION_MAX_RECORDS,
      ),
      tombstoneMaxRecords: positiveLimit(
        options?.agentTombstoneMaxRecords,
        AGENT_COMMAND_TOMBSTONE_MAX_RECORDS,
      ),
    })
    this.sessionBoundaries = new SessionBoundaryRepository(this.db)
  }

  /** UTF-8 size of visible data and Agent output waiting for `flush()`. */
  getPendingUtf8Bytes(): number {
    return this.pendingUtf8Bytes
  }

  appendVisibleStream(
    terminalId: string,
    startOffset: number,
    data: string,
    _runtimeGeneration?: number,
  ): void {
    if (this.closed || !terminalId || !data) return
    if (!isSafeNonNegativeInteger(startOffset)) {
      throw new Error('Visible stream start offset must be a safe non-negative integer.')
    }
    const dataBytes = utf8ByteLength(data)
    this.pendingUtf8Bytes += dataBytes

    const last = this.lastPendingSegmentByTerminal.get(terminalId)
    if (
      last &&
      last.endOffset === startOffset &&
      last.utf8Bytes + dataBytes <= VISIBLE_SEGMENT_MAX_UTF8_BYTES
    ) {
      last.data += data
      last.endOffset += data.length
      last.utf8Bytes += dataBytes
      return
    }

    let nextOffset = startOffset
    for (const chunk of splitUtf8Bounded(data, VISIBLE_SEGMENT_MAX_UTF8_BYTES)) {
      const segment: VisibleSegment = {
        terminalId,
        startOffset: nextOffset,
        endOffset: nextOffset + chunk.length,
        data: chunk,
        utf8Bytes: utf8ByteLength(chunk),
        createdAt: Date.now(),
      }
      this.pendingVisibleSegments.push(segment)
      this.lastPendingSegmentByTerminal.set(terminalId, segment)
      nextOffset = segment.endOffset
    }
  }

  saveActivity(activity: TerminalActivitySnapshot): void {
    if (this.closed) return
    this.pendingActivities.set(recordKey(activity.terminalId, activity.id), {
      ...activity,
    })
  }

  saveAgentCommand(record: PersistedAgentCommandRecord): void {
    if (this.closed) return
    const key = recordKey(record.terminalId, record.commandId)
    this.dropPendingAgentCommand(key)
    this.pendingAgentCommandDeletes.delete(key)
    this.pendingAgentCommands.set(key, cloneAgentCommand(record))
    this.pendingUtf8Bytes += utf8ByteLength(record.output)
  }

  deleteAgentCommand(terminalId: string, commandId: string): void {
    if (this.closed) return
    const key = recordKey(terminalId, commandId)
    this.dropPendingAgentCommand(key)
    this.pendingAgentCommandDeletes.set(key, { terminalId, commandId })
  }

  /** True when a flush still has any durable write to commit. */
  hasPendingWrites(): boolean {
    return (
      this.pendingVisibleSegments.length > 0 ||
      this.pendingActivities.size > 0 ||
      this.pendingAgentCommands.size > 0 ||
      this.pendingAgentCommandDeletes.size > 0
    )
  }

  flush(): void {
    if (this.closed) return
    if (
      this.pendingVisibleSegments.length === 0 &&
      this.pendingActivities.size === 0 &&
      this.pendingAgentCommands.size === 0 &&
      this.pendingAgentCommandDeletes.size === 0
    ) {
      return
    }

    const visibleSegments = this.pendingVisibleSegments
    const activities = Array.from(this.pendingActivities.values())
    const agentCommands = Array.from(this.pendingAgentCommands.values())
    const agentCommandDeletes = Array.from(this.pendingAgentCommandDeletes.values())

    // Keep the batch queued until the transaction commits. A transient
    // SQLITE_BUSY/disk error must be retryable; silently dropping the batch
    // would create an unbounded visible-stream gap and lose Activities.
    this.db.transaction(() => {
      const { rewoundTerminalIds } =
        this.visibleHistory.applySegments(visibleSegments)
      // Boundaries and Activities address the abandoned stream. Drop pending
      // Activity snapshots for a rewound/gapped terminal before applying the
      // rest of this batch, or the old metadata would be reinserted below.
      for (const terminalId of rewoundTerminalIds) {
        this.sessionBoundaries.deleteTerminal(terminalId)
        this.activities.deleteTerminal(terminalId)
      }
      const activitiesToApply = activities.filter(
        (activity) => !rewoundTerminalIds.has(activity.terminalId),
      )
      this.activities.apply(activitiesToApply)
      this.agentCommands.apply(agentCommands)
      this.agentCommands.delete(agentCommandDeletes)

      const movedBaseOffsets = this.visibleHistory.prune(
        new Set(visibleSegments.map((segment) => segment.terminalId)),
      )
      for (const [terminalId, baseOffset] of movedBaseOffsets) {
        this.sessionBoundaries.deleteBelow(terminalId, baseOffset)
      }
      this.activities.prune(
        new Set(activitiesToApply.map((activity) => activity.terminalId)),
      )
      if (agentCommands.length > 0 || agentCommandDeletes.length > 0) {
        this.agentCommands.prune()
      }
    })()

    this.pendingVisibleSegments = []
    this.lastPendingSegmentByTerminal.clear()
    this.pendingActivities.clear()
    this.pendingAgentCommands.clear()
    this.pendingAgentCommandDeletes.clear()
    this.pendingUtf8Bytes = 0
  }

  /**
   * Load a terminal's durable state for a new runtime. Records that were
   * still running belong to the previous runtime and are closed as
   * outcome-unknown first. Throws TerminalPersistenceCorruptError when the
   * stored data is unreadable; other errors are transient.
   */
  restoreTerminal(
    terminalId: string,
    options?: TerminalRestoreOptions | number,
  ): TerminalPersistenceRestoreSnapshot {
    const { maxVisibleCharacters, now = Date.now() } =
      typeof options === 'number'
        ? { maxVisibleCharacters: options }
        : {
            maxVisibleCharacters:
              options?.maxVisibleCharacters ?? DEFAULT_RESTORE_MAX_VISIBLE_CHARACTERS,
            now: options?.now,
          }
    if (this.closed) {
      throw new Error('Terminal persistence store is closed.')
    }
    return classifySqliteCorruption(() => {
      this.flush()
      this.db.transaction(() => {
        this.activities.recoverInterrupted(
          terminalId,
          now,
          this.visibleHistory.readEndOffset(terminalId),
        )
        this.agentCommands.recoverInterrupted(terminalId, now)
      })()
      return {
        visible: this.visibleHistory.readTail(terminalId, maxVisibleCharacters),
        activities: this.activities.read(terminalId),
      }
    })
  }

  readVisibleRange(
    terminalId: string,
    startOffset: number,
    endOffset: number,
  ): string {
    if (this.closed) return ''
    return this.visibleHistory.readRange(terminalId, startOffset, endOffset)
  }

  readActivities(terminalId: string): TerminalActivitySnapshot[] {
    if (this.closed) return []
    const byId = new Map(
      this.activities.read(terminalId).map((activity) => [activity.id, activity]),
    )
    for (const activity of this.pendingActivities.values()) {
      if (activity.terminalId === terminalId) {
        byId.set(activity.id, { ...activity })
      }
    }
    return Array.from(byId.values()).sort(compareActivities)
  }

  getAgentCommand(
    terminalId: string,
    commandId: string,
  ): PersistedAgentCommandRecord | undefined {
    if (this.closed) return undefined
    const key = recordKey(terminalId, commandId)
    if (this.pendingAgentCommandDeletes.has(key)) return undefined
    const pending = this.pendingAgentCommands.get(key)
    if (pending) return cloneAgentCommand(pending)
    return this.agentCommands.get(terminalId, commandId)
  }

  /** Metadata-only: true when a record exists, without reading its output. */
  hasAgentCommand(terminalId: string, commandId: string): boolean {
    if (this.closed) return false
    const key = recordKey(terminalId, commandId)
    if (this.pendingAgentCommandDeletes.has(key)) return false
    if (this.pendingAgentCommands.has(key)) return true
    return this.agentCommands.has(terminalId, commandId)
  }

  /** Newest first. */
  listAgentCommands(terminalId: string): PersistedAgentCommandRecord[] {
    if (this.closed) return []
    const byId = new Map(
      this.agentCommands
        .list(terminalId)
        .map((record) => [record.commandId, record]),
    )
    for (const record of this.pendingAgentCommands.values()) {
      if (record.terminalId === terminalId) {
        byId.set(record.commandId, cloneAgentCommand(record))
      }
    }
    for (const key of this.pendingAgentCommandDeletes.values()) {
      if (key.terminalId === terminalId) byId.delete(key.commandId)
    }
    return Array.from(byId.values()).sort(compareAgentCommandsNewestFirst)
  }

  /** Command and exit code of the newest Agent command, without its output. */
  getLatestAgentCommand(terminalId: string): AgentCommandSummary | undefined {
    if (this.closed) return undefined
    const hasPendingChange = [
      ...this.pendingAgentCommands.values(),
      ...this.pendingAgentCommandDeletes.values(),
    ].some((entry) => entry.terminalId === terminalId)
    // The pending overlay is rare here (restore flushes first); fall back to
    // the full overlay read instead of duplicating its merge rules.
    const latest = hasPendingChange
      ? this.listAgentCommands(terminalId)[0]
      : this.agentCommands.getLatestSummary(terminalId)
    if (!latest) return undefined
    return {
      command: latest.command,
      ...(latest.exitCode !== undefined ? { exitCode: latest.exitCode } : {}),
    }
  }

  recordSessionBoundary(boundary: TerminalSessionBoundary): void {
    if (this.closed || !boundary?.terminalId) return
    // Apply pending stream data first so a rewind in that batch cannot delete
    // the boundary that is about to be written.
    this.flush()
    this.sessionBoundaries.upsert(boundary)
  }

  listSessionBoundaries(terminalId: string): TerminalSessionBoundary[] {
    if (this.closed || !terminalId) return []
    return this.sessionBoundaries.list(terminalId)
  }

  /**
   * Remove everything addressed by the terminal's visible stream: segments,
   * Activities and session boundaries. Agent command records are kept.
   */
  deleteTerminalVisibleHistory(terminalId: string): void {
    if (this.closed) return
    this.dropPendingVisibleHistory(terminalId)
    try {
      this.flush()
    } catch (error) {
      console.warn(
        '[TerminalPersistenceStore] Flush before visible history deletion failed:',
        error,
      )
    }
    this.db.transaction(() => {
      this.deleteTerminalRows(terminalId)
    })()
  }

  /**
   * Delete the visible history of every terminal not in `terminalIds`, e.g.
   * tabs that were closed while their deletion could not be written.
   */
  retainTerminals(terminalIds: Iterable<string>): void {
    if (this.closed) return
    const retained = new Set(terminalIds)
    const pendingTerminalIds = new Set([
      ...this.pendingVisibleSegments.map((segment) => segment.terminalId),
      ...Array.from(this.pendingActivities.values(), (activity) => activity.terminalId),
    ])
    for (const terminalId of pendingTerminalIds) {
      if (!retained.has(terminalId)) this.dropPendingVisibleHistory(terminalId)
    }
    this.flush()
    const stored = new Set([
      ...this.visibleHistory.listTerminalIds(),
      ...this.activities.listTerminalIds(),
      ...this.sessionBoundaries.listTerminalIds(),
    ])
    this.db.transaction(() => {
      for (const terminalId of stored) {
        if (!retained.has(terminalId)) this.deleteTerminalRows(terminalId)
      }
    })()
  }

  clearAll(): void {
    if (this.closed) return
    this.pendingVisibleSegments = []
    this.lastPendingSegmentByTerminal.clear()
    this.pendingActivities.clear()
    this.pendingAgentCommands.clear()
    this.pendingAgentCommandDeletes.clear()
    this.pendingUtf8Bytes = 0
    this.db.transaction(() => {
      this.sessionBoundaries.deleteAll()
      this.agentCommands.deleteAll()
      this.activities.deleteAll()
      this.visibleHistory.deleteAll()
    })()
  }

  /** Flush and close. Safe to call more than once. */
  close(): void {
    if (this.closed) return
    try {
      this.flush()
    } finally {
      this.closed = true
      this.db.close()
    }
  }

  private deleteTerminalRows(terminalId: string): void {
    this.visibleHistory.deleteTerminal(terminalId)
    this.sessionBoundaries.deleteTerminal(terminalId)
    this.activities.deleteTerminal(terminalId)
  }

  private dropPendingVisibleHistory(terminalId: string): void {
    this.pendingVisibleSegments = this.pendingVisibleSegments.filter(
      (segment) => {
        if (segment.terminalId !== terminalId) return true
        this.pendingUtf8Bytes -= segment.utf8Bytes
        return false
      },
    )
    this.lastPendingSegmentByTerminal.delete(terminalId)
    for (const [key, activity] of this.pendingActivities) {
      if (activity.terminalId === terminalId) this.pendingActivities.delete(key)
    }
  }

  private dropPendingAgentCommand(key: string): void {
    const pending = this.pendingAgentCommands.get(key)
    if (!pending) return
    this.pendingUtf8Bytes -= utf8ByteLength(pending.output)
    this.pendingAgentCommands.delete(key)
  }
}

/**
 * Open the store, degrading to no persistence instead of failing startup.
 * A corrupt file is moved aside to `<file>.corrupt-<timestamp>` so the next
 * launch starts fresh; a newer schema or a native SQLite load failure leaves
 * the file untouched.
 */
export const openTerminalPersistenceStore = (
  filePath: string,
  options?: TerminalPersistenceStoreOptions,
): TerminalPersistenceStore | null => {
  try {
    return new TerminalPersistenceStore(filePath, options)
  } catch (error) {
    if (error instanceof TerminalPersistenceUnsupportedVersionError) {
      console.error(
        `[TerminalPersistenceStore] ${error.message} Terminal history is disabled for this session.`,
      )
      return null
    }
    if (!isSqliteCorruptionError(error)) {
      console.error(
        '[TerminalPersistenceStore] Failed to open terminal persistence; terminal history is disabled for this session:',
        error,
      )
      return null
    }
    const quarantinePath = `${filePath}.corrupt-${Date.now()}`
    console.error(
      `[TerminalPersistenceStore] Terminal persistence database is corrupt; moving it to ${quarantinePath}. Terminal history is disabled for this session:`,
      error,
    )
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        if (fs.existsSync(`${filePath}${suffix}`)) {
          fs.renameSync(`${filePath}${suffix}`, `${quarantinePath}${suffix}`)
        }
      } catch (renameError) {
        console.error(
          `[TerminalPersistenceStore] Failed to move ${filePath}${suffix} aside:`,
          renameError,
        )
      }
    }
    return null
  }
}
