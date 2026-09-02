import { getStreamToolCallIntegrityError } from './utils/streamed_tool_call_integrity'

export type ToolCallExecutionStatus =
  | 'completed'
  | 'error'
  | 'not_executed'
  | 'cancelled'
  | 'unknown_outcome'

export interface ModelToolCall {
  id?: string
  name?: string
  args?: unknown
  [key: string]: unknown
}

export interface ToolCallExecutionMetadata {
  ordinal: number
  mode: 'execute' | 'not_executed'
  reason?: string
  retryable?: boolean
  outcomeStatus?: Exclude<ToolCallExecutionStatus, 'completed'>
  parallelGroupId?: string
  terminalRuntimeBindings?: Array<{
    terminalId: string
    runtimeGeneration: number
  }>
}

/**
 * Execution metadata is process-local control state, not model output. Keep it
 * in a WeakMap so it cannot cross JSON/LangChain serialization boundaries.
 * A non-enumerable property is installed only as a source-compatible view for
 * existing internal callers and older test fixtures.
 */
const transientExecutionMetadata = new WeakMap<
  object,
  ToolCallExecutionMetadata
>()

export function getToolCallExecutionMetadata(
  toolCall: ModelToolCall,
): ToolCallExecutionMetadata | undefined {
  if (!toolCall || typeof toolCall !== 'object') return undefined
  const existing = transientExecutionMetadata.get(toolCall)
  if (existing) return existing

  const descriptor = Object.getOwnPropertyDescriptor(
    toolCall,
    '_gyshellExecution',
  )
  const legacyValue =
    descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value')
      ? descriptor.value
      : undefined
  if (!legacyValue || typeof legacyValue !== 'object') return undefined

  const metadata = legacyValue as ToolCallExecutionMetadata
  transientExecutionMetadata.set(toolCall, metadata)
  if (descriptor?.configurable) {
    installTransientExecutionMetadataView(toolCall, metadata)
  }
  return metadata
}

export function setToolCallExecutionMetadata(
  toolCall: ModelToolCall,
  metadata: ToolCallExecutionMetadata,
): void {
  if (!toolCall || typeof toolCall !== 'object') return
  transientExecutionMetadata.set(toolCall, metadata)
  installTransientExecutionMetadataView(toolCall, metadata)
}

function installTransientExecutionMetadataView(
  toolCall: ModelToolCall,
  _metadata: ToolCallExecutionMetadata,
): void {
  const descriptor = Object.getOwnPropertyDescriptor(
    toolCall,
    '_gyshellExecution',
  )
  if (descriptor && !descriptor.configurable) return

  Object.defineProperty(toolCall, '_gyshellExecution', {
    configurable: true,
    enumerable: false,
    get: () => transientExecutionMetadata.get(toolCall),
    set: (value: unknown) => {
      if (value && typeof value === 'object') {
        transientExecutionMetadata.set(
          toolCall,
          value as ToolCallExecutionMetadata,
        )
      } else {
        transientExecutionMetadata.delete(toolCall)
      }
    },
  })
}

export interface PlannedToolCall extends ModelToolCall {
  id: string
  name: string
  /** @deprecated Use getToolCallExecutionMetadata for new code. */
  _gyshellExecution: ToolCallExecutionMetadata
}

export interface ToolCallIdRepair {
  ordinal: number
  previousId: string | null
  repairedId: string
  reason: 'empty' | 'duplicate'
}

export interface NormalizeToolCallIdsResult {
  toolCalls: ModelToolCall[]
  repairs: ToolCallIdRepair[]
}

export interface NormalizeToolCallNamesResult {
  toolCalls: ModelToolCall[]
  repairedOrdinals: number[]
}

export interface ToolBatchPlanningEnvironment {
  isToolEnabled(toolName: string): boolean
  isMcpTool(toolName: string): boolean
  isMcpToolReadOnly(toolName: string): boolean
  resolveTerminalId(reference: string): string | null
  resolveTerminalRuntimeGeneration?(reference: string): number | undefined
  resolveMachineId(reference: string): string | null
  createParallelGroupId(): string
}

