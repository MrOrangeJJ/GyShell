import type { TerminalActivitySnapshot } from '@gyshell/shared'
import type { DatabaseHandle } from '../../history/betterSqlite3Runtime'

type ActivityRow = {
  terminal_id: string
  activity_id: string
  kind: string
  actor: string
  origin: string
  status: string
  revision: number
  started_at: number
  updated_at: number
  ended_at: number | null
  command: string | null
  intent: string | null
  exit_code: number | null
  start_offset: number
  end_offset: number | null
  runtime_generation: number | null
  shell_sequence: number | null
  session_id: string | null
  message_id: string | null
}

const isSafeNonNegativeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

const isActivityStatus = (
  value: string,
): value is TerminalActivitySnapshot['status'] =>
  value === 'running' ||
  value === 'succeeded' ||
  value === 'failed' ||
  value === 'aborted' ||
  value === 'outcome-unknown'

const isActivityActor = (
  value: string,
): value is TerminalActivitySnapshot['actor'] =>
  value === 'user' || value === 'agent'

const isActivityOrigin = (
  value: string,
): value is TerminalActivitySnapshot['origin'] =>
  value === 'interactive-shell' || value === 'agent-exec-command'

/** Rows that fail validation are skipped rather than failing the read. */
const toActivitySnapshot = (
  row: ActivityRow,
): TerminalActivitySnapshot | undefined => {
  if (
    row.kind !== 'command' ||
    !isActivityActor(row.actor) ||
    !isActivityOrigin(row.origin) ||
    !isActivityStatus(row.status) ||
    !isSafeNonNegativeInteger(row.revision) ||
    !isSafeNonNegativeInteger(row.started_at) ||
    !isSafeNonNegativeInteger(row.updated_at) ||
    !isSafeNonNegativeInteger(row.start_offset)
  ) {
    return undefined
  }
  return {
    id: row.activity_id,
    terminalId: row.terminal_id,
    kind: 'command',
    actor: row.actor,
    origin: row.origin,
    status: row.status,
    revision: row.revision,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    ...(row.ended_at !== null ? { endedAt: row.ended_at } : {}),
    ...(row.command ? { command: row.command } : {}),
    ...(row.intent ? { intent: row.intent } : {}),
    ...(row.exit_code !== null ? { exitCode: row.exit_code } : {}),
    startOffset: row.start_offset,
    ...(row.end_offset !== null ? { endOffset: row.end_offset } : {}),
    ...(row.runtime_generation !== null
      ? { runtimeGeneration: row.runtime_generation }
      : {}),
    ...(row.shell_sequence !== null
      ? { shellSequence: row.shell_sequence }
      : {}),
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    ...(row.message_id ? { messageId: row.message_id } : {}),
  }
}

/** Ordering shared by durable reads and the pending overlay. */
export const compareActivities = (
  left: TerminalActivitySnapshot,
  right: TerminalActivitySnapshot,
): number =>
  left.startedAt - right.startedAt ||
  (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)

export class TerminalActivityRepository {
  constructor(
    private readonly db: DatabaseHandle,
    private readonly maxRecordsPerTerminal: number,
  ) {}

  /** Upsert snapshots. Must run inside the caller's transaction. */
  apply(activities: readonly TerminalActivitySnapshot[]): void {
    if (activities.length === 0) return
    const statement = this.db.prepare(
      `INSERT INTO terminal_activities
       (terminal_id, activity_id, kind, actor, origin, status, revision,
        started_at, updated_at, ended_at, command, intent, exit_code,
        start_offset, end_offset, runtime_generation, shell_sequence,
        session_id, message_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(terminal_id, activity_id) DO UPDATE SET
        kind = excluded.kind,
        actor = excluded.actor,
        origin = excluded.origin,
        status = excluded.status,
        revision = excluded.revision,
        started_at = excluded.started_at,
        updated_at = excluded.updated_at,
        ended_at = excluded.ended_at,
        command = excluded.command,
        intent = excluded.intent,
        exit_code = excluded.exit_code,
        start_offset = excluded.start_offset,
        end_offset = excluded.end_offset,
        runtime_generation = excluded.runtime_generation,
        shell_sequence = excluded.shell_sequence,
        session_id = excluded.session_id,
        message_id = excluded.message_id`,
    )
    for (const activity of activities) {
      statement.run(
        activity.terminalId,
        activity.id,
        activity.kind,
        activity.actor,
        activity.origin,
        activity.status,
        activity.revision,
        activity.startedAt,
        activity.updatedAt,
        activity.endedAt ?? null,
        activity.command ?? null,
        activity.intent ?? null,
        activity.exitCode ?? null,
        activity.startOffset,
        activity.endOffset ?? null,
        activity.runtimeGeneration ?? null,
        activity.shellSequence ?? null,
        activity.sessionId ?? null,
        activity.messageId ?? null,
      )
    }
  }

  read(terminalId: string): TerminalActivitySnapshot[] {
    const rows = this.db
      .prepare(
        `SELECT terminal_id, activity_id, kind, actor, origin, status,
                revision, started_at, updated_at, ended_at, command, intent,
                exit_code, start_offset, end_offset, runtime_generation,
                shell_sequence, session_id, message_id
           FROM terminal_activities
          WHERE terminal_id = ?
          ORDER BY started_at ASC, activity_id ASC`,
      )
      .all(terminalId) as ActivityRow[]
    return rows.flatMap((row) => toActivitySnapshot(row) ?? [])
  }

  /**
   * Keep at most `maxRecordsPerTerminal` rows for each given terminal,
   * evicting the oldest finished rows first. Running rows are never evicted.
   */
  prune(terminalIds: Iterable<string>): void {
    const countRows = this.db.prepare(
      'SELECT COUNT(*) AS count FROM terminal_activities WHERE terminal_id = ?',
    )
    const selectEvictable = this.db.prepare(
      `SELECT activity_id
         FROM terminal_activities
        WHERE terminal_id = ? AND status != 'running'
        ORDER BY started_at ASC, activity_id ASC
        LIMIT ?`,
    )
    const deleteRow = this.db.prepare(
      'DELETE FROM terminal_activities WHERE terminal_id = ? AND activity_id = ?',
    )
    for (const terminalId of terminalIds) {
      const { count } = countRows.get(terminalId) as { count: number }
      const excess = count - this.maxRecordsPerTerminal
      if (excess <= 0) continue
      const evictable = selectEvictable.all(terminalId, excess) as Array<{
        activity_id: string
      }>
      for (const row of evictable) deleteRow.run(terminalId, row.activity_id)
    }
  }

  /** A runtime that ended while an Activity was running has no outcome. */
  recoverInterrupted(
    terminalId: string,
    now: number,
    visibleEndOffset: number,
  ): void {
    this.db
      .prepare(
        `UPDATE terminal_activities
            SET status = 'outcome-unknown', revision = revision + 1,
                updated_at = ?, ended_at = ?,
                end_offset = MAX(start_offset, COALESCE(end_offset, ?))
          WHERE terminal_id = ? AND status = 'running'`,
      )
      .run(now, now, visibleEndOffset, terminalId)
  }

  listTerminalIds(): string[] {
    return (
      this.db
        .prepare('SELECT DISTINCT terminal_id FROM terminal_activities')
        .all() as Array<{ terminal_id: string }>
    ).map((row) => row.terminal_id)
  }

  deleteTerminal(terminalId: string): void {
    this.db
      .prepare('DELETE FROM terminal_activities WHERE terminal_id = ?')
      .run(terminalId)
  }

  deleteAll(): void {
    this.db.exec('DELETE FROM terminal_activities')
  }
}
