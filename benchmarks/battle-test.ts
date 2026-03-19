/**
 * HARDCORE BATTLE TEST: PsyQueue vs BullMQ
 *
 * 10 identical reliability/correctness stress tests run on both systems
 * under the same Redis instance (127.0.0.1:6381).
 *
 * This is NOT a benchmark — this is a correctness test.
 * Every test has a clear PASS/FAIL with specific numbers.
 */

import { PsyQueue } from 'psyqueue'
import { redis } from '@psyqueue/backend-redis'
import { scheduler } from '@psyqueue/plugin-scheduler'
import { createHash } from 'crypto'
import RedisModule from 'ioredis'

const Redis = (RedisModule as any).default ?? RedisModule

// ─── Config ───────────────────────────────────────────────────────────────────

const REDIS_HOST = '127.0.0.1'
const REDIS_PORT = 6381
const REDIS_URL = `redis://${REDIS_HOST}:${REDIS_PORT}`

// ─── Types ────────────────────────────────────────────────────────────────────

interface SystemResult {
  passed: boolean
  detail: string
  timeMs: number
}

interface BattleResult {
  name: string
  psyqueue: SystemResult
  bullmq: SystemResult
}

// ─── Utilities ────────────────────────────────────────────────────────────────

const write = (s: string) => process.stdout.write(s)
const writeln = (s: string) => process.stdout.write(s + '\n')

function fmt(n: number): string {
  return n.toLocaleString()
}

async function getFlushClient(): Promise<any> {
  const c = new Redis({ host: REDIS_HOST, port: REDIS_PORT })
  await new Promise<void>((resolve, reject) => {
    c.once('ready', resolve)
    c.once('error', reject)
    if (c.status === 'ready') resolve()
  })
  return c
}

async function flushRedis(): Promise<void> {
  const c = await getFlushClient()
  await c.flushdb()
  await c.quit()
}

