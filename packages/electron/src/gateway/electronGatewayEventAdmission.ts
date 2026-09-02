import { readOpaqueNonBlankWellFormedString } from '../../../shared/src/opaqueIdentifiers'

export const ELECTRON_GATEWAY_EVENT_CHANNEL = 'gateway:event'

const GATEWAY_AGENT_EVENT_KEYS = new Set([
  'id',
  'timestamp',
  'type',
  'sessionId',
  'payload',
])

const AGENT_EVENT_TYPES = new Set([
  'say',
  'remove_message',
  'command_started',
  'command_finished',
  'command_ask',
  'tool_call',
  'file_edit',
  'file_read',
  'sub_tool_started',
  'sub_tool_delta',
  'sub_tool_finished',
  'done',
  'alert',
  'error',
  'debug_history',
  'user_input',
  'rollback',
  'compaction_boundary',
  'tokens_count',
])

type DataRecord = Record<string, unknown>

export interface AdmittedElectronGatewayAgentEvent {
  sessionId: string
  event: DataRecord & { type: string }
}

export interface ElectronGatewayEventSubscriptionRuntime {
  on(
    channel: string,
    listener: (event: unknown, data: unknown) => void,
  ): unknown
  off(
    channel: string,
    listener: (event: unknown, data: unknown) => void,
  ): unknown
}

const readDataRecord = (
  value: unknown,
  options?: { exactKeys?: ReadonlySet<string> },
): DataRecord | null => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null
  }

  try {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return null

    const keys = Reflect.ownKeys(value)
    if (
      keys.some((key) => typeof key !== 'string' || key === '__proto__') ||
      (options?.exactKeys !== undefined &&
        (keys.length !== options.exactKeys.size ||
          keys.some((key) => !options.exactKeys!.has(key as string))))
    ) {
      return null
    }

    const descriptors = Object.getOwnPropertyDescriptors(value)
    const result = Object.create(null) as DataRecord
    for (const key of keys as string[]) {
      const descriptor = descriptors[key]
      if (!descriptor || !('value' in descriptor)) return null
      result[key] = descriptor.value
    }
    return result
  } catch {
    return null
  }
}

/**
 * Admits the GatewayEvent envelope sent by ElectronWindowTransport and adapts
 * only inner agent:event messages to the legacy renderer callback shape.
 */
export const admitElectronGatewayAgentEvent = (
  value: unknown,
): AdmittedElectronGatewayAgentEvent | null => {
  const envelope = readDataRecord(value, {
    exactKeys: GATEWAY_AGENT_EVENT_KEYS,
  })
  if (!envelope || envelope.type !== 'agent:event') return null

  if (
    readOpaqueNonBlankWellFormedString(envelope.id) === undefined ||
    typeof envelope.timestamp !== 'number' ||
    !Number.isFinite(envelope.timestamp)
  ) {
    return null
  }

  const sessionId = readOpaqueNonBlankWellFormedString(envelope.sessionId)
  if (sessionId === undefined) return null

  const event = readDataRecord(envelope.payload)
  if (
    !event ||
    typeof event.type !== 'string' ||
    !AGENT_EVENT_TYPES.has(event.type)
  ) {
    return null
  }

  return {
    sessionId,
    event: event as DataRecord & { type: string },
  }
}

export const subscribeToElectronGatewayAgentEvents = (
  runtime: ElectronGatewayEventSubscriptionRuntime,
  callback: (event: AdmittedElectronGatewayAgentEvent) => void,
): (() => void) => {
  const listener = (_event: unknown, data: unknown): void => {
    const admitted = admitElectronGatewayAgentEvent(data)
    if (admitted) callback(admitted)
  }
  runtime.on(ELECTRON_GATEWAY_EVENT_CHANNEL, listener)
  return () => {
    runtime.off(ELECTRON_GATEWAY_EVENT_CHANNEL, listener)
  }
}
