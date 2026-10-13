import type {
  CommandCaptureMetadata,
  CommandExecutionState,
} from '@gyshell/shared'
import type { DatabaseHandle } from '../../history/betterSqlite3Runtime'
import type {
  AgentCommandSummary,
  PersistedAgentCommandRecord,
} from '../agentCommandRecord'
import { splitUtf8Bounded, utf8ByteLength } from '../utf8Text'

export interface AgentCommandRetentionLimits {
  captureBudgetBytes: number
  captureMaxRecords: number
  tombstoneMaxRecords: number
}

type AgentCommandRow = {
  terminal_id: string
  command_id: string
  command: string
  status: string
  execution_state: string
  exit_code: number | null
  runtime_boundary: number
  outcome_unknown: number
  terminal_status: string | null
  start_offset: number
  end_offset: number | null
  activity_end_offset: number | null
  started_at: number
  ended_at: number | null
  capture_state: string
  capture_reason: string | null
  observed_utf8_bytes: number
  retained_utf8_bytes: number
  available_line_count: number
  capture_revision: number
  terminal_controls_observed: number
}

const AGENT_COMMAND_COLUMNS = `terminal_id, command_id, command, status,
  execution_state, exit_code, runtime_boundary, outcome_unknown,
  terminal_status, start_offset, end_offset, activity_end_offset, started_at,
  ended_at, capture_state, capture_reason, observed_utf8_bytes,
  retained_utf8_bytes, available_line_count, capture_revision,
  terminal_controls_observed`

/** Captured output is stored in chunks of at most this many UTF-8 bytes. */
const CAPTURE_CHUNK_MAX_UTF8_BYTES = 64 * 1024

const INTERRUPTED_TERMINAL_STATUS =
  'The previous terminal runtime ended before this command reached a definitive completion boundary.'

const parseCommandStatus = (
  value: string,
): PersistedAgentCommandRecord['status'] =>
  value === 'running' ||
  value === 'finished' ||
  value === 'aborted' ||
  value === 'timeout'
    ? value
    : 'aborted'

const parseExecutionState = (value: string): CommandExecutionState =>
  value === 'running' ||
  value === 'finished' ||
  value === 'aborted' ||
  value === 'outcome_unknown'
    ? value
    : 'outcome_unknown'

const parseCaptureState = (value: string): CommandCaptureMetadata['state'] =>
  value === 'in_progress' ||
  value === 'complete' ||
  value === 'incomplete' ||
  value === 'unknown'
    ? value
    : 'unknown'

const parseCaptureReason = (
  value: string | null,
): CommandCaptureMetadata['reason'] | undefined =>
  value === 'retention_limit' ||
  value === 'tracking_lost' ||
  value === 'runtime_boundary' ||
  value === 'tracking_unavailable' ||
  value === 'projection_ambiguous' ||
  value === 'record_expired'
    ? value
    : undefined

export class AgentCommandRepository {
  constructor(
    private readonly db: DatabaseHandle,
    private readonly limits: AgentCommandRetentionLimits,
  ) {}

  /** Upsert records with their output. Must run inside the caller's transaction. */
  apply(records: readonly PersistedAgentCommandRecord[]): void {
    if (records.length === 0) return
    const upsert = this.db.prepare(
      `INSERT INTO terminal_agent_commands (${AGENT_COMMAND_COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(terminal_id, command_id) DO UPDATE SET
        command = excluded.command,
        status = excluded.status,
        execution_state = excluded.execution_state,
        exit_code = excluded.exit_code,
        runtime_boundary = excluded.runtime_boundary,
        outcome_unknown = excluded.outcome_unknown,
        terminal_status = excluded.terminal_status,
        start_offset = excluded.start_offset,
        end_offset = excluded.end_offset,
        activity_end_offset = excluded.activity_end_offset,
        started_at = excluded.started_at,
        ended_at = excluded.ended_at,
        capture_state = excluded.capture_state,
        capture_reason = excluded.capture_reason,
        observed_utf8_bytes = excluded.observed_utf8_bytes,
        retained_utf8_bytes = excluded.retained_utf8_bytes,
        available_line_count = excluded.available_line_count,
        capture_revision = excluded.capture_revision,
        terminal_controls_observed = excluded.terminal_controls_observed`,
    )
    const deleteCapture = this.db.prepare(
      `DELETE FROM terminal_agent_command_captures
        WHERE terminal_id = ? AND command_id = ?`,
    )
    const insertCapture = this.db.prepare(
      `INSERT INTO terminal_agent_command_captures
       (terminal_id, command_id, chunk_sequence, data, utf8_bytes)
       VALUES (?, ?, ?, ?, ?)`,
    )

    for (const record of records) {
      upsert.run(
        record.terminalId,
        record.commandId,
        record.command,
        record.status,
        record.executionState,
        record.exitCode ?? null,
        record.runtimeBoundary ? 1 : 0,
        record.outcomeUnknown ? 1 : 0,
        record.terminalStatus ?? null,
        record.startOffset,
        record.endOffset ?? null,
        record.activityEndOffset ?? null,
        record.startedAt,
        record.endedAt ?? null,
        record.capture.state,
        record.capture.reason ?? null,
        record.capture.observedUtf8Bytes,
        record.capture.retainedUtf8Bytes,
        record.capture.availableLineCount,
        record.capture.revision,
        record.capture.terminalControlsObserved ? 1 : 0,
      )
      deleteCapture.run(record.terminalId, record.commandId)
      splitUtf8Bounded(record.output, CAPTURE_CHUNK_MAX_UTF8_BYTES).forEach(
        (chunk, sequence) => {
          insertCapture.run(
            record.terminalId,
            record.commandId,
            sequence,
            chunk,
            utf8ByteLength(chunk),
          )
        },
      )
    }
  }

