import {
  applyStandardSqlitePragmas,
  type DatabaseHandle,
} from '../../history/betterSqlite3Runtime'
import { TerminalPersistenceUnsupportedVersionError } from './errors'

export const TERMINAL_PERSISTENCE_SCHEMA_VERSION = 1

const SCHEMA_V1 = `
  CREATE TABLE IF NOT EXISTS terminal_history_state (
    terminal_id TEXT PRIMARY KEY,
    base_offset INTEGER NOT NULL DEFAULT 0,
    end_offset INTEGER NOT NULL DEFAULT 0,
    retained_utf8_bytes INTEGER NOT NULL DEFAULT 0,
    next_segment_sequence INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS terminal_visible_segments (
    terminal_id TEXT NOT NULL,
    segment_sequence INTEGER NOT NULL,
    start_offset INTEGER NOT NULL,
    end_offset INTEGER NOT NULL,
    data TEXT NOT NULL,
    utf8_bytes INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (terminal_id, segment_sequence),
    UNIQUE (terminal_id, start_offset, end_offset)
  );

  CREATE INDEX IF NOT EXISTS idx_terminal_visible_segments_range
    ON terminal_visible_segments(terminal_id, start_offset, end_offset);

  CREATE TABLE IF NOT EXISTS terminal_activities (
    terminal_id TEXT NOT NULL,
    activity_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    actor TEXT NOT NULL,
    origin TEXT NOT NULL,
    status TEXT NOT NULL,
    revision INTEGER NOT NULL,
    started_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    ended_at INTEGER,
    command TEXT,
    intent TEXT,
    exit_code INTEGER,
    start_offset INTEGER NOT NULL,
    end_offset INTEGER,
    runtime_generation INTEGER,
    shell_sequence INTEGER,
    session_id TEXT,
    message_id TEXT,
    PRIMARY KEY (terminal_id, activity_id)
  );

  CREATE INDEX IF NOT EXISTS idx_terminal_activities_order
    ON terminal_activities(terminal_id, started_at, activity_id);

  CREATE TABLE IF NOT EXISTS terminal_session_boundaries (
    id TEXT PRIMARY KEY,
    terminal_id TEXT NOT NULL,
    resumed_at INTEGER NOT NULL,
    offset INTEGER NOT NULL,
    last_command TEXT,
    exit_code INTEGER,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_terminal_session_boundaries_term
    ON terminal_session_boundaries(terminal_id, offset);

  CREATE TABLE IF NOT EXISTS terminal_agent_commands (
    terminal_id TEXT NOT NULL,
    command_id TEXT NOT NULL,
    command TEXT NOT NULL,
    status TEXT NOT NULL,
    execution_state TEXT NOT NULL,
    exit_code INTEGER,
    runtime_boundary INTEGER NOT NULL DEFAULT 0,
    outcome_unknown INTEGER NOT NULL DEFAULT 0,
    terminal_status TEXT,
    start_offset INTEGER NOT NULL,
    end_offset INTEGER,
    activity_end_offset INTEGER,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    capture_state TEXT NOT NULL,
    capture_reason TEXT,
    observed_utf8_bytes INTEGER NOT NULL,
    retained_utf8_bytes INTEGER NOT NULL,
    available_line_count INTEGER NOT NULL,
    capture_revision INTEGER NOT NULL,
    terminal_controls_observed INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (terminal_id, command_id)
  );

  CREATE INDEX IF NOT EXISTS idx_terminal_agent_commands_order
    ON terminal_agent_commands(terminal_id, started_at DESC, command_id DESC);

  CREATE TABLE IF NOT EXISTS terminal_agent_command_captures (
    terminal_id TEXT NOT NULL,
    command_id TEXT NOT NULL,
    chunk_sequence INTEGER NOT NULL,
    data TEXT NOT NULL,
    utf8_bytes INTEGER NOT NULL,
    PRIMARY KEY (terminal_id, command_id, chunk_sequence),
    FOREIGN KEY (terminal_id, command_id)
      REFERENCES terminal_agent_commands(terminal_id, command_id)
      ON DELETE CASCADE
  );
`

/**
 * Bring the database to TERMINAL_PERSISTENCE_SCHEMA_VERSION. Each future
 * version adds one `if (version < N)` step; steps run in order inside one
 * transaction together with the `user_version` bump.
 */
export const initializeTerminalPersistenceSchema = (
  db: DatabaseHandle,
): void => {
  applyStandardSqlitePragmas(db)

  const version = Number(db.pragma('user_version', { simple: true }) || 0)
  if (version > TERMINAL_PERSISTENCE_SCHEMA_VERSION) {
    throw new TerminalPersistenceUnsupportedVersionError(
      version,
      TERMINAL_PERSISTENCE_SCHEMA_VERSION,
    )
  }
  if (version === TERMINAL_PERSISTENCE_SCHEMA_VERSION) return

  db.transaction(() => {
    if (version < 1) db.exec(SCHEMA_V1)
    db.pragma(`user_version = ${TERMINAL_PERSISTENCE_SCHEMA_VERSION}`)
  })()
}
