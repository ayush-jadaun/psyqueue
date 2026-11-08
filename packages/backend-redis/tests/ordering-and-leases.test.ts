import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Redis from 'ioredis'
import { RedisBackendAdapter } from '../src/adapter.js'
import { redis } from '../src/index.js'
import { PsyQueue } from '../../core/src/index.js'
import type { Job } from '@psyqueue/core'

// Must resolve at module load: describe.skipIf() is evaluated at collection time.
async function checkRedis(): Promise<boolean> {
  const client = new Redis({ lazyConnect: true, connectTimeout: 1000, maxRetriesPerRequest: 0, retryStrategy: () => null })
  try {
    await client.connect()
    await client.ping()
    return true
  } catch {
    return false
  } finally {
    client.disconnect()
  }
}
const redisAvailable = await checkRedis()

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

function makeJob(id: string, queue: string, overrides: Partial<Job> = {}): Job {
  return {
    id, queue, name: 'test-job', payload: {}, status: 'pending', priority: 0,
    maxRetries: 3, attempt: 1, backoff: 'exponential', timeout: 30000,
    createdAt: new Date(), meta: {}, ...overrides,
  }
}

async function deleteKeys(prefix: string): Promise<void> {
  const client = new Redis()
  let cursor = '0'
  do {
    const [next, keys] = await client.scan(cursor, 'MATCH', `${prefix}:*`, 'COUNT', 500)
    cursor = next
    if (keys.length > 0) await client.del(...keys)
  } while (cursor !== '0')
  await client.quit()
}

describe.skipIf(!redisAvailable)('Redis adapter – ordering, results and leases', () => {
  let adapter: RedisBackendAdapter
  const prefix = `psyqueue_order_${Date.now()}`
  const q = 'orders'

  beforeEach(async () => {
    adapter = new RedisBackendAdapter({ keyPrefix: prefix })
    await adapter.connect()
  })

  afterEach(async () => {
    await adapter.disconnect()
    await deleteKeys(prefix)
  })

  it('blockingDequeue takes the oldest job first (FIFO)', async () => {
    for (const id of ['a', 'b', 'c']) await adapter.enqueue(makeJob(id, q))
    const order: string[] = []
    for (let i = 0; i < 3; i++) order.push((await adapter.blockingDequeue(q, 1000))[0]!.id)
    expect(order).toEqual(['a', 'b', 'c'])
  })

  it('ackAndFetch hands out the oldest remaining job', async () => {
    for (const id of ['a', 'b', 'c']) await adapter.enqueue(makeJob(id, q))
    const [first] = await adapter.dequeue(q, 1)
    expect(first!.id).toBe('a')
    const { nextJob } = await adapter.ackAndFetch(first!.id, first!.completionToken, q)
    expect(nextJob!.id).toBe('b')
  })

  it('priority jobs are dequeued before normal jobs', async () => {
    await adapter.enqueue(makeJob('normal', q))
    await adapter.enqueue(makeJob('urgent', q, { priority: 10 }))
    const jobs = await adapter.dequeue(q, 2)
    expect(jobs.map(j => j.id)).toEqual(['urgent', 'normal'])
  })

  it('getJob returns the result written by ack', async () => {
    await adapter.enqueue(makeJob('r', q, { tenantId: 't1' })) // tenantId forces the packed _ext path
    const [job] = await adapter.dequeue(q, 1)
    await adapter.ack(job!.id, job!.completionToken, JSON.stringify({ sent: true }))
    expect((await adapter.getJob('r'))!.result).toEqual({ sent: true })
  })

  it('reclaims a job whose lease was not renewed', async () => {
    await adapter.enqueue(makeJob('dead-worker', q))
    await adapter.dequeue(q, 1)
    await sleep(120)
    expect(await adapter.recoverStaleJobs(q, 100)).toEqual(['dead-worker'])
    expect((await adapter.getJob('dead-worker'))!.status).toBe('pending')
  })

  it('does not reclaim a job whose lease was renewed', async () => {
    await adapter.enqueue(makeJob('alive', q))
    const [job] = await adapter.dequeue(q, 1)
    await sleep(120)
    await adapter.extendLeases(q, [{ jobId: job!.id, token: job!.completionToken! }])
    expect(await adapter.recoverStaleJobs(q, 100)).toEqual([])
    expect((await adapter.getJob('alive'))!.status).toBe('active')
  })

  it('ignores lease renewals with a stale token', async () => {
    await adapter.enqueue(makeJob('reclaimed', q))
    await adapter.dequeue(q, 1)
    await sleep(120)
    await adapter.extendLeases(q, [{ jobId: 'reclaimed', token: 'old-token' }])
    expect(await adapter.recoverStaleJobs(q, 100)).toEqual(['reclaimed'])
  })
})

describe.skipIf(!redisAvailable)('Worker leases end-to-end (real Redis)', () => {
  const prefix = `psyqueue_lease_${Date.now()}`
  const queues: PsyQueue[] = []

  afterEach(async () => {
    for (const q of queues) await q.stop()
    queues.length = 0
    await deleteKeys(prefix)
  })

  async function makeWorker(onRun: () => void, handlerMs: number): Promise<PsyQueue> {
    const q = new PsyQueue()
    q.use(redis({ keyPrefix: prefix }))
    q.handle('long', async () => { onRun(); await sleep(handlerMs); return { ok: true } })
    await q.start()
    queues.push(q)
    return q
  }

  it('a job running 4x longer than the lease runs exactly once across two workers', async () => {
    let runs = 0
    let completed = 0
    const leaseMs = 400
    const a = await makeWorker(() => runs++, 1600)
    const b = await makeWorker(() => runs++, 1600)
    a.events.on('job:completed', () => completed++)

    await a.enqueue('long', {})
    a.startWorker('long', { concurrency: 1, leaseMs, blockTimeout: 1000 })
    await sleep(100) // let worker A take the job
    b.startWorker('long', { concurrency: 1, leaseMs, blockTimeout: 1000 })

    const deadline = Date.now() + 5000
    while (completed === 0 && Date.now() < deadline) await sleep(50)
    await sleep(leaseMs) // give B a chance to (wrongly) reclaim and re-run

    expect(completed).toBe(1)
    expect(runs).toBe(1)
  }, 10_000)

  it('a crashed worker\'s job is reclaimed and completed by another worker', async () => {
    let completed = 0
    const leaseMs = 400
    const crashed = new RedisBackendAdapter({ keyPrefix: prefix })
    await crashed.connect()
    await crashed.enqueue(makeJob('orphan', 'long', { name: 'long' }))
    await crashed.dequeue('long', 1) // takes the job, then "dies" without heartbeating
    await crashed.disconnect()

    const b = await makeWorker(() => {}, 10)
    b.events.on('job:completed', () => completed++)
    b.startWorker('long', { concurrency: 1, leaseMs, blockTimeout: 500 })

    const deadline = Date.now() + 5000
    while (completed === 0 && Date.now() < deadline) await sleep(50)
    expect(completed).toBe(1)
  }, 10_000)
})
