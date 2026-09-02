import {
  mapChatMessagesToStoredMessages,
  mapStoredMessagesToChatMessages,
  type BaseMessage,
} from '@langchain/core/messages'
import {
  encodeTerminalScopedFilePath,
  hasTerminalScopedFilePathPrefix,
  parseTerminalScopedFilePath,
} from '../terminalScopedFilePath'

export interface TerminalReferenceMigrationResolver {
  resolveExactTerminalId(reference: string): string | null
  resolveLegacyTerminalReference(reference: string): string | null
}

/** Runtime terminal IDs reject control characters, so this can never resolve. */
export const UNRESOLVED_LEGACY_TERMINAL_ID =
  '\u0000gyshell-unresolved-legacy-terminal-reference'

const SINGLE_TERMINAL_TOOLS = new Set([
  'exec_command',
  'read_terminal_tab',
  'read_command_output',
  'read_file',
  'write_stdin',
  'reconnect_terminal_tab',
  'close_terminal_tab',
  'write_file',
  'edit_file',
  'create_or_edit',
  'write_and_edit',
  'wait_terminal_idle',
])

const FILE_TOOLS = new Set([
  'read_file',
  'write_file',
  'edit_file',
  'create_or_edit',
  'write_and_edit',
])

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const hasOwn = (value: Record<string, unknown>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key)

const resolveLegacyValue = (
  value: unknown,
  resolver: TerminalReferenceMigrationResolver,
): string | null =>
  typeof value === 'string'
    ? resolver.resolveLegacyTerminalReference(value)
    : null

const resolveCompatibleFields = (params: {
  args: Record<string, unknown>
  canonicalField: string
  legacyField: string
  resolver: TerminalReferenceMigrationResolver
}): string => {
  const { args, canonicalField, legacyField, resolver } = params
  const legacyId = resolveLegacyValue(args[legacyField], resolver)
  if (!hasOwn(args, canonicalField)) {
    return legacyId || UNRESOLVED_LEGACY_TERMINAL_ID
  }

  const canonicalValue = args[canonicalField]
  const exactId =
    typeof canonicalValue === 'string'
      ? resolver.resolveExactTerminalId(canonicalValue)
      : null
  return exactId && legacyId && exactId === legacyId
    ? exactId
    : UNRESOLVED_LEGACY_TERMINAL_ID
}

const migrateSingleTerminalArgs = (
  toolName: string,
  args: Record<string, unknown>,
  resolver: TerminalReferenceMigrationResolver,
): boolean => {
  if (!hasOwn(args, 'tabIdOrName')) return false

  const hasCanonicalSelector = hasOwn(args, 'terminalId')
  const canonicalId =
    hasCanonicalSelector && typeof args.terminalId === 'string'
      ? resolver.resolveExactTerminalId(args.terminalId)
      : null
  const legacyId = resolveLegacyValue(args.tabIdOrName, resolver)
  const canonicalSelectorConflict =
    hasCanonicalSelector &&
    (!canonicalId || !legacyId || canonicalId !== legacyId)
  let terminalId = resolveCompatibleFields({
    args,
    canonicalField: 'terminalId',
    legacyField: 'tabIdOrName',
    resolver,
  })

  if (FILE_TOOLS.has(toolName) && typeof args.filePath === 'string') {
    const scoped = parseTerminalScopedFilePath(args.filePath)
    if (scoped) {
      const scopedTerminalId = resolver.resolveLegacyTerminalReference(
        scoped.terminalId,
      )
      if (
        !scopedTerminalId ||
        canonicalSelectorConflict ||
        (canonicalId && canonicalId !== scopedTerminalId)
      ) {
        terminalId = UNRESOLVED_LEGACY_TERMINAL_ID
      } else {
        // Legacy executors treated a valid file scope as authoritative. Keep
        // that historical target while rewriting the scope to its exact ID.
        terminalId = scopedTerminalId
        args.filePath = encodeTerminalScopedFilePath(
          scopedTerminalId,
          scoped.filePath,
        )
      }
    } else if (hasTerminalScopedFilePathPrefix(args.filePath)) {
      // Preserve malformed metadata only in the request copy. The canonical
      // executor recognizes the prefix and rejects it before filesystem I/O.
    }
  }

  delete args.tabIdOrName
  args.terminalId = terminalId
  return true
}

const migrateCopyArgs = (
  args: Record<string, unknown>,
  resolver: TerminalReferenceMigrationResolver,
): boolean => {
  let changed = false
  for (const [canonicalField, legacyField] of [
    ['sourceTerminalId', 'sourceTabIdOrName'],
    ['targetTerminalId', 'targetTabIdOrName'],
  ] as const) {
    if (!hasOwn(args, legacyField)) continue
    args[canonicalField] = resolveCompatibleFields({
      args,
      canonicalField,
      legacyField,
      resolver,
    })
    delete args[legacyField]
    changed = true
  }
  return changed
}

