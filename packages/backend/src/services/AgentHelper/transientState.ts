import {
  readOpaqueNonBlankWellFormedString,
} from '@gyshell/shared'
import {
  BaseChannel,
  EmptyChannelError,
  InvalidUpdateError,
  MemorySaver,
} from '@langchain/langgraph'

/**
 * State channels whose values are only meaningful during one in-memory graph
 * execution. They must never be written to a checkpoint or a pending-write
 * record because they may contain runtime leases and other process-local data.
 */
export const TRANSIENT_GRAPH_CHANNEL_NAMES = new Set([
  'pendingToolCalls',
  'physicalRunId'
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function createNullRecord<T extends Record<string, unknown>>(): T {
  return Object.create(null) as T
}

function ensureNullRecord(
  container: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const current = container[key]
  if (isRecord(current) && Object.getPrototypeOf(current) === null) {
    return current
  }
  const replacement = createNullRecord<Record<string, unknown>>()
  if (isRecord(current)) Object.assign(replacement, current)
  container[key] = replacement
  return replacement
}

function omitTransientChannelProperties(
  value: unknown
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error('Checkpoint channel values must be a record.')
  }
  const sanitized = createNullRecord<Record<string, unknown>>()
  for (const [key, item] of Object.entries(value)) {
    if (!TRANSIENT_GRAPH_CHANNEL_NAMES.has(key)) {
      sanitized[key] = item
    }
  }
  return sanitized
}

function omitTransientChannelsFromVersionsSeen(
  value: unknown,
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error('Checkpoint versions_seen must be a record.')
  }
  const sanitized = createNullRecord<Record<string, unknown>>()
  for (const [nodeName, versions] of Object.entries(value)) {
    sanitized[nodeName] = omitTransientChannelProperties(versions)
  }
  return sanitized
}

function omitTransientGraphMetadata(
  value: unknown,
  ancestors = new WeakSet<object>(),
): unknown {
  if (Array.isArray(value)) {
    if (ancestors.has(value)) {
      throw new Error('Checkpoint metadata contains a cyclic value.')
    }
    ancestors.add(value)
    const sanitized = value.map((item) =>
      omitTransientGraphMetadata(item, ancestors),
    )
    ancestors.delete(value)
    return sanitized
  }
  if (!isRecord(value)) return value

  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return value
  if (ancestors.has(value)) {
    throw new Error('Checkpoint metadata contains a cyclic value.')
  }
  ancestors.add(value)
  const sanitized = createNullRecord<Record<string, unknown>>()
  for (const [key, item] of Object.entries(value)) {
    if (TRANSIENT_GRAPH_CHANNEL_NAMES.has(key)) continue
    sanitized[key] = omitTransientGraphMetadata(item, ancestors)
  }
  ancestors.delete(value)
  return sanitized
}

function requireCheckpointString(value: unknown, label: string): string {
  const exact = readOpaqueNonBlankWellFormedString(value)
  if (exact === undefined) {
    throw new Error(`${label} must be a non-blank well-formed string.`)
  }
  return exact
}

function requireWriteChannel(value: unknown): string {
  return requireCheckpointString(value, 'Checkpoint write channel')
}

/**
 * A LastValue-compatible channel which is readable by the running graph but
 * deliberately has no checkpoint representation. A new graph invocation (or
 * a checkpoint restore) therefore starts with its factory value instead of
 * inheriting an old execution queue.
 */
export class NonPersistedLastValueChannel<Value> extends BaseChannel<
  Value,
  Value,
  never