function sha256(data: string): string {
  return createHash('sha256').update(data).digest('hex')
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

// ─── PsyQueue Helpers ─────────────────────────────────────────────────────────

async function createPsyQueue(opts?: { withScheduler?: boolean }): Promise<PsyQueue> {
  const q = new PsyQueue()
  q.use(redis({ url: REDIS_URL }))
  if (opts?.withScheduler) {
    q.use(scheduler({ pollInterval: 200 }))
  }
  return q
}

// ─── Battle 1: Sustained Load (15 seconds continuous) ─────────────────────────

async function battle1_psyqueue(): Promise<SystemResult> {
  const start = performance.now()
  await flushRedis()

  const q = await createPsyQueue()
  q.handle('sustained', async () => ({ ok: true }))
  await q.start()

  // Disable blocking for poll mode
  const backend = (q as any).backend
  if (backend) backend.supportsBlocking = false

  let enqueued = 0
  let completed = 0
  let failed = 0

  q.events.on('job:completed', () => { completed++ })
  q.events.on('job:failed', () => { failed++ })

  q.startWorker('sustained', { concurrency: 10, pollInterval: 5 })

  const duration = 15_000
  const endTime = Date.now() + duration

  // Continuously enqueue while workers process
  while (Date.now() < endTime) {
    const batch = []
    for (let i = 0; i < 50; i++) {
      batch.push({ name: 'sustained', payload: { i: enqueued + i }, opts: { queue: 'sustained' } })
    }
    await q.enqueueBulk(batch)
    enqueued += batch.length
    await sleep(1) // tiny yield
  }

  // Wait for processing to finish (max 30s)
  const deadline = Date.now() + 30_000
  while (completed + failed < enqueued && Date.now() < deadline) {
    await sleep(100)
  }

  await q.stop()

  const lost = enqueued - completed - failed
  const passed = lost === 0
  const timeMs = Math.round(performance.now() - start)

  return {
    passed,
    detail: `${fmt(enqueued)} enqueued, ${fmt(completed)} completed, ${failed} failed, ${lost} lost`,
    timeMs,
  }
}

async function battle1_bullmq(): Promise<SystemResult> {
  const start = performance.now()
  await flushRedis()

  const { Queue, Worker } = await import('bullmq')
  const queueName = `sustained-bull-${Date.now()}`
  const queue = new Queue(queueName, { connection: { host: REDIS_HOST, port: REDIS_PORT } })
  await queue.waitUntilReady()

  let enqueued = 0
  let completed = 0
  let failed = 0

  const worker = new Worker(
    queueName,
    async () => ({ ok: true }),
    { connection: { host: REDIS_HOST, port: REDIS_PORT }, concurrency: 10 },
  )

  worker.on('completed', () => { completed++ })
  worker.on('failed', () => { failed++ })

  const duration = 15_000
  const endTime = Date.now() + duration

  while (Date.now() < endTime) {
    const batch = []
    for (let i = 0; i < 50; i++) {
      batch.push({ name: 'sustained', data: { i: enqueued + i } })
    }
    await queue.addBulk(batch)
    enqueued += batch.length
    await sleep(1)
  }

  const deadline = Date.now() + 30_000
  while (completed + failed < enqueued && Date.now() < deadline) {
    await sleep(100)
  }

  await worker.close()
  await queue.obliterate({ force: true })
  await queue.close()

  const lost = enqueued - completed - failed
  const passed = lost === 0
  const timeMs = Math.round(performance.now() - start)

  return {
    passed,
    detail: `${fmt(enqueued)} enqueued, ${fmt(completed)} completed, ${failed} failed, ${lost} lost`,
    timeMs,
  }
}

// ─── Battle 2: Rapid Fire (10K jobs as fast as possible) ──────────────────────

async function battle2_psyqueue(): Promise<SystemResult> {
  const start = performance.now()
  await flushRedis()

  const COUNT = 10_000
  const q = await createPsyQueue()
  const completedIds = new Set<string>()

  q.handle('rapid', async (ctx) => {
    return { id: ctx.job.id }
  })
  await q.start()

  // Enqueue all 10K
  const allIds: string[] = []
  const batchSize = 200
  for (let i = 0; i < COUNT; i += batchSize) {
    const batch = []
    const size = Math.min(batchSize, COUNT - i)
    for (let j = 0; j < size; j++) {
      batch.push({ name: 'rapid', payload: { idx: i + j }, opts: { queue: 'rapid' } })
    }
    const ids = await q.enqueueBulk(batch)
    allIds.push(...ids)
  }

  // Process with worker
  const backend = (q as any).backend
  if (backend) backend.supportsBlocking = false

  q.events.on('job:completed', (evt: any) => {
    completedIds.add(evt.data.jobId)
  })

  q.startWorker('rapid', { concurrency: 10, pollInterval: 1 })

  const deadline = Date.now() + 60_000
  while (completedIds.size < COUNT && Date.now() < deadline) {
    await sleep(50)
  }

  await q.stop()

  // Verify every ID is completed
  const missing = allIds.filter(id => !completedIds.has(id))
  const passed = completedIds.size === COUNT && missing.length === 0
  const timeMs = Math.round(performance.now() - start)

  return {
    passed,
    detail: `${fmt(completedIds.size)}/${fmt(COUNT)} completed, ${missing.length} missing`,
    timeMs,
  }
}

async function battle2_bullmq(): Promise<SystemResult> {
  const start = performance.now()
  await flushRedis()

  const COUNT = 10_000
  const { Queue, Worker } = await import('bullmq')
  const queueName = `rapid-bull-${Date.now()}`
  const queue = new Queue(queueName, { connection: { host: REDIS_HOST, port: REDIS_PORT } })
  await queue.waitUntilReady()

  const completedIds = new Set<string>()

  // Enqueue all 10K
  const allIds: string[] = []
  const batchSize = 200
  for (let i = 0; i < COUNT; i += batchSize) {
    const batch = []
    const size = Math.min(batchSize, COUNT - i)
    for (let j = 0; j < size; j++) {
      batch.push({ name: 'rapid', data: { idx: i + j } })
    }
    const jobs = await queue.addBulk(batch)
    allIds.push(...jobs.map((j: any) => j.id!))
  }

  const worker = new Worker(
    queueName,
    async (job) => ({ id: job.id }),
    { connection: { host: REDIS_HOST, port: REDIS_PORT }, concurrency: 10 },
  )

  worker.on('completed', (job: any) => {
    completedIds.add(job.id!)
  })

  const deadline = Date.now() + 60_000
  while (completedIds.size < COUNT && Date.now() < deadline) {
    await sleep(50)
  }

  await worker.close()
  await queue.obliterate({ force: true })
  await queue.close()

  const missing = allIds.filter(id => !completedIds.has(id))
  const passed = completedIds.size === COUNT && missing.length === 0
  const timeMs = Math.round(performance.now() - start)

  return {
    passed,
    detail: `${fmt(completedIds.size)}/${fmt(COUNT)} completed, ${missing.length} missing`,
    timeMs,
  }
}

// ─── Battle 3: Large Payloads (100KB per job) ─────────────────────────────────

function makeLargePayload(idx: number): { data: string; hash: string } {
  // Generate ~100KB of JSON-safe data
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let data = `JOB_${idx}_`
  while (Buffer.byteLength(data) < 100_000) {
    data += chars[Math.floor(Math.random() * chars.length)]
  }
  return { data, hash: sha256(data) }
}

async function battle3_psyqueue(): Promise<SystemResult> {
  const start = performance.now()
  await flushRedis()

  const COUNT = 100
  const q = await createPsyQueue()
  const expectedHashes = new Map<number, string>()
  const receivedHashes = new Map<number, string>()
  let completed = 0

  q.handle('large', async (ctx) => {
    const payload = ctx.job.payload as { idx: number; data: string }
    receivedHashes.set(payload.idx, sha256(payload.data))
    return { ok: true }
  })
  await q.start()

  // Enqueue 100 jobs with large payloads
  for (let i = 0; i < COUNT; i++) {
    const { data, hash } = makeLargePayload(i)
    expectedHashes.set(i, hash)
    await q.enqueue('large', { idx: i, data }, { queue: 'large' })
  }

  const backend = (q as any).backend
  if (backend) backend.supportsBlocking = false

  q.events.on('job:completed', () => { completed++ })
  q.startWorker('large', { concurrency: 5, pollInterval: 5 })

  const deadline = Date.now() + 60_000
  while (completed < COUNT && Date.now() < deadline) {
    await sleep(50)
  }

  await q.stop()

  // Verify hashes
  let mismatches = 0
  for (const [idx, expected] of expectedHashes) {
    const received = receivedHashes.get(idx)
    if (received !== expected) mismatches++
  }

  const passed = completed === COUNT && mismatches === 0
  const timeMs = Math.round(performance.now() - start)

  return {
    passed,
    detail: `${completed}/${COUNT} completed, ${mismatches} hash mismatches`,
    timeMs,
  }
}

async function battle3_bullmq(): Promise<SystemResult> {
  const start = performance.now()
  await flushRedis()

  const COUNT = 100
  const { Queue, Worker } = await import('bullmq')
  const queueName = `large-bull-${Date.now()}`
  const queue = new Queue(queueName, { connection: { host: REDIS_HOST, port: REDIS_PORT } })
  await queue.waitUntilReady()

  const expectedHashes = new Map<number, string>()
  const receivedHashes = new Map<number, string>()
  let completed = 0

  for (let i = 0; i < COUNT; i++) {
    const { data, hash } = makeLargePayload(i)
    expectedHashes.set(i, hash)
    await queue.add('large', { idx: i, data })
  }

  const worker = new Worker(
    queueName,
    async (job) => {
      const payload = job.data as { idx: number; data: string }
      receivedHashes.set(payload.idx, sha256(payload.data))
      return { ok: true }
    },
    { connection: { host: REDIS_HOST, port: REDIS_PORT }, concurrency: 5 },
  )

  worker.on('completed', () => { completed++ })

  const deadline = Date.now() + 60_000
  while (completed < COUNT && Date.now() < deadline) {
    await sleep(50)
  }

  await worker.close()
  await queue.obliterate({ force: true })
  await queue.close()

  let mismatches = 0
  for (const [idx, expected] of expectedHashes) {
    const received = receivedHashes.get(idx)
    if (received !== expected) mismatches++
  }

  const passed = completed === COUNT && mismatches === 0
  const timeMs = Math.round(performance.now() - start)

  return {
    passed,
    detail: `${completed}/${COUNT} completed, ${mismatches} hash mismatches`,
    timeMs,
  }
}

// ─── Battle 4: Poison Pill (mix of success + failure) ─────────────────────────

async function battle4_psyqueue(): Promise<SystemResult> {
  const start = performance.now()
  await flushRedis()

  const TOTAL = 1000
  const SUCCEED = 800
  const FAIL = 200

  const q = await createPsyQueue({ withScheduler: true })
  let completedCount = 0
  let deadCount = 0

  q.handle('poison', async (ctx) => {
    const payload = ctx.job.payload as { idx: number; shouldFail: boolean }
    if (payload.shouldFail) {
      throw new Error(`Poison pill job ${payload.idx}`)
    }
    return { ok: true }
  })
  await q.start()

  // Enqueue: first 800 succeed, last 200 fail (deterministic)
  for (let i = 0; i < TOTAL; i++) {
    await q.enqueue('poison', { idx: i, shouldFail: i >= SUCCEED }, {
      queue: 'poison',
      maxRetries: 2,
      backoff: 'fixed',
      backoffBase: 50,
      backoffJitter: false,
    })
  }

  const backend = (q as any).backend
  if (backend) backend.supportsBlocking = false

  q.events.on('job:completed', () => { completedCount++ })
  q.events.on('job:dead', () => { deadCount++ })

  q.startWorker('poison', { concurrency: 10, pollInterval: 5 })

  // Failing jobs need retries (attempt 1, 2, then dead on 3rd fail)
  // maxRetries:2 means after 2 failures it goes to dead letter
  // Wait for all to finish
  const deadline = Date.now() + 120_000
  while (completedCount + deadCount < TOTAL && Date.now() < deadline) {
    await sleep(100)
  }

  await q.stop()

  const passed = completedCount === SUCCEED && deadCount === FAIL
  const timeMs = Math.round(performance.now() - start)

  return {
    passed,
    detail: `${completedCount} completed (want ${SUCCEED}), ${deadCount} dead (want ${FAIL})`,
    timeMs,
  }
}

async function battle4_bullmq(): Promise<SystemResult> {
  const start = performance.now()
  await flushRedis()

  const TOTAL = 1000
  const SUCCEED = 800
  const FAIL = 200

  const { Queue, Worker } = await import('bullmq')
  const queueName = `poison-bull-${Date.now()}`
  const queue = new Queue(queueName, {
    connection: { host: REDIS_HOST, port: REDIS_PORT },
    defaultJobOptions: {
      attempts: 3, // 3 attempts total = 2 retries
      backoff: { type: 'fixed', delay: 50 },
    },
  })
  await queue.waitUntilReady()

  let completedCount = 0
  let failedPermanent = 0

  for (let i = 0; i < TOTAL; i++) {
    await queue.add('poison', { idx: i, shouldFail: i >= SUCCEED })
  }

  const worker = new Worker(
    queueName,
    async (job) => {
      const payload = job.data as { idx: number; shouldFail: boolean }
      if (payload.shouldFail) {
        throw new Error(`Poison pill job ${payload.idx}`)
      }
      return { ok: true }
    },
    { connection: { host: REDIS_HOST, port: REDIS_PORT }, concurrency: 10 },
  )

  worker.on('completed', () => { completedCount++ })
  worker.on('failed', (job: any) => {
    // BullMQ fires 'failed' on every failure including retries.
    // We only count when attempts are exhausted.
    if (job && job.attemptsMade >= 3) {
      failedPermanent++
    }
  })

  const deadline = Date.now() + 120_000
  while (completedCount + failedPermanent < TOTAL && Date.now() < deadline) {
    await sleep(100)
  }

  await worker.close()
  await queue.obliterate({ force: true })
  await queue.close()

  const passed = completedCount === SUCCEED && failedPermanent === FAIL
  const timeMs = Math.round(performance.now() - start)

  return {
    passed,
    detail: `${completedCount} completed (want ${SUCCEED}), ${failedPermanent} dead (want ${FAIL})`,
    timeMs,
  }
}

// ─── Battle 5: Concurrent Workers (simulate multi-process) ───────────────────

async function battle5_psyqueue(): Promise<SystemResult> {
  const start = performance.now()
  await flushRedis()

  const COUNT = 1000
  const WORKERS = 5
  const processedIds = new Set<string>()
  let doubleProcessed = 0

  // Enqueue first
  const enqueueQ = await createPsyQueue()
  await enqueueQ.start()
  for (let i = 0; i < COUNT; i += 100) {
    const batch = []
    const size = Math.min(100, COUNT - i)
    for (let j = 0; j < size; j++) {
      batch.push({ name: 'concurrent', payload: { idx: i + j }, opts: { queue: 'concurrent' } })
    }
    await enqueueQ.enqueueBulk(batch)
  }
  await enqueueQ.stop()

  // Start 5 independent PsyQueue instances as workers
  const workers: PsyQueue[] = []
  for (let w = 0; w < WORKERS; w++) {
    const q = await createPsyQueue()
    q.handle('concurrent', async (ctx) => {
      const id = ctx.job.id
      if (processedIds.has(id)) {
        doubleProcessed++
      }
      processedIds.add(id)
      return { ok: true }
    })
    await q.start()
    const backend = (q as any).backend
    if (backend) backend.supportsBlocking = false
    q.startWorker('concurrent', { concurrency: 5, pollInterval: 5 })
    workers.push(q)
  }

  const deadline = Date.now() + 60_000
  while (processedIds.size < COUNT && Date.now() < deadline) {
    await sleep(50)
  }

  for (const w of workers) {
    await w.stop()
  }

  const passed = processedIds.size === COUNT && doubleProcessed === 0
  const timeMs = Math.round(performance.now() - start)

  return {
    passed,
    detail: `${processedIds.size}/${COUNT} processed, ${doubleProcessed} double-processed`,
    timeMs,
  }
}

async function battle5_bullmq(): Promise<SystemResult> {
  const start = performance.now()
  await flushRedis()

  const COUNT = 1000
  const WORKERS = 5
  const { Queue, Worker } = await import('bullmq')
  const queueName = `concurrent-bull-${Date.now()}`
  const queue = new Queue(queueName, { connection: { host: REDIS_HOST, port: REDIS_PORT } })
  await queue.waitUntilReady()

  const processedIds = new Set<string>()
  let doubleProcessed = 0

  for (let i = 0; i < COUNT; i += 100) {
    const batch = []
    const size = Math.min(100, COUNT - i)
    for (let j = 0; j < size; j++) {
      batch.push({ name: 'concurrent', data: { idx: i + j } })
    }
    await queue.addBulk(batch)
  }

  const workers: any[] = []
  for (let w = 0; w < WORKERS; w++) {
    const worker = new Worker(
      queueName,
      async (job) => {
        const id = job.id!
        if (processedIds.has(id)) {
          doubleProcessed++
        }
        processedIds.add(id)
        return { ok: true }
      },
      { connection: { host: REDIS_HOST, port: REDIS_PORT }, concurrency: 5 },
    )
    workers.push(worker)
  }

  const deadline = Date.now() + 60_000
  while (processedIds.size < COUNT && Date.now() < deadline) {
    await sleep(50)
  }

  for (const w of workers) {
    await w.close()
  }
  await queue.obliterate({ force: true })
  await queue.close()

  const passed = processedIds.size === COUNT && doubleProcessed === 0
  const timeMs = Math.round(performance.now() - start)

  return {
    passed,
    detail: `${processedIds.size}/${COUNT} processed, ${doubleProcessed} double-processed`,
    timeMs,
  }
}

// ─── Battle 6: Memory Stability (process 10K jobs, check heap) ────────────────

async function battle6_psyqueue(): Promise<SystemResult> {
  const start = performance.now()
  await flushRedis()

  const COUNT = 10_000

  // Force GC if available
  if (global.gc) global.gc()
  const heapBefore = process.memoryUsage().heapUsed

  const q = await createPsyQueue()
  let completed = 0
  q.handle('memory', async () => ({ ok: true }))
  await q.start()

  // Enqueue in batches
  for (let i = 0; i < COUNT; i += 500) {
    const batch = []
    const size = Math.min(500, COUNT - i)
    for (let j = 0; j < size; j++) {
      batch.push({ name: 'memory', payload: { idx: i + j }, opts: { queue: 'memory' } })
    }
    await q.enqueueBulk(batch)
  }

  const backend = (q as any).backend
  if (backend) backend.supportsBlocking = false

  q.events.on('job:completed', () => { completed++ })
  q.startWorker('memory', { concurrency: 10, pollInterval: 1 })

  const deadline = Date.now() + 120_000
  while (completed < COUNT && Date.now() < deadline) {
    await sleep(100)
  }

  await q.stop()

  if (global.gc) global.gc()
  const heapAfter = process.memoryUsage().heapUsed
  const growthMb = Math.round((heapAfter - heapBefore) / 1024 / 1024 * 100) / 100

  const passed = growthMb < 50
  const timeMs = Math.round(performance.now() - start)

  return {
    passed,
    detail: `${fmt(completed)}/${fmt(COUNT)} completed, heap growth: ${growthMb}MB`,
    timeMs,
  }
}

async function battle6_bullmq(): Promise<SystemResult> {
  const start = performance.now()
  await flushRedis()

  const COUNT = 10_000
  const { Queue, Worker } = await import('bullmq')
  const queueName = `memory-bull-${Date.now()}`

  if (global.gc) global.gc()
  const heapBefore = process.memoryUsage().heapUsed

  const queue = new Queue(queueName, { connection: { host: REDIS_HOST, port: REDIS_PORT } })
  await queue.waitUntilReady()

  let completed = 0

  for (let i = 0; i < COUNT; i += 500) {
    const batch = []
    const size = Math.min(500, COUNT - i)
    for (let j = 0; j < size; j++) {
      batch.push({ name: 'memory', data: { idx: i + j } })
    }
    await queue.addBulk(batch)
  }

  const worker = new Worker(
    queueName,
    async () => ({ ok: true }),
    { connection: { host: REDIS_HOST, port: REDIS_PORT }, concurrency: 10 },
  )

  worker.on('completed', () => { completed++ })

  const deadline = Date.now() + 120_000
  while (completed < COUNT && Date.now() < deadline) {
    await sleep(100)
  }

  await worker.close()
  await queue.obliterate({ force: true })
  await queue.close()

  if (global.gc) global.gc()
  const heapAfter = process.memoryUsage().heapUsed
  const growthMb = Math.round((heapAfter - heapBefore) / 1024 / 1024 * 100) / 100

  const passed = growthMb < 50
  const timeMs = Math.round(performance.now() - start)

  return {
    passed,
    detail: `${fmt(completed)}/${fmt(COUNT)} completed, heap growth: ${growthMb}MB`,
    timeMs,
  }
}

// ─── Battle 7: Retry Storm (all jobs fail then succeed) ───────────────────────

async function battle7_psyqueue(): Promise<SystemResult> {
  const start = performance.now()
  await flushRedis()

  const COUNT = 500
  const q = await createPsyQueue({ withScheduler: true })
  let completedCount = 0
  let totalInvocations = 0

  // Track attempts per job — fail attempts 1 and 2, succeed on attempt 3
  q.handle('retry-storm', async (ctx) => {
    totalInvocations++
    const attempt = ctx.job.attempt
    if (attempt < 3) {
      throw new Error(`Fail attempt ${attempt}`)
    }
    return { ok: true }
  })
  await q.start()

  for (let i = 0; i < COUNT; i++) {
    await q.enqueue('retry-storm', { idx: i }, {
      queue: 'retry-storm',
      maxRetries: 3,
      backoff: 'fixed',
      backoffBase: 50,
      backoffJitter: false,
    })
  }

  const backend = (q as any).backend
  if (backend) backend.supportsBlocking = false

  q.events.on('job:completed', () => { completedCount++ })

  q.startWorker('retry-storm', { concurrency: 10, pollInterval: 5 })

  const deadline = Date.now() + 120_000
  while (completedCount < COUNT && Date.now() < deadline) {
    await sleep(100)
  }

  await q.stop()

  // Each job: attempt 1 (fail), attempt 2 (fail), attempt 3 (succeed) = 3 invocations
  const expectedInvocations = COUNT * 3
  const passed = completedCount === COUNT && totalInvocations === expectedInvocations
  const timeMs = Math.round(performance.now() - start)

  return {
    passed,
    detail: `${completedCount}/${COUNT} completed, ${totalInvocations}/${expectedInvocations} invocations`,
    timeMs,
  }
}

async function battle7_bullmq(): Promise<SystemResult> {
  const start = performance.now()
  await flushRedis()

  const COUNT = 500
  const { Queue, Worker } = await import('bullmq')
  const queueName = `retry-bull-${Date.now()}`
  const queue = new Queue(queueName, {
    connection: { host: REDIS_HOST, port: REDIS_PORT },
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'fixed', delay: 50 },
    },
  })
  await queue.waitUntilReady()

  let completedCount = 0
  let totalInvocations = 0

  for (let i = 0; i < COUNT; i++) {
    await queue.add('retry-storm', { idx: i })
  }

  const worker = new Worker(
    queueName,
    async (job) => {
      totalInvocations++
      // BullMQ attemptsMade starts at 1 on first attempt
      if (job.attemptsMade < 3) {
        throw new Error(`Fail attempt ${job.attemptsMade}`)
      }
      return { ok: true }
    },
    { connection: { host: REDIS_HOST, port: REDIS_PORT }, concurrency: 10 },
  )

  worker.on('completed', () => { completedCount++ })

  const deadline = Date.now() + 120_000
  while (completedCount < COUNT && Date.now() < deadline) {
    await sleep(100)
  }

  await worker.close()
  await queue.obliterate({ force: true })
  await queue.close()

  const expectedInvocations = COUNT * 3
  const passed = completedCount === COUNT && totalInvocations === expectedInvocations
  const timeMs = Math.round(performance.now() - start)

  return {
    passed,
    detail: `${completedCount}/${COUNT} completed, ${totalInvocations}/${expectedInvocations} invocations`,
    timeMs,
  }
}