const migrateArgs = (
  toolName: string,
  rawArgs: unknown,
  resolver: TerminalReferenceMigrationResolver,
): { value: unknown; changed: boolean } => {
  const acceptsLegacyTerminalFields =
    SINGLE_TERMINAL_TOOLS.has(toolName) || toolName === 'copy_between_tabs'
  if (!acceptsLegacyTerminalFields) {
    return { value: rawArgs, changed: false }
  }

  const wasString = typeof rawArgs === 'string'
  let args: Record<string, unknown>
  if (wasString) {
    try {
      const parsed = JSON.parse(rawArgs)
      if (!isRecord(parsed)) return { value: rawArgs, changed: false }
      args = parsed
    } catch {
      if (
        rawArgs.includes('tabIdOrName') ||
        rawArgs.includes('sourceTabIdOrName') ||
        rawArgs.includes('targetTabIdOrName')
      ) {
        const fallback = SINGLE_TERMINAL_TOOLS.has(toolName)
          ? { terminalId: UNRESOLVED_LEGACY_TERMINAL_ID }
          : {
              sourceTerminalId: UNRESOLVED_LEGACY_TERMINAL_ID,
              targetTerminalId: UNRESOLVED_LEGACY_TERMINAL_ID,
            }
        return { value: JSON.stringify(fallback), changed: true }
      }
      return { value: rawArgs, changed: false }
    }
  } else if (isRecord(rawArgs)) {
    args = { ...rawArgs }
  } else {
    return { value: rawArgs, changed: false }
  }

  const changed = SINGLE_TERMINAL_TOOLS.has(toolName)
    ? migrateSingleTerminalArgs(toolName, args, resolver)
    : migrateCopyArgs(args, resolver)
  if (!changed) return { value: rawArgs, changed: false }
  return {
    value: wasString ? JSON.stringify(args) : args,
    changed: true,
  }
}

const migrateCanonicalToolCall = (
  call: unknown,
  resolver: TerminalReferenceMigrationResolver,
): boolean => {
  if (!isRecord(call)) return false
  const toolName = typeof call.name === 'string' ? call.name : ''
  const migrated = migrateArgs(toolName, call.args, resolver)
  if (!migrated.changed) return false
  call.args = migrated.value
  return true
}

const migrateRawToolCall = (
  call: unknown,
  resolver: TerminalReferenceMigrationResolver,
): boolean => {
  if (!isRecord(call) || !isRecord(call.function)) return false
  const toolName =
    typeof call.function.name === 'string' ? call.function.name : ''
  const migrated = migrateArgs(toolName, call.function.arguments, resolver)
  if (!migrated.changed) return false
  call.function.arguments = migrated.value
  return true
}

const migrateStoredMessage = (
  storedMessage: any,
  resolver: TerminalReferenceMigrationResolver,
): boolean => {
  if (storedMessage?.type !== 'ai' || !isRecord(storedMessage.data)) {
    return false
  }
  let changed = false
  for (const key of ['tool_calls', 'invalid_tool_calls', 'tool_call_chunks']) {
    const calls = storedMessage.data[key]
    if (!Array.isArray(calls)) continue
    for (const call of calls) {
      changed = migrateCanonicalToolCall(call, resolver) || changed
    }
  }

  const additionalKwargs = storedMessage.data.additional_kwargs
  if (isRecord(additionalKwargs)) {
    if (Array.isArray(additionalKwargs.tool_calls)) {
      for (const call of additionalKwargs.tool_calls) {
        changed = migrateRawToolCall(call, resolver) || changed
      }
    }
    if (isRecord(additionalKwargs.function_call)) {
      const functionCall = additionalKwargs.function_call
      const toolName =
        typeof functionCall.name === 'string' ? functionCall.name : ''
      const migrated = migrateArgs(
        toolName,
        functionCall.arguments,
        resolver,
      )
      if (migrated.changed) {
        functionCall.arguments = migrated.value
        changed = true
      }
    }
  }
  return changed
}

/**
 * Rewrites only the immutable provider-request view. Durable chat messages,
 * LangGraph state, UI history, and SQLite records remain byte-for-byte intact.
 */
export function migrateLegacyTerminalToolCallsForModelInput(
  messages: BaseMessage[],
  resolver: TerminalReferenceMigrationResolver,
): BaseMessage[] {
  if (messages.length === 0) return messages
  const storedMessages = mapChatMessagesToStoredMessages(messages) as any[]
  let changed = false
  for (const storedMessage of storedMessages) {
    changed = migrateStoredMessage(storedMessage, resolver) || changed
  }
  return changed ? mapStoredMessagesToChatMessages(storedMessages) : messages
}