const CONTEXT_BOUNDARY_TOOL_NAMES = new Set(['skill', 'create_skill'])
const MODEL_VISIBLE_SINGLE_CALL_BOUNDARY_TOOL_NAMES = new Set([
  'create_terminal_tab',
  'close_terminal_tab'
])
const EXPLICIT_READ_ONLY_TOOL_NAMES = new Set([
  'read_terminal_tab',
  'read_command_output',
  'read_file',
  'read_file_transfer_status'
])
const TERMINAL_STATE_BOUNDARY_TOOL_NAMES = new Set([
  'write_stdin',
  'reconnect_terminal_tab',
  'close_terminal_tab'
])
const SINGLE_TERMINAL_TOOL_NAMES = new Set([
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
  'wait_terminal_idle'
])
const TERMINAL_RUNTIME_BOUND_TOOL_NAMES = new Set(
  [...SINGLE_TERMINAL_TOOL_NAMES].filter(
    (toolName) => toolName !== 'read_command_output'
  )
)
const TERMINAL_MUTATION_TOOL_NAMES = new Set([
  'exec_command',
  'write_stdin',
  'reconnect_terminal_tab',
  'close_terminal_tab',
  'write_file',
  'edit_file',
  'create_or_edit',
  'write_and_edit',
  'copy_between_tabs'
])
const MAX_PARALLEL_TOOL_CALLS = 4
export const INVALID_TOOL_CALL_NAME = 'gyshell_invalid_tool_call'

function normalizeNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return normalized.length > 0 ? normalized : null
}

function preserveOpaqueNonBlankString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

