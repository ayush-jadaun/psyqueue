import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { PsyQueue } from '../src/kernel.js'
import { QueueEvents } from '../src/queue-events.js'
import { redis } from '../../backend-redis/src/index.js'
import type { QueueEventData } from '../src/queue-events.js'

const REDIS = 'redis://127.0.0.1:6381'

// ─── Availability check ─────────────────────────────────────────────────────

let redisAvailable = false

beforeAll(async () => {
  try {
    const IORedis = (await import('ioredis')).default
    const Redis = (IORedis as any).default ?? IORedis
    const client = new Redis(REDIS)
    await client.ping()
    await client.quit()
    redisAvailable = true
  } catch {
    // Redis not available — tests will be skipped
  }
})

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('QueueEvents (cross-process)', () => {
  const cleanups: Array<() => Promise<void>> = []

  afterEach(async () => {
    for (const fn of cleanups.reverse()) {
      await fn().catch(() => {})
    }
    cleanups.length = 0
  })

  it('receives completed event from a different PsyQueue instance', async () => {
    if (!redisAvailable) return

    // Instance A: enqueuer
    const enqueuer = new PsyQueue()
    enqueuer.use(redis({ url: REDIS }))
    await enqueuer.start()
    cleanups.push(() => enqueuer.stop())

    // Instance B: worker
    const worker = new PsyQueue()
    worker.use(redis({ url: REDIS }))
    worker.handle('cross-complete', async () => ({ result: 42 }))
    await worker.start()
    cleanups.push(() => worker.stop())

    // QueueEvents: subscriber (could be on Server C)
    const events = new QueueEvents({ url: REDIS, queue: 'cross-complete' })
    await events.start()
    cleanups.push(() => events.stop())

    let received: QueueEventData | null = null
    events.on('completed', (data) => { received = data })

    // Enqueue from instance A
    await enqueuer.enqueue('cross-complete', { x: 1 })

    // Process on instance B
    await worker.processNext('cross-complete')

    // Wait for event delivery via Pub/Sub
    await sleep(200)

    expect(received).not.toBeNull()
    expect(received!.event).toBe('completed')
    expect(received!.jobId).toBeTruthy()
  })

  it('receives failed event when job goes to dead letter', async () => {
    if (!redisAvailable) return

    const q = new PsyQueue()
    q.use(redis({ url: REDIS }))
    q.handle('cross-fail', async () => { throw new Error('boom') })
    await q.start()
    cleanups.push(() => q.stop())

    const events = new QueueEvents({ url: REDIS, queue: 'cross-fail' })
    await events.start()
    cleanups.push(() => events.stop())

    let received: QueueEventData | null = null
    events.on('failed', (data) => { received = data })

    await q.enqueue('cross-fail', {}, { maxRetries: 1 })
    await q.processNext('cross-fail')

    await sleep(200)

    expect(received).not.toBeNull()
    expect(received!.event).toBe('failed')
    expect(received!.jobId).toBeTruthy()
    expect(received!.error).toBeTruthy()
  })

  it('wildcard listener receives all event types', async () => {
    if (!redisAvailable) return

    const q = new PsyQueue()
    q.use(redis({ url: REDIS }))
    q.handle('cross-wildcard', async () => ({ ok: true }))
    await q.start()
    cleanups.push(() => q.stop())

    const events = new QueueEvents({ url: REDIS, queue: 'cross-wildcard' })
    await events.start()
    cleanups.push(() => events.stop())

    const received: QueueEventData[] = []
    events.on('*', (data) => { received.push(data) })

    await q.enqueue('cross-wildcard', {})
    await q.processNext('cross-wildcard')

    await sleep(200)

    expect(received.length).toBeGreaterThanOrEqual(1)
    expect(received.some(d => d.event === 'completed')).toBe(true)
  })

  it('waitUntilFinished resolves with job result', async () => {
    if (!redisAvailable) return

    const q = new PsyQueue()
    q.use(redis({ url: REDIS }))
    q.handle('wait-test', async () => ({ answer: 42 }))
    await q.start()
    cleanups.push(() => q.stop())

    const events = new QueueEvents({ url: REDIS, queue: 'wait-test' })
    await events.start()
    cleanups.push(() => events.stop())

    const jobId = await q.enqueue('wait-test', {})

    // Start waiting BEFORE processing
    const resultPromise = events.waitUntilFinished(jobId, 5000)

    // Process (after a short delay to ensure listener is set up)
    await sleep(50)
    await q.processNext('wait-test')

    const result = await resultPromise
    expect(result).toBeTruthy()
  })

  it('waitUntilFinished rejects on failure', async () => {
    if (!redisAvailable) return

    const q = new PsyQueue()
    q.use(redis({ url: REDIS }))
    q.handle('wait-fail', async () => { throw new Error('boom') })
    await q.start()
    cleanups.push(() => q.stop())

    const events = new QueueEvents({ url: REDIS, queue: 'wait-fail' })
    await events.start()
    cleanups.push(() => events.stop())

    const jobId = await q.enqueue('wait-fail', {}, { maxRetries: 1 })

    const resultPromise = events.waitUntilFinished(jobId, 5000)

    await sleep(50)
    await q.processNext('wait-fail')

    await expect(resultPromise).rejects.toThrow()
  })

  it('waitUntilFinished times out', async () => {
    if (!redisAvailable) return

    const events = new QueueEvents({ url: REDIS, queue: 'timeout-test' })
    await events.start()
    cleanups.push(() => events.stop())

    await expect(events.waitUntilFinished('nonexistent', 500)).rejects.toThrow('did not finish')
  })

  it('off() removes a handler', async () => {
    if (!redisAvailable) return

    const q = new PsyQueue()
    q.use(redis({ url: REDIS }))
    q.handle('off-test', async () => ({ ok: true }))
    await q.start()
    cleanups.push(() => q.stop())

    const events = new QueueEvents({ url: REDIS, queue: 'off-test' })
    await events.start()
    cleanups.push(() => events.stop())

    let count = 0
    const handler = () => { count++ }
    events.on('completed', handler)
    events.off('completed', handler)

    await q.enqueue('off-test', {})
    await q.processNext('off-test')

    await sleep(200)

    expect(count).toBe(0)
  })

  it('stream backup stores events for reconnect catch-up', async () => {
    if (!redisAvailable) return

    const q = new PsyQueue()
    q.use(redis({ url: REDIS }))
    q.handle('stream-test', async () => ({ streamed: true }))
    await q.start()
    cleanups.push(() => q.stop())

    // Process a job to generate a stream entry
    await q.enqueue('stream-test', {})
    await q.processNext('stream-test')

    // Verify stream has entries
    const IORedis = (await import('ioredis')).default
    const Redis = (IORedis as any).default ?? IORedis
    const verifyClient = new Redis(REDIS)
    cleanups.push(async () => { await verifyClient.quit() })

    const streamLen = await verifyClient.xlen('psyqueue:stream-test:events:stream')
    expect(streamLen).toBeGreaterThanOrEqual(1)
  })
})
