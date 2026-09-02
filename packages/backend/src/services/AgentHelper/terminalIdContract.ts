import { z } from 'zod'
import { COMMAND_OUTPUT_IDENTIFIER_MAX_UTF8_BYTES } from '@gyshell/shared'
import { isValidTerminalRuntimeId } from '../terminal/terminalConnectionSupport'

const TERMINAL_ID_ERROR =
  `terminalId must be an exact current terminal ID containing 1-${COMMAND_OUTPUT_IDENTIFIER_MAX_UTF8_BYTES} UTF-8 bytes of well-formed Unicode, at least one non-whitespace character, and no control characters.`

/**
 * Agent terminal IDs are opaque runtime identities. Validation deliberately
 * makes no assumptions about UUID shape, prefixes, case, or surrounding
 * whitespace; the terminal registry performs the final exact membership check.
 */
export const terminalIdSchema = z
  .string()
  .refine(isValidTerminalRuntimeId, { message: TERMINAL_ID_ERROR })
  .describe(
    'The exact, complete terminal ID from the current Available Terminal Tabs inventory. IDs are opaque and case-sensitive; never use a tab name, prefix, shortened ID, or reconstructed ID.'
  )