// ─── Battle 8: Ordering Under Load (priority correctness) ────────────────────

function kendallTau(a: number[], b: number[]): number {
  const n = a.length
  if (n < 2) return 1
  let concordant = 0
  let discordant = 0
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const aSign = Math.sign(a[i]! - a[j]!)
      const bSign = Math.sign(b[i]! - b[j]!)
      if (aSign === bSign) concordant++
      else if (aSign !== 0 && bSign !== 0) discordant++
    }
  }
  const total = concordant + discordant
  return total === 0 ? 1 : (concordant - discordant) / total
}

async function battle8_psyqueue(): Promise<SystemResult> {
  const start = performance.now()
  await flushRedis()

  const COUNT = 1000
  const q = await createPsyQueue()
  const processOrder: number[] = []

  q.handle('priority', async (ctx) => {
    const payload = ctx.job.payload as { priority: number }
    processOrder.push(payload.priority)
    return { ok: true }
  })
  await q.start()

  // Enqueue 1000 jobs with priorities 1-1000 (higher number = higher priority)
  // Enqueue in random order to make it a real test
  const priorities = Array.from({ length: COUNT }, (_, i) => i + 1)
  // Shuffle
  for (let i = priorities.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[priorities[i], priorities[j]] = [priorities[j]!, priorities[i]!]
  }

  for (const p of priorities) {
    await q.enqueue('priority', { priority: p }, {
      queue: 'priority',
      priority: p,
    })
  }

  // Process with concurrency:1 to test ordering (concurrency>1 would blur order)
  const backend = (q as any).backend
  if (backend) backend.supportsBlocking = false

  q.startWorker('priority', { concurrency: 1, pollInterval: 1 })

  const deadline = Date.now() + 60_000
  while (processOrder.length < COUNT && Date.now() < deadline) {
    await sleep(50)
  }

  await q.stop()

  // Expected order: 1000, 999, 998, ..., 1 (highest priority first)
  const expected = Array.from({ length: processOrder.length }, (_, i) => COUNT - i)
  const tau = kendallTau(processOrder, expected)

  const passed = processOrder.length === COUNT && tau > 0.8
  const timeMs = Math.round(performance.now() - start)

  return {
    passed,
    detail: `${processOrder.length}/${COUNT} processed, Kendall tau: ${tau.toFixed(4)}`,
    timeMs,
  }
}