function parseArgs(args: unknown): Record<string, unknown> {
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    return args as Record<string, unknown>
  }
  if (typeof args !== 'string') return {}
  try {
    const parsed = JSON.parse(args)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

function getTerminalReference(toolCall: ModelToolCall): string | null {
  if (!SINGLE_TERMINAL_TOOL_NAMES.has(toolCall.name || '')) return null
  return preserveOpaqueNonBlankString(parseArgs(toolCall.args).terminalId)
}

function getTerminalReferences(toolCall: ModelToolCall): string[] {
  const args = parseArgs(toolCall.args)
  if (toolCall.name === 'copy_between_tabs') {
    return [args.sourceTerminalId, args.targetTerminalId]
      .map(preserveOpaqueNonBlankString)
      .filter((reference): reference is string => reference !== null)
  }
  const reference = getTerminalReference(toolCall)
  return reference ? [reference] : []
}

function getTerminalIds(
  toolCall: ModelToolCall,
  environment: ToolBatchPlanningEnvironment
): string[] {
  return [
    ...new Set(
      getTerminalReferences(toolCall)
        .map((reference) => environment.resolveTerminalId(reference))
        .filter((terminalId): terminalId is string => terminalId !== null)
    )
  ]
}

export function resolveToolCallTerminalIds(
  toolCall: ModelToolCall,
  environment: ToolBatchPlanningEnvironment
): string[] {
  return getTerminalIds(toolCall, environment)
}

function captureTerminalRuntimeBindings(
  toolCall: ModelToolCall,
  environment: ToolBatchPlanningEnvironment
): Array<{ terminalId: string; runtimeGeneration: number }> {
  if (
    !TERMINAL_RUNTIME_BOUND_TOOL_NAMES.has(toolCall.name || '') ||
    !environment.resolveTerminalRuntimeGeneration
  ) {
    return []
  }
  const bindings: Array<{ terminalId: string; runtimeGeneration: number }> = []
  for (const reference of getTerminalReferences(toolCall)) {
    const terminalId = environment.resolveTerminalId(reference)
    const runtimeGeneration =
      environment.resolveTerminalRuntimeGeneration(reference)
    if (
      !terminalId ||
      !Number.isSafeInteger(runtimeGeneration) ||
      (runtimeGeneration as number) < 1 ||
      bindings.some((binding) => binding.terminalId === terminalId)
    ) {
      continue
    }
    bindings.push({
      terminalId,
      runtimeGeneration: runtimeGeneration as number
    })
  }
  return bindings
}

function isExecWaitCall(toolCall: ModelToolCall): boolean {
  if (toolCall.name !== 'exec_command') return false
  const waitMode = normalizeNonEmptyString(parseArgs(toolCall.args).waitMode)
  return waitMode !== 'nowait'
}

function isExecNowaitCall(toolCall: ModelToolCall): boolean {
  if (toolCall.name !== 'exec_command') return false
  return normalizeNonEmptyString(parseArgs(toolCall.args).waitMode) === 'nowait'
}

function isExplicitReadOnlyCall(
  toolCall: ModelToolCall,
  environment: ToolBatchPlanningEnvironment
): boolean {
  const name = toolCall.name || ''
  return (
    EXPLICIT_READ_ONLY_TOOL_NAMES.has(name) ||
    (environment.isMcpTool(name) && environment.isMcpToolReadOnly(name))
  )
}

function markNotExecuted(
  toolCall: PlannedToolCall,
  reason: string,
  options?: {
    retryable?: boolean
    outcomeStatus?: Exclude<ToolCallExecutionStatus, 'completed'>
  }
): void {
  toolCall._gyshellExecution.mode = 'not_executed'
  toolCall._gyshellExecution.reason = reason
  toolCall._gyshellExecution.retryable = options?.retryable ?? true
  if (options?.outcomeStatus) {
    toolCall._gyshellExecution.outcomeStatus = options.outcomeStatus
  }
  delete toolCall._gyshellExecution.parallelGroupId
}

function assignParallelGroup(
  calls: PlannedToolCall[],
  environment: ToolBatchPlanningEnvironment
): void {
  if (calls.length < 2) return
  const parallelGroupId = environment.createParallelGroupId()
  for (const call of calls) {
    call._gyshellExecution.parallelGroupId = parallelGroupId
  }
}

function planReadOnlyParallelGroups(
  planned: PlannedToolCall[],
  environment: ToolBatchPlanningEnvironment
): void {
  let index = 0
  while (index < planned.length) {
    if (
      planned[index]._gyshellExecution.mode !== 'execute' ||
      !isExplicitReadOnlyCall(planned[index], environment)
    ) {
      index += 1
      continue
    }

    const group: PlannedToolCall[] = []
    while (
      index < planned.length &&
      group.length < MAX_PARALLEL_TOOL_CALLS &&
      planned[index]._gyshellExecution.mode === 'execute' &&
      isExplicitReadOnlyCall(planned[index], environment)
    ) {
      group.push(planned[index])
      index += 1
    }
    assignParallelGroup(group, environment)
  }
}

function planCrossMachineExecParallelGroups(
  planned: PlannedToolCall[],
  environment: ToolBatchPlanningEnvironment
): void {
  let index = 0
  while (index < planned.length) {
    const first = planned[index]
    if (
      first._gyshellExecution.mode !== 'execute' ||
      first.name !== 'exec_command' ||
      first._gyshellExecution.parallelGroupId
    ) {
      index += 1
      continue
    }

    const group: PlannedToolCall[] = []
    const machineIds = new Set<string>()
    while (index < planned.length && group.length < MAX_PARALLEL_TOOL_CALLS) {
      const candidate = planned[index]
      if (candidate._gyshellExecution.mode !== 'execute' || candidate.name !== 'exec_command') {
        break
      }
      const reference = getTerminalReference(candidate)
      const machineId = reference ? environment.resolveMachineId(reference) : null
      if (!machineId || machineIds.has(machineId)) {
        break
      }
      group.push(candidate)
      machineIds.add(machineId)
      index += 1
    }
    assignParallelGroup(group, environment)
    if (group.length === 0) index += 1
  }
}

/**
 * Repair only protocol-invalid ids. Existing non-empty, unique ids are never
 * changed or removed.
 */
export function normalizeToolCallIds(
  toolCalls: ModelToolCall[],
  createId: () => string
): NormalizeToolCallIdsResult {
  const reservedIds = new Set(
    toolCalls
      .map((call) => preserveOpaqueNonBlankString(call.id))
      .filter((id): id is string => id !== null)
  )
  const seenIds = new Set<string>()
  const repairs: ToolCallIdRepair[] = []
  const normalized = toolCalls.map((toolCall, ordinal) => {
    // Tool-call ids are opaque protocol values. Preserve every non-empty id
    // byte-for-byte; trimming here can both corrupt an id and invent a duplicate.
    const existingId = preserveOpaqueNonBlankString(toolCall.id)
    if (existingId && !seenIds.has(existingId)) {
      seenIds.add(existingId)
      return { ...toolCall, id: existingId }
    }

    let repairedId = ''
    do {
      repairedId = `gyshell_repaired_${createId()}`
    } while (reservedIds.has(repairedId) || seenIds.has(repairedId))
    reservedIds.add(repairedId)
    seenIds.add(repairedId)
    repairs.push({
      ordinal,
      previousId: existingId,
      repairedId,
      reason: existingId ? 'duplicate' : 'empty'
    })
    return { ...toolCall, id: repairedId }
  })

  return { toolCalls: normalized, repairs }
}

/** Repair only missing/blank function names so the stored assistant message is
 * serializable while retaining the original call id and ordinal. */
export function normalizeToolCallNames(
  toolCalls: ModelToolCall[]
): NormalizeToolCallNamesResult {
  const repairedOrdinals: number[] = []
  const normalized = toolCalls.map((toolCall, ordinal) => {
    if (typeof toolCall.name === 'string' && toolCall.name.trim().length > 0) {
      return toolCall
    }
    repairedOrdinals.push(ordinal)
    return { ...toolCall, name: INVALID_TOOL_CALL_NAME }
  })
  return { toolCalls: normalized, repairedOrdinals }
}

/**
 * Recheck a planned parallel prefix immediately before dispatch. Runtime tool
 * settings, MCP annotations, terminal aliases, or machine bindings may have
 * changed since the model response was planned.
 */
export function getToolCallRuntimeBindingDriftReason(
  call: PlannedToolCall,
  environment: ToolBatchPlanningEnvironment
): string | null {
  const bindings = call._gyshellExecution?.terminalRuntimeBindings || []
  if (bindings.length === 0) return null
  if (!environment.resolveTerminalRuntimeGeneration) {
    return 'Terminal runtime binding validation is unavailable. No tool side effect was executed; re-read the current terminal inventory and replan.'
  }

  const currentTerminalIds = getTerminalIds(call, environment)
  const expectedTerminalIds = bindings.map((binding) => binding.terminalId)
  if (
    currentTerminalIds.length !== expectedTerminalIds.length ||
    expectedTerminalIds.some(
      (terminalId) => !currentTerminalIds.includes(terminalId)
    )
  ) {
    return 'A terminal selector changed after this tool batch was planned. No tool side effect was executed; re-read the current terminal inventory and replan.'
  }

  for (const binding of bindings) {
    const currentGeneration =
      environment.resolveTerminalRuntimeGeneration(binding.terminalId)
    if (currentGeneration !== binding.runtimeGeneration) {
      return `Terminal runtime terminalId=${JSON.stringify(binding.terminalId)} changed after this tool batch was planned. No tool side effect was executed; re-read the current terminal inventory and replan.`
    }
  }
  return null
}

export function isParallelToolCallPrefixStillSafe(
  calls: PlannedToolCall[],
  environment: ToolBatchPlanningEnvironment
): boolean {
  if (
    calls.length < 2 ||
    calls.some(
      (call) =>
        call._gyshellExecution.mode !== 'execute' ||
        !environment.isToolEnabled(call.name) ||
        getToolCallRuntimeBindingDriftReason(call, environment) !== null
    )
  ) {
    return false
  }

  if (calls.every((call) => call.name === 'exec_command')) {
    const machineIds = calls.map((call) => {
      const reference = getTerminalReference(call)
      return reference ? environment.resolveMachineId(reference) : null
    })
    return (
      machineIds.every((machineId): machineId is string => machineId !== null) &&
      new Set(machineIds).size === calls.length
    )
  }

  return calls.every((call) => isExplicitReadOnlyCall(call, environment))
}

/**
 * Build a conservative execution plan while preserving call order and every
 * valid model call. Unsafe calls become explicit not_executed results.
 */
export function planToolCallBatch(
  toolCalls: ModelToolCall[],
  environment: ToolBatchPlanningEnvironment
): PlannedToolCall[] {
  const planned: PlannedToolCall[] = toolCalls.map((toolCall, ordinal) => {
    const name =
      typeof toolCall.name === 'string' && toolCall.name.trim().length > 0
        ? toolCall.name
        : INVALID_TOOL_CALL_NAME
    const plannedCall = {
      ...toolCall,
      id: String(toolCall.id || ''),
      name,
    } as PlannedToolCall
    setToolCallExecutionMetadata(plannedCall, {
      ordinal,
      mode: 'execute',
    })
    return plannedCall
  })

  for (const call of planned) {
    const terminalRuntimeBindings = captureTerminalRuntimeBindings(
      call,
      environment
    )
    if (terminalRuntimeBindings.length > 0) {
      call._gyshellExecution.terminalRuntimeBindings = terminalRuntimeBindings
    }

    const integrityError = getStreamToolCallIntegrityError(call)
    if (integrityError) {
      markNotExecuted(call, integrityError.reason, {
        outcomeStatus: 'error',
        retryable: true
      })
    } else if (call.name === INVALID_TOOL_CALL_NAME) {
      markNotExecuted(
        call,
        'The model emitted a tool call with a missing or blank function name.'
      )
    } else if (!environment.isToolEnabled(call.name)) {
      markNotExecuted(call, `Tool "${call.name}" is disabled in the current GyShell configuration.`)
    }
  }

  // Terminal lifecycle changes invalidate assumptions made for the whole
  // model-produced batch. Preserve the original ordinal contract: when an
  // enabled lifecycle call appears anywhere, only ordinal zero may run. Every
  // later call remains in the protocol and receives an explicit result.
  const hasSingleCallBoundary = planned.some(
    (call) =>
      call._gyshellExecution.mode === 'execute' &&
      MODEL_VISIBLE_SINGLE_CALL_BOUNDARY_TOOL_NAMES.has(call.name)
  )
  if (hasSingleCallBoundary) {
    for (let index = 1; index < planned.length; index += 1) {
      const call = planned[index]
      if (call._gyshellExecution.mode === 'execute') {
        markNotExecuted(
          call,
          'The batch contains an enabled terminal lifecycle tool; only the first call may run before the model observes that result.'
        )
      }
    }
  }

  const contextBoundary = planned.find(
    (call) =>
      call._gyshellExecution.mode === 'execute' && CONTEXT_BOUNDARY_TOOL_NAMES.has(call.name)
  )
  if (contextBoundary) {
    for (const call of planned) {
      if (call !== contextBoundary && call._gyshellExecution.mode === 'execute') {
        markNotExecuted(
          call,
          `The batch contains context-changing tool "${contextBoundary.name}" (${contextBoundary.id}); this call must be replanned after that result is visible to the model.`
        )
      }
    }
  }

  for (let execIndex = 0; execIndex < planned.length; execIndex += 1) {
    const execCall = planned[execIndex]
    if (execCall._gyshellExecution.mode !== 'execute' || !isExecWaitCall(execCall)) {
      continue
    }
    const execReference = getTerminalReference(execCall)
    const execTerminalId = execReference ? environment.resolveTerminalId(execReference) : null
    if (!execTerminalId) continue

    const stdinCall = planned.slice(execIndex + 1).find((candidate) => {
      if (candidate._gyshellExecution.mode !== 'execute' || candidate.name !== 'write_stdin') {
        return false
      }
      const reference = getTerminalReference(candidate)
      return reference !== null && environment.resolveTerminalId(reference) === execTerminalId
    })
    if (!stdinCall) continue

    const reason = `Synchronous exec_command "${execCall.id}" and later write_stdin "${stdinCall.id}" target the same terminal and would deadlock when executed in call order. Reissue the command with waitMode="nowait" before sending input.`
    markNotExecuted(execCall, reason)
    markNotExecuted(stdinCall, reason)
  }

  const terminalBoundaries = new Map<string, PlannedToolCall>()
  const targetFileReadBoundaries = new Map<string, PlannedToolCall>()
  for (const call of planned) {
    const terminalIds = getTerminalIds(call, environment)
    if (terminalIds.length === 0) continue

    const earlierBoundary = terminalIds
      .map((terminalId) => terminalBoundaries.get(terminalId))
      .find((boundary): boundary is PlannedToolCall => boundary !== undefined)
    const earlierTargetFileReadBoundary = terminalIds
      .map((terminalId) => targetFileReadBoundaries.get(terminalId))
      .find((boundary): boundary is PlannedToolCall => boundary !== undefined)
    if (
      earlierTargetFileReadBoundary &&
      call._gyshellExecution.mode === 'execute' &&
      call.name === 'read_file'
    ) {
      markNotExecuted(
        call,
        `Background transfer "${earlierTargetFileReadBoundary.id}" may still be writing this terminal; read_file must be replanned after transfer status is terminal.`
      )
    }
    if (
      earlierBoundary &&
      call._gyshellExecution.mode === 'execute' &&
      TERMINAL_MUTATION_TOOL_NAMES.has(call.name)
    ) {
      markNotExecuted(
        call,
        `Earlier state-changing tool "${earlierBoundary.name}" (${earlierBoundary.id}) targets the same terminal; this mutation must be replanned after its outcome is visible.`
      )
    }

    const createsBoundary =
      (call._gyshellExecution.mode === 'not_executed' &&
        TERMINAL_MUTATION_TOOL_NAMES.has(call.name)) ||
      TERMINAL_STATE_BOUNDARY_TOOL_NAMES.has(call.name) ||
      isExecNowaitCall(call) ||
      call.name === 'copy_between_tabs'
    if (createsBoundary) {
      for (const terminalId of terminalIds) {
        if (!terminalBoundaries.has(terminalId)) {
          terminalBoundaries.set(terminalId, call)
        }
      }
    }
    if (call.name === 'copy_between_tabs') {
      const args = parseArgs(call.args)
      const targetReference = preserveOpaqueNonBlankString(args.targetTerminalId)
      const targetTerminalId = targetReference
        ? environment.resolveTerminalId(targetReference)
        : null
      if (targetTerminalId && !targetFileReadBoundaries.has(targetTerminalId)) {
        targetFileReadBoundaries.set(targetTerminalId, call)
      }
    }
  }

  planReadOnlyParallelGroups(planned, environment)
  planCrossMachineExecParallelGroups(planned, environment)
  return planned
}

/**
 * A wait-mode command can become asynchronous at runtime (action policy, UI
 * skip, or timeout). Defer later mutations on that terminal once this occurs.
 */
export function deferTerminalMutationsAfterRuntimeBoundary(
  calls: PlannedToolCall[],
  terminalId: string,
  boundaryCall: PlannedToolCall,
  environment: ToolBatchPlanningEnvironment
): void {
  for (const call of calls) {
    if (
      call._gyshellExecution.mode !== 'execute' ||
      !TERMINAL_MUTATION_TOOL_NAMES.has(call.name) ||
      !getTerminalIds(call, environment).includes(terminalId)
    ) {
      continue
    }
    markNotExecuted(
      call,
      `Command "${boundaryCall.id}" is still running on the same terminal; this mutation must be replanned after its outcome is visible.`
    )
  }
}

export function getParallelToolCallPrefix(queue: PlannedToolCall[]): PlannedToolCall[] {
  const groupId = queue[0]?._gyshellExecution.parallelGroupId
  if (!groupId) return []
  const group: PlannedToolCall[] = []
  for (const call of queue) {
    if (call._gyshellExecution.parallelGroupId !== groupId) break
    group.push(call)
  }
  return group.length >= 2 ? group : []
}

export function createSyntheticToolOutcomeContent(input: {
  status: Exclude<ToolCallExecutionStatus, 'completed'>
  reason: string
  retryable: boolean
}): string {
  return JSON.stringify({
    status: input.status,
    reason: input.reason,
    retryable: input.retryable
  })
}
