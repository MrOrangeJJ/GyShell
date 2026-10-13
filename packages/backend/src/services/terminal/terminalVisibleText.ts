// OSC / DCS / SOS / PM / APC strings, terminated by BEL or ST.
const TERMINAL_STRING_SEQUENCE_PATTERN = /\x1b[\]P^_X][\s\S]*?(?:\x07|\x1b\\)/g
const CSI_SEQUENCE_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g
// Remaining two-byte escapes (ESC 7, ESC M, ESC (B, ...).
const TWO_BYTE_ESCAPE_PATTERN = /\x1b[ -/]*[0-~]/g
// C0 controls except TAB and LF, plus DEL.
const CONTROL_CHARACTER_PATTERN = /[\x00-\x08\x0b-\x1f\x7f]/g

/**
 * Plain text of terminal display data: escape sequences and control
 * characters are removed; TAB and LF are kept so callers can split lines.
 */
export const stripTerminalControlSequences = (data: string): string =>
  data
    .replace(TERMINAL_STRING_SEQUENCE_PATTERN, '')
    .replace(CSI_SEQUENCE_PATTERN, '')
    .replace(TWO_BYTE_ESCAPE_PATTERN, '')
    .replace(CONTROL_CHARACTER_PATTERN, '')

/** True when terminal display data would leave any visible glyph on screen. */
export const hasVisibleTerminalText = (data: string): boolean =>
  /\S/.test(stripTerminalControlSequences(data))