async function battle8_bullmq(): Promise<SystemResult> {
  const start = performance.now()
  await flushRedis()

  const COUNT = 1000
  const { Queue, Worker } = await import('bullmq')
  const queueName = `priority-bull-${Date.now()}`
  const queue = new Queue(queueName, { connection: { host: REDIS_HOST, port: REDIS_PORT } })
  await queue.waitUntilReady()

  const processOrder: number[] = []

  // Shuffle priorities
  const priorities = Array.from({ length: COUNT }, (_, i) => i + 1)
  for (let i = priorities.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[priorities[i], priorities[j]] = [priorities[j]!, priorities[i]!]
  }

  // BullMQ priority: lower number = higher priority (opposite of PsyQueue)
  for (const p of priorities) {
    await queue.add('priority', { priority: p }, {
      priority: COUNT + 1 - p, // Invert so p=1000 gets BullMQ priority 1 (highest)
    })
  }

  const worker = new Worker(
    queueName,
    async (job) => {
      processOrder.push(job.data.priority)
      return { ok: true }
    },
    { connection: { host: REDIS_HOST, port: REDIS_PORT }, concurrency: 1 },
  )

  const deadline = Date.now() + 60_000
  while (processOrder.length < COUNT && Date.now() < deadline) {
    await sleep(50)
  }

  await worker.close()
  await queue.obliterate({ force: true })
  await queue.close()

  const expected = Array.from({ length: processOrder.length }, (_, i) => COUNT - i)
  const tau = kendallTau(processOrder, expected)

  // BullMQ doesn't guarantee priority ordering, so we use a lower bar
  const passed = processOrder.length === COUNT && tau > 0.8
  const timeMs = Math.round(performance.now() - start)

  return {
    passed,
    detail: `${processOrder.length}/${COUNT} processed, Kendall tau: ${tau.toFixed(4)}`,
    timeMs,
  }
}

