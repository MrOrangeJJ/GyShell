import type { DatabaseHandle } from '../../history/betterSqlite3Runtime'
import { utf8ByteLength } from '../utf8Text'
import { TerminalPersistenceCorruptError } from './errors'

/**
 * A contiguous slice of one terminal's visible stream. Offsets are JavaScript
 * UTF-16 code units so they match renderer snapshots; UTF-8 byte counts are
 * used only for storage budgets.
 */
export interface VisibleSegment {
  terminalId: string
  startOffset: number
  endOffset: number
  data: string
  utf8Bytes: number
  createdAt: number
}

export interface VisibleHistoryTail {
  data: string
  startOffset: number
  endOffset: number
}

export interface VisibleHistoryLimits {
  maxUtf8Bytes: number
  maxSegments: number
}

type HistoryStateRow = {
  terminal_id: string
  base_offset: number
  end_offset: number
  retained_utf8_bytes: number
  next_segment_sequence: number
}

type SegmentRow = {
  start_offset: number
  end_offset: number
  data: string
}

type Discontinuity =
  | { kind: 'skip' }
  | { kind: 'append-tail'; segment: VisibleSegment }
  | { kind: 'rewind' }
  | { kind: 'gap' }

export interface VisibleSegmentsApplyResult {
  /** Terminals whose stream discontinuity invalidated offset-based metadata. */
  rewoundTerminalIds: Set<string>
}

/**
 * Durable visible stream per terminal: `terminal_history_state` holds the
 * retained window [base_offset, end_offset) and `terminal_visible_segments`
 * holds its contiguous segments in `segment_sequence` order.
 */
export class VisibleHistoryRepository {
  constructor(
    private readonly db: DatabaseHandle,
    private readonly limits: VisibleHistoryLimits,
  ) {}