> {
  // StateGraph treats this as a LastValue-compatible annotation channel.
  lc_graph_name = 'LastValue'
  value: [Value] | [] = []

  constructor(private readonly initialValueFactory?: () => Value) {
    super()
    if (initialValueFactory) {
      this.value = [initialValueFactory()]
    }
  }

  fromCheckpoint(_checkpoint?: never): this {
    return new NonPersistedLastValueChannel<Value>(
      this.initialValueFactory,
    ) as this
  }

  update(values: Value[]): boolean {
    if (values.length === 0) return false
    if (values.length !== 1) {
      throw new InvalidUpdateError(
        'NonPersistedLastValueChannel can only receive one value per step.',
      )
    }
    this.value = [values[0]]
    return true
  }

  get(): Value {
    if (this.value.length === 0) {
      throw new EmptyChannelError(
        'NonPersistedLastValueChannel has no value for this graph step.',
      )
    }
    return this.value[0]
  }

  /**
   * Throw the same sentinel used for an empty channel so LangGraph omits this
   * value from checkpoint.channel_values. The channel remains readable in the
   * live graph through get().
   */
  checkpoint(): never {
    throw new EmptyChannelError(
      'NonPersistedLastValueChannel is intentionally not checkpointable.',
    )
  }

  isAvailable(): boolean {
    return this.value.length > 0
  }
}

/**
 * MemorySaver variant used by AgentService_v2. LangGraph stores regular node
 * writes separately from checkpoint.channel_values; filter both paths so a
 * transient queue cannot cross the serialization boundary even on an error
 * exit or a future durability-mode change.
 */
export class TransientStateMemorySaver extends MemorySaver {
  constructor(serde?: any) {
    super(serde)
    this.storage = createNullRecord()
    this.writes = createNullRecord()
  }

  override async put(
    config: any,
    checkpoint: any,
    metadata: any,
  ): Promise<any> {
    const threadId = requireCheckpointString(
      config?.configurable?.thread_id,
      'Checkpoint thread_id',
    )
    const checkpointId = requireCheckpointString(
      checkpoint?.id,
      'Checkpoint id',
    )
    if (!isRecord(checkpoint?.channel_values)) {
      throw new Error('Checkpoint channel_values must be a record.')
    }
    if (!isRecord(checkpoint?.channel_versions)) {
      throw new Error('Checkpoint channel_versions must be a record.')
    }
    if (!isRecord(checkpoint?.versions_seen)) {
      throw new Error('Checkpoint versions_seen must be a record.')
    }
    if (!isRecord(metadata)) {
      throw new Error('Checkpoint metadata must be a record.')
    }

    const checkpointNamespace =
      typeof config?.configurable?.checkpoint_ns === 'string'
        ? config.configurable.checkpoint_ns
        : ''
    const threadStorage = ensureNullRecord(this.storage as any, threadId)
    ensureNullRecord(threadStorage, checkpointNamespace)
    void checkpointId

    return await super.put(
      config,
      {
        ...checkpoint,
        channel_values: omitTransientChannelProperties(
          checkpoint.channel_values,
        ),
        channel_versions: omitTransientChannelProperties(
          checkpoint.channel_versions,
        ),
        versions_seen: omitTransientChannelsFromVersionsSeen(
          checkpoint.versions_seen,
        ),
      },
      omitTransientGraphMetadata(metadata) as any,
    )
  }

  override async putWrites(
    config: any,
    writes: any[],
    taskId: string,
  ): Promise<void> {
    const threadId = requireCheckpointString(
      config?.configurable?.thread_id,
      'Pending-write thread_id',
    )
    requireCheckpointString(taskId, 'Pending-write task id')
    requireCheckpointString(
      config?.configurable?.checkpoint_id,
      'Pending-write checkpoint_id',
    )
    if (!Array.isArray(writes)) {
      throw new Error('Pending writes must be an array.')
    }

    // Validate the complete batch before filtering or touching MemorySaver.
    // A malformed entry must never turn into a partially persisted batch.
    for (const write of writes) {
      if (!Array.isArray(write) || write.length !== 2) {
        throw new Error('Pending writes must contain [channel, value] tuples.')
      }
      requireWriteChannel(write[0])
    }

    const persistentWrites = writes.filter(
      ([channelName]) => !TRANSIENT_GRAPH_CHANNEL_NAMES.has(channelName),
    )
    if (persistentWrites.length === 0) return

    const checkpointNamespace =
      typeof config?.configurable?.checkpoint_ns === 'string'
        ? config.configurable.checkpoint_ns
        : undefined
    const outerKey = JSON.stringify([
      threadId,
      checkpointNamespace,
      config.configurable.checkpoint_id,
    ])
    ensureNullRecord(this.writes as any, outerKey)
    await super.putWrites(config, persistentWrites, taskId)
  }
}