// ─── Battle 9: Stale Job Recovery ─────────────────────────────────────────────

async function battle9_psyqueue(): Promise<SystemResult> {
  const start = performance.now()
  await flushRedis()

  const STALE = 50

  const q = await createPsyQueue()
  q.handle('stale', async () => ({ ok: true }))
  await q.start()

  const backend = (q as any).backend

  // Enqueue 50 jobs and dequeue them (mark active) but DON'T ack
  for (let i = 0; i < STALE; i++) {
    await q.enqueue('stale', { idx: i })
  }
  const activeJobs = await backend.dequeue('stale', STALE)

  // Now call recoverStaleJobs with maxAge=0 (recover everything immediately)
  let recovered: string[] = []
  if (backend.recoverStaleJobs) {
    recovered = await backend.recoverStaleJobs('stale', 0) // maxAge=0 means all active are stale
  }

  // Now process the recovered jobs
  let processedCount = 0
  for (let i = 0; i < STALE; i++) {
    const ok = await q.processNext('stale')
    if (ok) processedCount++
  }

  await q.stop()

  const passed = activeJobs.length === STALE && recovered.length === STALE && processedCount === STALE
  const timeMs = Math.round(performance.now() - start)

  return {
    passed,
    detail: `${activeJobs.length} dequeued, ${recovered.length} recovered, ${processedCount} re-processed`,
    timeMs,
  }
}