  /** Append segments. Must run inside the caller's transaction. */
  applySegments(segments: readonly VisibleSegment[]): VisibleSegmentsApplyResult {
    const rewoundTerminalIds = new Set<string>()
    if (segments.length === 0) return { rewoundTerminalIds }

    const insertSegment = this.db.prepare(
      `INSERT OR IGNORE INTO terminal_visible_segments
       (terminal_id, segment_sequence, start_offset, end_offset, data,
        utf8_bytes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    const upsertState = this.db.prepare(
      `INSERT INTO terminal_history_state
       (terminal_id, base_offset, end_offset, retained_utf8_bytes,
        next_segment_sequence, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(terminal_id) DO UPDATE SET
        base_offset = excluded.base_offset,
        end_offset = excluded.end_offset,
        retained_utf8_bytes = excluded.retained_utf8_bytes,
        next_segment_sequence = excluded.next_segment_sequence,
        updated_at = excluded.updated_at`,
    )
    const stateByTerminal = new Map<string, HistoryStateRow>()

    for (const segment of segments) {
      let state =
        stateByTerminal.get(segment.terminalId) ??
        this.readState(segment.terminalId) ?? {
          terminal_id: segment.terminalId,
          base_offset: segment.startOffset,
          end_offset: segment.startOffset,
          retained_utf8_bytes: 0,
          next_segment_sequence: 0,
        }

      // The in-memory visible stream is authoritative. A discontinuity means
      // the durable copy no longer describes it (a dropped batch, a restore
      // that reset the buffer, ...). Never throw here: a throwing segment
      // would roll back and re-fail every later flush for every terminal.
      // Instead classify and repair the durable history.
      let effective = segment
      if (segment.startOffset !== state.end_offset) {
        const resolution = this.resolveDiscontinuity(state, segment)
        if (resolution.kind === 'skip') {
          stateByTerminal.set(segment.terminalId, state)
          continue
        }
        if (resolution.kind === 'append-tail') {
          effective = resolution.segment
        } else {
          console.warn(
            `[TerminalPersistenceStore] Visible history ${resolution.kind} for terminal ${segment.terminalId}: durable end ${state.end_offset}, stream offset ${segment.startOffset}. Rebasing durable history.`,
          )
          state = this.rebase(state, segment.startOffset)
          if (resolution.kind === 'rewind' || resolution.kind === 'gap') {
            rewoundTerminalIds.add(segment.terminalId)
          }
        }
      }

      insertSegment.run(
        effective.terminalId,
        state.next_segment_sequence,
        effective.startOffset,
        effective.endOffset,
        effective.data,
        effective.utf8Bytes,
        effective.createdAt,
      )
      state = {
        ...state,
        end_offset: effective.endOffset,
        retained_utf8_bytes: state.retained_utf8_bytes + effective.utf8Bytes,
        next_segment_sequence: state.next_segment_sequence + 1,
      }
      upsertState.run(
        state.terminal_id,
        state.base_offset,
        state.end_offset,
        state.retained_utf8_bytes,
        state.next_segment_sequence,
        effective.createdAt,
      )
      stateByTerminal.set(segment.terminalId, state)
    }
    return { rewoundTerminalIds }
  }

  /**
   * Drop the oldest segments of the given terminals while they exceed the
   * byte or segment budget. Returns the retained base offset of every
   * terminal whose window moved.
   */
  prune(terminalIds: Iterable<string>): Map<string, number> {
    const movedBaseOffsets = new Map<string, number>()
    const countSegments = this.db.prepare(
      'SELECT COUNT(*) AS count FROM terminal_visible_segments WHERE terminal_id = ?',
    )
    const selectSegments = this.db.prepare(
      `SELECT segment_sequence, start_offset, utf8_bytes
         FROM terminal_visible_segments
        WHERE terminal_id = ?
        ORDER BY segment_sequence ASC`,
    )
    const deleteSegment = this.db.prepare(
      `DELETE FROM terminal_visible_segments
        WHERE terminal_id = ? AND segment_sequence = ?`,
    )
    const updateState = this.db.prepare(
      `UPDATE terminal_history_state
          SET base_offset = ?, retained_utf8_bytes = ?, updated_at = ?
        WHERE terminal_id = ?`,
    )
    const now = Date.now()

    for (const terminalId of terminalIds) {
      const state = this.readState(terminalId)
      if (!state) continue
      const { count } = countSegments.get(terminalId) as { count: number }
      if (
        state.retained_utf8_bytes <= this.limits.maxUtf8Bytes &&
        count <= this.limits.maxSegments
      ) {
        continue
      }

      const rows = selectSegments.all(terminalId) as Array<{
        segment_sequence: number
        start_offset: number
        utf8_bytes: number
      }>
      let retainedBytes = state.retained_utf8_bytes
      let retainedCount = rows.length
      let index = 0
      while (
        index < rows.length &&
        (retainedBytes > this.limits.maxUtf8Bytes ||
          retainedCount > this.limits.maxSegments)
      ) {
        deleteSegment.run(terminalId, rows[index].segment_sequence)
        retainedBytes = Math.max(0, retainedBytes - rows[index].utf8_bytes)
        retainedCount -= 1
        index += 1
      }
      const baseOffset =
        index < rows.length ? rows[index].start_offset : state.end_offset
      updateState.run(baseOffset, retainedBytes, now, terminalId)
      if (baseOffset !== state.base_offset) {
        movedBaseOffsets.set(terminalId, baseOffset)
      }
    }
    return movedBaseOffsets
  }

  /**
   * Read the newest `maxCharacters` of the retained stream, newest segments
   * first so a large history is never loaded whole. Throws
   * TerminalPersistenceCorruptError when rows violate stream invariants.
   */
  readTail(terminalId: string, maxCharacters: number): VisibleHistoryTail {
    const requestedCharacters = Number.isFinite(maxCharacters)
      ? Math.max(0, Math.floor(maxCharacters))
      : 0;
    const state = this.readState(terminalId);
    const segmentsNewestFirst = this.db.prepare(
      `SELECT start_offset, end_offset, data
         FROM terminal_visible_segments
        WHERE terminal_id = ?
        ORDER BY segment_sequence DESC`,
    );
    if (!state) {
      if (segmentsNewestFirst.get(terminalId)) {
        throw new TerminalPersistenceCorruptError(
          `Visible history of terminal ${terminalId} has segments but no stream state.`,
        );
      }
      return { data: '', startOffset: 0, endOffset: 0 };
    }
    if (requestedCharacters === 0) {
      let expectedEndOffset = state.end_offset
      for (const row of segmentsNewestFirst.iterate(terminalId) as Iterable<SegmentRow>) {
        if (
          row.end_offset !== expectedEndOffset ||
          row.data.length !== row.end_offset - row.start_offset
        ) {
          throw new TerminalPersistenceCorruptError(
            `Visible history of terminal ${terminalId} is not contiguous at offset ${row.end_offset} (expected ${expectedEndOffset}).`,
          )
        }
        expectedEndOffset = row.start_offset
      }
      if (expectedEndOffset !== state.base_offset) {
        throw new TerminalPersistenceCorruptError(
          `Visible history of terminal ${terminalId} starts at ${expectedEndOffset} but its retained window starts at ${state.base_offset}.`,
        )
      }
      return {
        data: '',
        startOffset: state.end_offset,
        endOffset: state.end_offset,
      };
    }

    const collected: SegmentRow[] = []
    let collectedCharacters = 0
    let expectedEndOffset = state.end_offset
    for (const row of segmentsNewestFirst.iterate(terminalId) as Iterable<SegmentRow>) {
      if (
        row.end_offset !== expectedEndOffset ||
        row.data.length !== row.end_offset - row.start_offset
      ) {
        throw new TerminalPersistenceCorruptError(
          `Visible history of terminal ${terminalId} is not contiguous at offset ${row.end_offset} (expected ${expectedEndOffset}).`,
        )
      }
      collected.push(row)
      collectedCharacters += row.data.length
      expectedEndOffset = row.start_offset
      if (collectedCharacters >= requestedCharacters) break
    }
    if (collectedCharacters < requestedCharacters && expectedEndOffset !== state.base_offset) {
      throw new TerminalPersistenceCorruptError(
        `Visible history of terminal ${terminalId} starts at ${expectedEndOffset} but its retained window starts at ${state.base_offset}.`,
      )
    }

    const content = collected
      .reverse()
      .map((row) => row.data)
      .join('')
    const data = content.slice(-requestedCharacters)
    return {
      data,
      startOffset: state.end_offset - data.length,
      endOffset: state.end_offset,
    }
  }

  readEndOffset(terminalId: string): number {
    return this.readState(terminalId)?.end_offset ?? 0
  }

  listTerminalIds(): string[] {
    return (
      this.db
        .prepare(
          `SELECT terminal_id FROM terminal_history_state
           UNION
           SELECT DISTINCT terminal_id FROM terminal_visible_segments`,
        )
        .all() as Array<{ terminal_id: string }>
    ).map((row) => row.terminal_id)
  }

  deleteTerminal(terminalId: string): void {
    this.db
      .prepare('DELETE FROM terminal_visible_segments WHERE terminal_id = ?')
      .run(terminalId)
    this.db
      .prepare('DELETE FROM terminal_history_state WHERE terminal_id = ?')
      .run(terminalId)
  }

  deleteAll(): void {
    this.db.exec(`
      DELETE FROM terminal_visible_segments;
      DELETE FROM terminal_history_state;
    `)
  }

  private readState(terminalId: string): HistoryStateRow | undefined {
    return this.db
      .prepare(
        `SELECT terminal_id, base_offset, end_offset, retained_utf8_bytes,
                next_segment_sequence
           FROM terminal_history_state
          WHERE terminal_id = ?`,
      )
      .get(terminalId) as HistoryStateRow | undefined
  }

  /**
   * Decide how a segment that does not start at the durable end offset relates
   * to the durable history:
   * - `skip`: an idempotent replay of bytes that are already stored;
   * - `append-tail`: an idempotent replay whose tail extends the history;
   * - `rewind`: the stream restarted below the durable end with different
   *   content (offsets were reused, so offset-bearing metadata is invalid);
   * - `gap`: the stream skipped ahead (an earlier batch was lost).
   */
  private resolveDiscontinuity(
    state: HistoryStateRow,
    segment: VisibleSegment,
  ): Discontinuity {
    if (segment.startOffset > state.end_offset) return { kind: 'gap' }
    // Bytes that were already pruned cannot be compared; a stream that writes
    // below the retained window is a restart, not a retry.
    if (segment.startOffset < state.base_offset) return { kind: 'rewind' }
    const overlapEnd = Math.min(segment.endOffset, state.end_offset)
    const stored = this.readRange(
      segment.terminalId,
      segment.startOffset,
      overlapEnd,
    )
    const overlapLength = overlapEnd - segment.startOffset
    if (stored !== segment.data.slice(0, overlapLength)) {
      return { kind: 'rewind' }
    }
    if (segment.endOffset <= state.end_offset) return { kind: 'skip' }
    const tail = segment.data.slice(overlapLength)
    return {
      kind: 'append-tail',
      segment: {
        ...segment,
        startOffset: state.end_offset,
        data: tail,
        utf8Bytes: utf8ByteLength(tail),
      },
    }
  }

  readRange(
    terminalId: string,
    startOffset: number,
    endOffset: number,
  ): string {
    if (endOffset <= startOffset) return ''
    const rows = this.db
      .prepare(
        `SELECT start_offset, end_offset, data
           FROM terminal_visible_segments
          WHERE terminal_id = ?
            AND end_offset > ?
            AND start_offset < ?
          ORDER BY start_offset ASC`,
      )
      .all(terminalId, startOffset, endOffset) as SegmentRow[]
    return rows
      .map((row) => {
        const left = Math.max(0, startOffset - row.start_offset)
        const right = Math.min(row.data.length, endOffset - row.start_offset)
        return right > left ? row.data.slice(left, right) : ''
      })
      .join('')
  }

  /** Drop durable segments so the history restarts contiguously at `offset`. */
  private rebase(state: HistoryStateRow, offset: number): HistoryStateRow {
    this.db
      .prepare('DELETE FROM terminal_visible_segments WHERE terminal_id = ?')
      .run(state.terminal_id)
    return {
      ...state,
      base_offset: offset,
      end_offset: offset,
      retained_utf8_bytes: 0,
    }
  }
}
