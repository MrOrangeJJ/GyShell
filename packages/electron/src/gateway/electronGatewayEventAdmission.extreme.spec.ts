import assert from 'node:assert/strict'
import {
  ELECTRON_GATEWAY_EVENT_CHANNEL,
  admitElectronGatewayAgentEvent,
  subscribeToElectronGatewayAgentEvents,
} from './electronGatewayEventAdmission'

const runCase = (name: string, fn: () => void): void => {
  fn()
  console.log(`PASS ${name}`)
}

const makeEnvelope = (overrides?: Record<string, unknown>): unknown => ({
  id: 'event-id',
  timestamp: 1_788_000_000_000,
  type: 'agent:event',
  sessionId: '  session::#🙂  ',
  payload: { type: 'say', content: 'hello' },
  ...overrides,
})

runCase('adapts gateway:event while preserving exact session identity', () => {
  const admitted = admitElectronGatewayAgentEvent(makeEnvelope())
  assert.ok(admitted)
  assert.equal(admitted.sessionId, '  session::#🙂  ')
  assert.equal(admitted.event.type, 'say')
  assert.equal(admitted.event.content, 'hello')
  assert.equal(Object.getPrototypeOf(admitted.event), null)
})

runCase('subscription uses the shared channel and drops invalid events', () => {
  const listeners = new Map<
    string,
    (event: unknown, data: unknown) => void
  >()
  const calls: Array<{ sessionId: string; type: string }> = []
  const runtime = {
    on: (
      channel: string,
      listener: (event: unknown, data: unknown) => void,
    ) => {
      listeners.set(channel, listener)
    },
    off: (
      channel: string,
      listener: (event: unknown, data: unknown) => void,
    ) => {
      if (listeners.get(channel) === listener) listeners.delete(channel)
    },
  }
  const unsubscribe = subscribeToElectronGatewayAgentEvents(
    runtime,
    (admitted) => {
      calls.push({
        sessionId: admitted.sessionId,
        type: admitted.event.type,
      })
    },
  )

  assert.deepEqual(Array.from(listeners.keys()), [
    ELECTRON_GATEWAY_EVENT_CHANNEL,
  ])
  listeners.get(ELECTRON_GATEWAY_EVENT_CHANNEL)?.(
    {},
    makeEnvelope({ type: 'session:update' }),
  )
  listeners.get(ELECTRON_GATEWAY_EVENT_CHANNEL)?.({}, makeEnvelope())
  listeners.get(ELECTRON_GATEWAY_EVENT_CHANNEL)?.(
    {},
    makeEnvelope({ payload: { type: 'rollback', messageId: 'message-1' } }),
  )
  assert.deepEqual(calls, [
    { sessionId: '  session::#🙂  ', type: 'say' },
    { sessionId: '  session::#🙂  ', type: 'rollback' },
  ])

  unsubscribe()
  assert.equal(listeners.size, 0)
})

runCase('rejects non-agent gateway events and malformed envelopes', () => {
  const malformed: unknown[] = [
    null,
    [],
    makeEnvelope({ type: 'session:update' }),
    makeEnvelope({ id: '   ' }),
    makeEnvelope({ timestamp: Number.NaN }),
    makeEnvelope({ timestamp: 'now' }),
    makeEnvelope({ sessionId: '   ' }),
    makeEnvelope({ sessionId: '\ud800' }),
    makeEnvelope({ sessionId: 7 }),
    makeEnvelope({ payload: null }),
    makeEnvelope({ payload: { type: 'unknown' } }),
    { ...(makeEnvelope() as Record<string, unknown>), extra: true },
  ]
  malformed.forEach((candidate, index) => {
    assert.equal(
      admitElectronGatewayAgentEvent(candidate),
      null,
      `malformed envelope ${index} must reject`,
    )
  })
})

runCase('rejects prototype symbol accessor and proxy traps', () => {
  const inheritedEnvelope = Object.assign(
    Object.create({ inherited: true }),
    makeEnvelope(),
  )
  const symbolEnvelope = makeEnvelope() as Record<PropertyKey, unknown>
  symbolEnvelope[Symbol('unexpected')] = true
  const ownProtoEnvelope = makeEnvelope() as Record<PropertyKey, unknown>
  Object.defineProperty(ownProtoEnvelope, '__proto__', {
    enumerable: true,
    value: 'unexpected',
  })
  const accessorEnvelope = makeEnvelope() as Record<string, unknown>
  Object.defineProperty(accessorEnvelope, 'sessionId', {
    enumerable: true,
    get: () => 'session-from-accessor',
  })
  const hostileEnvelope = new Proxy(makeEnvelope() as object, {
    ownKeys: () => {
      throw new Error('hostile envelope')
    },
  })

  const inheritedPayload = Object.assign(
    Object.create({ inherited: true }),
    { type: 'say' },
  )
  const symbolPayload = { type: 'say' } as Record<PropertyKey, unknown>
  symbolPayload[Symbol('unexpected')] = true
  const ownProtoPayload = { type: 'say' } as Record<PropertyKey, unknown>
  Object.defineProperty(ownProtoPayload, '__proto__', {
    enumerable: true,
    value: 'unexpected',
  })
  const accessorPayload = {} as Record<string, unknown>
  Object.defineProperty(accessorPayload, 'type', {
    enumerable: true,
    get: () => 'say',
  })
  const hostilePayload = new Proxy({ type: 'say' }, {
    getOwnPropertyDescriptor: () => {
      throw new Error('hostile payload')
    },
  })

  const hostileCandidates: unknown[] = [
    inheritedEnvelope,
    symbolEnvelope,
    ownProtoEnvelope,
    accessorEnvelope,
    hostileEnvelope,
    makeEnvelope({ payload: inheritedPayload }),
    makeEnvelope({ payload: symbolPayload }),
    makeEnvelope({ payload: ownProtoPayload }),
    makeEnvelope({ payload: accessorPayload }),
    makeEnvelope({ payload: hostilePayload }),
  ]
  hostileCandidates.forEach((candidate, index) => {
    assert.equal(
      admitElectronGatewayAgentEvent(candidate),
      null,
      `hostile candidate ${index} must reject`,
    )
  })
})

console.log('All Electron gateway event admission extreme tests passed.')