async function battle9_bullmq(): Promise<SystemResult> {
  const start = performance.now()
  await flushRedis()

  const STALE = 50

  const { Queue, Worker } = await import('bullmq')
  const queueName = `stale-bull-${Date.now()}`
  const queue = new Queue(queueName, { connection: { host: REDIS_HOST, port: REDIS_PORT } })
  await queue.waitUntilReady()

  // Enqueue 50, process with lockDuration=1s, let locks expire, check stalled detection
  for (let i = 0; i < STALE; i++) {
    await queue.add('stale', { idx: i })
  }

  // Worker with very short lock that processes then crashes (simulate stall)
  let picked = 0
  let stalledCount = 0
  const worker = new Worker(
    queueName,
    async () => {
      picked++
      // Simulate slow processing that exceeds lockDuration → triggers stalled
      await sleep(3000)
      return { ok: true }
    },
    {
      connection: { host: REDIS_HOST, port: REDIS_PORT },
      concurrency: STALE,
      lockDuration: 1000,      // 1s lock — will expire while handler sleeps 3s
      stalledInterval: 2000,   // check every 2s
      maxStalledCount: 2,      // allow 2 stall recoveries before failing
    },
  )

  worker.on('stalled', () => { stalledCount++ })

  // Wait for processing (stalled detection + re-processing)
  let completed = 0
  worker.on('completed', () => { completed++ })
  const deadline = Date.now() + 30_000
  while (completed < STALE && Date.now() < deadline) {
    await sleep(200)
  }

  await worker.close().catch(() => {})
  await queue.obliterate({ force: true }).catch(() => {})
  await queue.close()

  const passed = completed === STALE
  const timeMs = Math.round(performance.now() - start)

  return {
    passed,
    detail: `${picked} picked, ${stalledCount} stalled events, ${completed}/${STALE} completed`,
    timeMs,
  }
}

