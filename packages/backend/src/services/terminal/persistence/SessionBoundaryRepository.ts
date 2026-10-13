import type { TerminalSessionBoundary } from '@gyshell/shared'
import type { DatabaseHandle } from '../../history/betterSqlite3Runtime'

type BoundaryRow = {
  id: string
  terminal_id: string
  resumed_at: number
  offset: number
  last_command: string | null
  exit_code: number | null
}

/** Resume points of restored sessions, addressed by visible-stream offset. */
export class SessionBoundaryRepository {
  constructor(private readonly db: DatabaseHandle) {}

  upsert(boundary: TerminalSessionBoundary): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO terminal_session_boundaries
           (id, terminal_id, resumed_at, offset, last_command, exit_code, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        boundary.id,
        boundary.terminalId,
        boundary.resumedAt,
        boundary.offset,
        boundary.lastCommand ?? null,
        boundary.exitCode ?? null,
        Date.now(),
      )
  }

  list(terminalId: string): TerminalSessionBoundary[] {
    const rows = this.db
      .prepare(
        `SELECT id, terminal_id, resumed_at, offset, last_command, exit_code
           FROM terminal_session_boundaries
          WHERE terminal_id = ?
          ORDER BY offset ASC, resumed_at ASC`,
      )
      .all(terminalId) as BoundaryRow[]
    return rows.map((row) => ({
      id: row.id,
      terminalId: row.terminal_id,
      resumedAt: row.resumed_at,
      offset: row.offset,
      ...(row.last_command ? { lastCommand: row.last_command } : {}),
      ...(row.exit_code !== null ? { exitCode: row.exit_code } : {}),
    }))
  }

  /** Boundaries below the retained visible window can no longer be drawn. */
  deleteBelow(terminalId: string, baseOffset: number): void {
    this.db
      .prepare(
        'DELETE FROM terminal_session_boundaries WHERE terminal_id = ? AND offset < ?',
      )
      .run(terminalId, baseOffset)
  }

  listTerminalIds(): string[] {
    return (
      this.db
        .prepare('SELECT DISTINCT terminal_id FROM terminal_session_boundaries')
        .all() as Array<{ terminal_id: string }>
    ).map((row) => row.terminal_id)
  }

  deleteTerminal(terminalId: string): void {
    this.db
      .prepare('DELETE FROM terminal_session_boundaries WHERE terminal_id = ?')
      .run(terminalId)
  }

  deleteAll(): void {
    this.db.exec('DELETE FROM terminal_session_boundaries')
  }
}
