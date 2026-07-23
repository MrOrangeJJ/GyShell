import assert from 'node:assert/strict'
import { TerminalOutputFlowController } from './TerminalOutputFlowController'

const flushMicrotasks = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
}

const runCase = async (name: string, fn: () => Promise<void>): Promise<void> => {
  await fn()
  console.log(`PASS ${name}`)
}

await runCase('holds source credit until headless and visible parsers both drain', async () => {
  const callbacks: Array<() => void> = []
  let pauses = 0
  let resumes = 0
  const controller = new TerminalOutputFlowController({
    runtimeGeneration: 7,
    chunkSize: 1024,
    highWatermark: 1024,
    lowWatermark: 200,
    writeHeadless: (_data, callback) => callbacks.push(callback),
    pauseSource: () => { pauses += 1 },
    resumeSource: () => { resumes += 1 },
    onHeadlessFailure: (error) => { throw error },
  })
  controller.attachRendererConsumer('visible')

  const first = controller.enqueue({
    sourceCost: 700,
    headlessData: 'a'.repeat(700),
    hasVisibleData: true,
  })
  const second = controller.enqueue({
    sourceCost: 700,
    headlessData: 'b'.repeat(700),
    hasVisibleData: true,
  })
  assert.equal(pauses, 1)
  assert.equal(controller.pendingCost, 1400)

  await flushMicrotasks()
  callbacks.shift()?.()
  await flushMicrotasks()
  callbacks.shift()?.()
  controller.acknowledgeRenderer('visible', first)
  assert.equal(controller.pendingCost, 700)
  assert.equal(resumes, 0)
  controller.acknowledgeRenderer('visible', second)
  assert.equal(controller.pendingCost, 0)
  assert.equal(resumes, 1)
})

await runCase('detaching an inactive visible parser releases its outstanding credit', async () => {
  const controller = new TerminalOutputFlowController({
    runtimeGeneration: 3,
    writeHeadless: (_data, callback) => callback(),
    onHeadlessFailure: (error) => { throw error },
  })
  controller.attachRendererConsumer('visible')
  controller.enqueue({
    sourceCost: 50,
    headlessData: 'output',
    hasVisibleData: true,
  })
  await flushMicrotasks()
  assert.equal(controller.pendingCost, 50)
  controller.detachRendererConsumer('visible')
  assert.equal(controller.pendingCost, 0)
})

await runCase('runtime retirement waits for queued headless and visible output', async () => {
  const callbacks: Array<() => void> = []
  const controller = new TerminalOutputFlowController({
    runtimeGeneration: 4,
    writeHeadless: (_data, callback) => callbacks.push(callback),
    onHeadlessFailure: (error) => { throw error },
  })
  controller.attachRendererConsumer('visible')
  const sequence = controller.enqueue({
    sourceCost: 128,
    headlessData: 'final output',
    hasVisibleData: true,
  })

  let settled = false
  const drained = controller.waitForDrain(1_000).then((value) => {
    settled = true
    return value
  })
  await flushMicrotasks()
  assert.equal(settled, false)
  callbacks.shift()?.()
  await flushMicrotasks()
  assert.equal(settled, false)
  controller.acknowledgeRenderer('visible', sequence)
  assert.equal(await drained, true)
})

await runCase('splits a giant logical write without breaking surrogate pairs', async () => {
  const writes: string[] = []
  const callbacks: Array<() => void> = []
  const controller = new TerminalOutputFlowController({
    runtimeGeneration: 9,
    chunkSize: 1024,
    writeHeadless: (data, callback) => {
      writes.push(data)
      callbacks.push(callback)
    },
    onHeadlessFailure: (error) => { throw error },
  })
  const source = `${'x'.repeat(1023)}😀${'y'.repeat(2200)}`
  controller.enqueue({
    sourceCost: source.length,
    headlessData: source,
    hasVisibleData: false,
  })

  while (writes.join('').length < source.length) {
    await flushMicrotasks()
    callbacks.shift()?.()
  }
  callbacks.shift()?.()
  await flushMicrotasks()
  assert.equal(writes.join(''), source)
  assert.ok(writes.every((chunk) => chunk.length <= 1024))
  assert.ok(
    writes.every((chunk) => {
      const last = chunk.charCodeAt(chunk.length - 1)
      return !(last >= 0xd800 && last <= 0xdbff)
    }),
  )
})

await runCase('drains highly fragmented output without shifting queue heads', async () => {
  const controller = new TerminalOutputFlowController({
    runtimeGeneration: 10,
    writeHeadless: (_data, callback) => callback(),
    onHeadlessFailure: (error) => { throw error },
  })
  const internal = controller as unknown as {
    frames: Array<unknown> & { shift: () => unknown }
    headlessChunks: Array<unknown> & { shift: () => unknown }
  }
  const originalFrameShift = internal.frames.shift.bind(internal.frames)
  const originalChunkShift = internal.headlessChunks.shift.bind(
    internal.headlessChunks,
  )
  let headRemovalShifts = 0
  internal.frames.shift = () => {
    headRemovalShifts += 1
    return originalFrameShift()
  }
  internal.headlessChunks.shift = () => {
    headRemovalShifts += 1
    return originalChunkShift()
  }

  for (let index = 0; index < 20_000; index += 1) {
    controller.enqueue({
      sourceCost: 1,
      headlessData: 'x',
      hasVisibleData: false,
    })
  }

  assert.equal(await controller.waitForDrain(10_000), true)
  assert.equal(controller.pendingCost, 0)
  assert.equal(headRemovalShifts, 0)
})

await runCase('isolates a synchronous headless xterm failure from the producer stack', async () => {
  let fatalCount = 0
  let pauseCount = 0
  let drainedCallbacks = 0
  const controller = new TerminalOutputFlowController({
    runtimeGeneration: 11,
    writeHeadless: () => {
      throw new Error('write data discarded, use flow control')
    },
    pauseSource: () => { pauseCount += 1 },
    onHeadlessFailure: () => { fatalCount += 1 },
  })

  assert.doesNotThrow(() => {
    controller.enqueue({
      sourceCost: 100,
      headlessData: 'unsafe',
      hasVisibleData: false,
      onHeadlessDrained: () => { drainedCallbacks += 1 },
    })
  })
  const drained = controller.waitForDrain(1_000)
  await flushMicrotasks()
  assert.equal(fatalCount, 1)
  assert.equal(pauseCount, 1)
  assert.equal(drainedCallbacks, 0)
  assert.equal(await drained, false)
})

await runCase('stops the runtime when visible publication has ambiguous partial delivery', async () => {
  let fatalCount = 0
  let pauseCount = 0
  const controller = new TerminalOutputFlowController({
    runtimeGeneration: 12,
    writeHeadless: (_data, callback) => callback(),
    pauseSource: () => { pauseCount += 1 },
    onHeadlessFailure: () => { fatalCount += 1 },
  })
  controller.attachRendererConsumer('visible-a')
  controller.attachRendererConsumer('visible-b')

  const sequence = controller.enqueue({
    sourceCost: 100,
    headlessData: 'published-to-one-renderer',
    hasVisibleData: true,
    publishVisible: () => {
      throw new Error('second renderer disappeared during broadcast')
    },
  })
  assert.equal(sequence, 1)
  await flushMicrotasks()
  assert.equal(fatalCount, 1)
  assert.equal(pauseCount, 1)
  assert.equal(controller.pendingCost, 100)
  assert.equal(await controller.waitForDrain(), false)
})

console.log('All terminal output flow controller extreme tests passed.')