// ─── Battle 10: Rapid Enqueue-Cancel-Enqueue ──────────────────────────────────

async function battle10_psyqueue(): Promise<SystemResult> {
  const start = performance.now()
  await flushRedis()

  const BATCH1 = 500
  const BATCH2 = 500
  const TOTAL = BATCH1 + BATCH2

  const q = await createPsyQueue()
  let completed = 0

  q.handle('rapid-ec', async () => ({ ok: true }))
  await q.start()

  const backend = (q as any).backend
  if (backend) backend.supportsBlocking = false

  // Enqueue first batch of 500
  for (let i = 0; i < BATCH1; i += 100) {
    const batch = []
    const size = Math.min(100, BATCH1 - i)
    for (let j = 0; j < size; j++) {
      batch.push({ name: 'rapid-ec', payload: { batch: 1, idx: i + j }, opts: { queue: 'rapid-ec' } })
    }
    await q.enqueueBulk(batch)
  }

  // Start processing immediately
  q.events.on('job:completed', () => { completed++ })
  q.startWorker('rapid-ec', { concurrency: 10, pollInterval: 1 })

  // Wait until ~250 processed, then enqueue second batch
  const halfDeadline = Date.now() + 30_000
  while (completed < 250 && Date.now() < halfDeadline) {
    await sleep(10)
  }

  // Enqueue second batch while processing continues
  for (let i = 0; i < BATCH2; i += 100) {
    const batch = []
    const size = Math.min(100, BATCH2 - i)
    for (let j = 0; j < size; j++) {
      batch.push({ name: 'rapid-ec', payload: { batch: 2, idx: i + j }, opts: { queue: 'rapid-ec' } })
    }
    await q.enqueueBulk(batch)
  }

  // Wait for all to complete
  const deadline = Date.now() + 60_000
  while (completed < TOTAL && Date.now() < deadline) {
    await sleep(50)
  }

  await q.stop()

  const passed = completed === TOTAL
  const timeMs = Math.round(performance.now() - start)

  return {
    passed,
    detail: `${completed}/${TOTAL} completed`,
    timeMs,
  }
}

async function battle10_bullmq(): Promise<SystemResult> {
  const start = performance.now()
  await flushRedis()

  const BATCH1 = 500
  const BATCH2 = 500
  const TOTAL = BATCH1 + BATCH2

  const { Queue, Worker } = await import('bullmq')
  const queueName = `rapid-ec-bull-${Date.now()}`
  const queue = new Queue(queueName, { connection: { host: REDIS_HOST, port: REDIS_PORT } })
  await queue.waitUntilReady()

  let completed = 0

  // Enqueue first batch
  for (let i = 0; i < BATCH1; i += 100) {
    const batch = []
    const size = Math.min(100, BATCH1 - i)
    for (let j = 0; j < size; j++) {
      batch.push({ name: 'rapid-ec', data: { batch: 1, idx: i + j } })
    }
    await queue.addBulk(batch)
  }

  const worker = new Worker(
    queueName,
    async () => ({ ok: true }),
    { connection: { host: REDIS_HOST, port: REDIS_PORT }, concurrency: 10 },
  )

  worker.on('completed', () => { completed++ })

  const halfDeadline = Date.now() + 30_000
  while (completed < 250 && Date.now() < halfDeadline) {
    await sleep(10)
  }

  // Enqueue second batch while processing
  for (let i = 0; i < BATCH2; i += 100) {
    const batch = []
    const size = Math.min(100, BATCH2 - i)
    for (let j = 0; j < size; j++) {
      batch.push({ name: 'rapid-ec', data: { batch: 2, idx: i + j } })
    }
    await queue.addBulk(batch)
  }

  const deadline = Date.now() + 60_000
  while (completed < TOTAL && Date.now() < deadline) {
    await sleep(50)
  }

  await worker.close()
  await queue.obliterate({ force: true })
  await queue.close()

  const passed = completed === TOTAL
  const timeMs = Math.round(performance.now() - start)

  return {
    passed,
    detail: `${completed}/${TOTAL} completed`,
    timeMs,
  }
}