  /** Must run inside the caller's transaction. */
  delete(keys: ReadonlyArray<{ terminalId: string; commandId: string }>): void {
    if (keys.length === 0) return
    const statement = this.db.prepare(
      'DELETE FROM terminal_agent_commands WHERE terminal_id = ? AND command_id = ?',
    )
    for (const key of keys) statement.run(key.terminalId, key.commandId)
  }

  get(
    terminalId: string,
    commandId: string,
  ): PersistedAgentCommandRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT ${AGENT_COMMAND_COLUMNS}
           FROM terminal_agent_commands
          WHERE terminal_id = ? AND command_id = ?`,
      )
      .get(terminalId, commandId) as AgentCommandRow | undefined
    return row ? this.toRecord(row) : undefined
  }

  /** Newest first. */
  list(terminalId: string): PersistedAgentCommandRecord[] {
    const rows = this.db
      .prepare(
        `SELECT ${AGENT_COMMAND_COLUMNS}
           FROM terminal_agent_commands
          WHERE terminal_id = ?
          ORDER BY started_at DESC, command_id DESC`,
      )
      .all(terminalId) as AgentCommandRow[]
    return rows.map((row) => this.toRecord(row))
  }

  /** Metadata-only existence check; captured output is not read. */
  has(terminalId: string, commandId: string): boolean {
    return (
      this.db
        .prepare(
          `SELECT 1 FROM terminal_agent_commands
            WHERE terminal_id = ? AND command_id = ?`,
        )
        .get(terminalId, commandId) !== undefined
    )
  }

  /** Metadata of the newest command; captured output is not read. */
  getLatestSummary(terminalId: string): AgentCommandSummary | undefined {
    const row = this.db
      .prepare(
        `SELECT command, exit_code
           FROM terminal_agent_commands
          WHERE terminal_id = ?
          ORDER BY started_at DESC, command_id DESC
          LIMIT 1`,
      )
      .get(terminalId) as { command: string; exit_code: number | null } | undefined
    if (!row) return undefined
    return {
      command: row.command,
      ...(row.exit_code !== null ? { exitCode: row.exit_code } : {}),
    }
  }

  /**
   * Apply the shared retention policy across all terminals: expire the oldest
   * finished captures into output-less tombstones while over the byte or
   * record budget, then delete the oldest tombstones beyond their limit.
   * The full scan runs only when an aggregate check shows a budget exceeded.
   */
  prune(): void {
    const totals = this.db
      .prepare(
        `SELECT
           COALESCE(SUM(MAX(retained_utf8_bytes, 0)), 0) AS retained_bytes,
           COALESCE(SUM(retained_utf8_bytes > 0), 0) AS capture_records,
           COALESCE(SUM(retained_utf8_bytes = 0 AND status != 'running'), 0) AS tombstones
         FROM terminal_agent_commands`,
      )
      .get() as {
      retained_bytes: number
      capture_records: number
      tombstones: number
    }
    const overCaptureBudget =
      totals.retained_bytes > this.limits.captureBudgetBytes ||
      totals.capture_records > this.limits.captureMaxRecords
    if (overCaptureBudget) {
      this.expireOldestCaptures(totals.retained_bytes, totals.capture_records)
    }
    if (
      overCaptureBudget ||
      totals.tombstones > this.limits.tombstoneMaxRecords
    ) {
      this.deleteOldestTombstones()
    }
  }

  /** A runtime that ended while a command was running has no outcome. */
  recoverInterrupted(terminalId: string, now: number): void {
    this.db
      .prepare(
        `UPDATE terminal_agent_commands
            SET status = 'aborted', execution_state = 'outcome_unknown',
                runtime_boundary = 1, outcome_unknown = 1,
                terminal_status = ?, ended_at = ?,
                capture_state = CASE
                  WHEN capture_state = 'in_progress' THEN 'unknown'
                  ELSE capture_state
                END,
                capture_reason = CASE
                  WHEN capture_state = 'in_progress' THEN 'runtime_boundary'
                  ELSE capture_reason
                END,
                capture_revision = capture_revision + 1
          WHERE terminal_id = ? AND execution_state = 'running'`,
      )
      .run(INTERRUPTED_TERMINAL_STATUS, now, terminalId)
  }

  deleteAll(): void {
    this.db.exec(`
      DELETE FROM terminal_agent_command_captures;
      DELETE FROM terminal_agent_commands;
    `)
  }

  private expireOldestCaptures(
    retainedBytes: number,
    captureRecords: number,
  ): void {
    const rows = this.db
      .prepare(
        `SELECT terminal_id, command_id, retained_utf8_bytes
           FROM terminal_agent_commands
          WHERE status != 'running' AND retained_utf8_bytes > 0
          ORDER BY COALESCE(ended_at, started_at) ASC, command_id ASC`,
      )
      .all() as Array<{
      terminal_id: string
      command_id: string
      retained_utf8_bytes: number
    }>
    const deleteCapture = this.db.prepare(
      `DELETE FROM terminal_agent_command_captures
        WHERE terminal_id = ? AND command_id = ?`,
    )
    const expireRecord = this.db.prepare(
      `UPDATE terminal_agent_commands
          SET capture_state = 'unknown', capture_reason = 'record_expired',
              retained_utf8_bytes = 0, available_line_count = 0,
              capture_revision = capture_revision + 1
        WHERE terminal_id = ? AND command_id = ?`,
    )
    for (const row of rows) {
      if (
        retainedBytes <= this.limits.captureBudgetBytes &&
        captureRecords <= this.limits.captureMaxRecords
      ) {
        break
      }
      deleteCapture.run(row.terminal_id, row.command_id)
      expireRecord.run(row.terminal_id, row.command_id)
      retainedBytes -= row.retained_utf8_bytes
      captureRecords = Math.max(0, captureRecords - 1)
    }
  }

  private deleteOldestTombstones(): void {
    const tombstones = this.db
      .prepare(
        `SELECT terminal_id, command_id
           FROM terminal_agent_commands
          WHERE retained_utf8_bytes = 0
            AND status != 'running'
          ORDER BY COALESCE(ended_at, started_at) ASC, command_id ASC`,
      )
      .all() as Array<{ terminal_id: string; command_id: string }>
    const excess = tombstones.length - this.limits.tombstoneMaxRecords
    if (excess <= 0) return
    this.delete(
      tombstones.slice(0, excess).map((row) => ({
        terminalId: row.terminal_id,
        commandId: row.command_id,
      })),
    )
  }

  private readCapture(terminalId: string, commandId: string): string {
    const rows = this.db
      .prepare(
        `SELECT data
           FROM terminal_agent_command_captures
          WHERE terminal_id = ? AND command_id = ?
          ORDER BY chunk_sequence ASC`,
      )
      .all(terminalId, commandId) as Array<{ data: string }>
    return rows.map((row) => row.data).join('')
  }

  private toRecord(row: AgentCommandRow): PersistedAgentCommandRecord {
    const reason = parseCaptureReason(row.capture_reason)
    return {
      commandId: row.command_id,
      terminalId: row.terminal_id,
      command: row.command,
      status: parseCommandStatus(row.status),
      executionState: parseExecutionState(row.execution_state),
      ...(row.exit_code !== null ? { exitCode: row.exit_code } : {}),
      runtimeBoundary: row.runtime_boundary === 1,
      outcomeUnknown: row.outcome_unknown === 1,
      ...(row.terminal_status ? { terminalStatus: row.terminal_status } : {}),
      startOffset: row.start_offset,
      ...(row.end_offset !== null ? { endOffset: row.end_offset } : {}),
      ...(row.activity_end_offset !== null
        ? { activityEndOffset: row.activity_end_offset }
        : {}),
      startedAt: row.started_at,
      ...(row.ended_at !== null ? { endedAt: row.ended_at } : {}),
      capture: {
        state: parseCaptureState(row.capture_state),
        ...(reason ? { reason } : {}),
        observedUtf8Bytes: Math.max(0, row.observed_utf8_bytes),
        retainedUtf8Bytes: Math.max(0, row.retained_utf8_bytes),
        availableLineCount: Math.max(0, row.available_line_count),
        revision: Math.max(0, row.capture_revision),
        terminalControlsObserved: row.terminal_controls_observed === 1,
      },
      output: this.readCapture(row.terminal_id, row.command_id),
    }
  }
}
