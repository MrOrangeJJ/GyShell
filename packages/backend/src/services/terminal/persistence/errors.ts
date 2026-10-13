/**
 * Durable terminal data that can never be read back correctly: SQLite reports
 * file corruption, or rows violate the visible-stream invariants. Callers may
 * discard the affected history. Every other failure is treated as transient
 * and must not destroy data.
 */
export class TerminalPersistenceCorruptError extends Error {
  readonly name = 'TerminalPersistenceCorruptError'
}

/** The database was written by a newer GyShell build. Its data stays intact. */
export class TerminalPersistenceUnsupportedVersionError extends Error {
  readonly name = 'TerminalPersistenceUnsupportedVersionError'

  constructor(
    readonly version: number,
    readonly supportedVersion: number,
  ) {
    super(
      `Unsupported terminal persistence schema version ${version}; maximum supported version is ${supportedVersion}.`,
    )
  }
}

/** True for SQLite result codes that mean the file itself is unusable. */
export const isSqliteCorruptionError = (error: unknown): boolean => {
  const code = (error as { code?: unknown } | null)?.code
  return (
    typeof code === 'string' &&
    (code.startsWith('SQLITE_CORRUPT') || code === 'SQLITE_NOTADB')
  )
}

/**
 * Run a read/write operation and rethrow SQLite corruption as
 * TerminalPersistenceCorruptError so callers can tell it apart.
 */
export const classifySqliteCorruption = <T>(operation: () => T): T => {
  try {
    return operation()
  } catch (error) {
    if (isSqliteCorruptionError(error)) {
      throw new TerminalPersistenceCorruptError(
        error instanceof Error ? error.message : String(error),
      )
    }
    throw error
  }
}