// ─── Runner ───────────────────────────────────────────────────────────────────

interface Battle {
  name: string
  psyqueue: () => Promise<SystemResult>
  bullmq: () => Promise<SystemResult>
}

const battles: Battle[] = [
  { name: 'Sustained Load (15s)', psyqueue: battle1_psyqueue, bullmq: battle1_bullmq },
  { name: 'Rapid Fire (10K)', psyqueue: battle2_psyqueue, bullmq: battle2_bullmq },
  { name: 'Large Payloads (100KB)', psyqueue: battle3_psyqueue, bullmq: battle3_bullmq },
  { name: 'Poison Pill (800/200)', psyqueue: battle4_psyqueue, bullmq: battle4_bullmq },
  { name: 'Concurrent Workers (5x)', psyqueue: battle5_psyqueue, bullmq: battle5_bullmq },
  { name: 'Memory Stability (10K)', psyqueue: battle6_psyqueue, bullmq: battle6_bullmq },
  { name: 'Retry Storm (500x3)', psyqueue: battle7_psyqueue, bullmq: battle7_bullmq },
  { name: 'Priority Ordering', psyqueue: battle8_psyqueue, bullmq: battle8_bullmq },
  { name: 'Stale Job Recovery', psyqueue: battle9_psyqueue, bullmq: battle9_bullmq },
  { name: 'Rapid Enqueue+Process', psyqueue: battle10_psyqueue, bullmq: battle10_bullmq },
]

async function runBattle(battle: Battle, index: number): Promise<BattleResult> {
  writeln(`\n  [${index + 1}/10] ${battle.name}`)

  write(`    PsyQueue ... `)
  let psyResult: SystemResult
  try {
    psyResult = await battle.psyqueue()
  } catch (err: any) {
    psyResult = { passed: false, detail: `ERROR: ${err?.message ?? err}`, timeMs: 0 }
  }
  writeln(`${psyResult.passed ? 'PASS' : 'FAIL'} (${(psyResult.timeMs / 1000).toFixed(1)}s) — ${psyResult.detail}`)

  write(`    BullMQ   ... `)
  let bullResult: SystemResult
  try {
    bullResult = await battle.bullmq()
  } catch (err: any) {
    bullResult = { passed: false, detail: `ERROR: ${err?.message ?? err}`, timeMs: 0 }
  }
  writeln(`${bullResult.passed ? 'PASS' : 'FAIL'} (${(bullResult.timeMs / 1000).toFixed(1)}s) — ${bullResult.detail}`)

  return { name: battle.name, psyqueue: psyResult, bullmq: bullResult }
}

async function main() {
  writeln('')
  writeln('  ============================================================')
  writeln('        HARDCORE BATTLE TEST: PsyQueue vs BullMQ')
  writeln('        Same Redis, Same Rules, Same Concurrency')
  writeln(`        Redis: ${REDIS_URL}`)
  writeln('  ============================================================')

  // Verify Redis connectivity
  try {
    const c = await getFlushClient()
    await c.ping()
    await c.quit()
  } catch {
    writeln('\n  ERROR: Cannot connect to Redis at ' + REDIS_URL)
    writeln('  Start Redis on port 6381 and try again.')
    process.exit(1)
  }

  const results: BattleResult[] = []

  for (let i = 0; i < battles.length; i++) {
    results.push(await runBattle(battles[i]!, i))
  }

  // Final cleanup
  await flushRedis()

  // ─── Scoreboard ──────────────────────────────────────────────────────────

  let psyScore = 0
  let bullScore = 0

  writeln('')
  writeln('  +----+---------------------------+-----------------+-----------------+')
  writeln('  | #  | Battle                    | PsyQueue        | BullMQ          |')
  writeln('  +----+---------------------------+-----------------+-----------------+')

  for (let i = 0; i < results.length; i++) {
    const r = results[i]!
    const num = String(i + 1).padStart(2)
    const name = r.name.padEnd(25)
    const psy = (r.psyqueue.passed ? 'PASS' : 'FAIL').padEnd(4) + ` ${(r.psyqueue.timeMs / 1000).toFixed(1)}s`.padStart(10)
    const bull = (r.bullmq.passed ? 'PASS' : 'FAIL').padEnd(4) + ` ${(r.bullmq.timeMs / 1000).toFixed(1)}s`.padStart(10)

    if (r.psyqueue.passed) psyScore++
    if (r.bullmq.passed) bullScore++

    writeln(`  | ${num} | ${name} | ${psy} | ${bull} |`)
  }

  writeln('  +----+---------------------------+-----------------+-----------------+')
  writeln(`  |    | SCORE                     | PsyQueue: ${String(psyScore).padStart(2)}/10 | BullMQ:   ${String(bullScore).padStart(2)}/10 |`)
  writeln('  +----+---------------------------+-----------------+-----------------+')
  writeln('')

  if (psyScore > bullScore) {
    writeln(`  WINNER: PsyQueue (${psyScore} vs ${bullScore})`)
  } else if (bullScore > psyScore) {
    writeln(`  WINNER: BullMQ (${bullScore} vs ${psyScore})`)
  } else {
    writeln(`  TIE: Both scored ${psyScore}/10`)
  }

  writeln('')
  process.exit(0)
}

main().catch((err) => {
  writeln(`\nFATAL: ${err?.message ?? err}`)
  writeln(err?.stack ?? '')
  process.exit(1)
})
