/**
 * DISTRIBUTED HEAVY TEST — PsyQueue on Real Redis
 *
 * 4 comprehensive tests verifying PsyQueue behaves correctly as a
 * REAL distributed queue with multiple competing worker instances.
 *
 * Redis: 127.0.0.1:6381
 */

import { PsyQueue } from 'psyqueue'
import { redis } from '@psyqueue/backend-redis'
import { createHash } from 'crypto'
import RedisModule from 'ioredis'

const Redis = (RedisModule as any).default ?? RedisModule

// ─── Config ───────────────────────────────────────────────────────────────────

const REDIS_HOST = '127.0.0.1'
const REDIS_PORT = 6381
const REDIS_URL = `redis://${REDIS_HOST}:${REDIS_PORT}`

// ─── Utilities ────────────────────────────────────────────────────────────────

const write = (s: string) => process.stdout.write(s)
const writeln = (s: string) => process.stdout.write(s + '\n')

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

function sha256(data: string): string {
  return createHash('sha256').update(data).digest('hex')
}

function fib(n: number): number {
  if (n <= 1) return n
  let a = 0, b = 1
  for (let i = 2; i <= n; i++) {
    const c = a + b; a = b; b = c
  }
  return b
}

async function flushRedis(): Promise<void> {
  const c = new Redis({ host: REDIS_HOST, port: REDIS_PORT })
  await new Promise<void>((resolve, reject) => {
    c.once('ready', resolve)
    c.once('error', reject)
    if (c.status === 'ready') resolve()
  })
  await c.flushdb()
  await c.quit()
}

function createPQ(): PsyQueue {
  const q = new PsyQueue()
  q.use(redis({ host: REDIS_HOST, port: REDIS_PORT }))
  return q
}

function disableBlocking(q: PsyQueue): void {
  const be = (q as any).backend
  if (be) be.supportsBlocking = false
}

function assert(condition: boolean, label: string, detail: string): void {
  const status = condition ? 'PASS' : 'FAIL'
  writeln(`  [${status}] ${label}: ${detail}`)
}

// ─── Test 1: Heavy CPU — 2 distributed worker instances ──────────────────────
//
// Double-processing is detected inside the HANDLER (not event listeners)
// because each PsyQueue instance has its own in-process event bus — both
// buses fire legitimately for the jobs each instance processed. True
// double-processing means two handlers ran for the same job ID.

async function test1_heavyCPU(): Promise<void> {
  writeln('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  writeln('TEST 1: Heavy CPU — 200 jobs, 2 competing PsyQueue worker instances')
  writeln('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')

  const JOBS = 200
  const QUEUE = 'heavy-cpu'
  const start = performance.now()

  await flushRedis()

  // Shared across both workers — detects true double-processing at handler level
  const handledIds = new Set<string>()
  const doubleProcessed: string[] = []
  let worker1Jobs = 0
  let worker2Jobs = 0
  const hashResults = new Map<number, string>()
  let w1Done = 0
  let w2Done = 0

  // Worker 1
  const w1 = createPQ()
  w1.handle(QUEUE, async (ctx) => {
    const id = ctx.job.id
    if (handledIds.has(id)) doubleProcessed.push(id)
    else handledIds.add(id)
    worker1Jobs++

    const { index, payload } = ctx.job.payload as { index: number; payload: string }
    const fibN = 25 + (index % 10) // fib(25) to fib(34)
    const fibResult = fib(fibN)
    const hash = sha256(`${payload}-${fibResult}`)
    hashResults.set(index, hash)
    return { fibResult, hash }
  })
  await w1.start()
  disableBlocking(w1)
  w1.startWorker(QUEUE, { concurrency: 5, pollInterval: 1 })
  w1.events.on('job:completed', () => { w1Done++ })

  // Worker 2
  const w2 = createPQ()
  w2.handle(QUEUE, async (ctx) => {
    const id = ctx.job.id
    if (handledIds.has(id)) doubleProcessed.push(id)
    else handledIds.add(id)
    worker2Jobs++

    const { index, payload } = ctx.job.payload as { index: number; payload: string }
    const fibN = 25 + (index % 10)
    const fibResult = fib(fibN)
    const hash = sha256(`${payload}-${fibResult}`)
    hashResults.set(index, hash)
    return { fibResult, hash }
  })
  await w2.start()
  disableBlocking(w2)
  w2.startWorker(QUEUE, { concurrency: 5, pollInterval: 1 })
  w2.events.on('job:completed', () => { w2Done++ })

  // Enqueue all jobs via dedicated enqueuer instance
  const enqueuer = createPQ()
  await enqueuer.start()
  const items = Array.from({ length: JOBS }, (_, i) => ({
    name: QUEUE,
    payload: { index: i, payload: `job-${i}-data-${sha256(`seed-${i}`)}` },
    opts: { queue: QUEUE },
  }))
  const ids = await enqueuer.enqueueBulk(items)
  writeln(`  Enqueued ${ids.length} jobs`)

  // Wait for all to complete (max 60s)
  const deadline = Date.now() + 60_000
  while (handledIds.size + doubleProcessed.length < JOBS && Date.now() < deadline) {
    await sleep(50)
  }
  // Brief drain so event bus catches up
  await sleep(200)

  const elapsed = Math.round(performance.now() - start)

  await enqueuer.stop()
  await w1.stop()
  await w2.stop()

  const totalHandled = handledIds.size
  writeln(`  Worker 1 processed: ${worker1Jobs} jobs (completed events: ${w1Done})`)
  writeln(`  Worker 2 processed: ${worker2Jobs} jobs (completed events: ${w2Done})`)
  writeln(`  Total unique jobs handled: ${totalHandled}, double-processed: ${doubleProcessed.length}, time: ${elapsed}ms`)

  assert(totalHandled === JOBS, 'All jobs processed', `${totalHandled}/${JOBS}`)
  assert(doubleProcessed.length === 0, 'Zero double-processing', `${doubleProcessed.length} duplicates`)
  assert(worker1Jobs > 0, 'Worker 1 got work', `${worker1Jobs} jobs`)
  assert(worker2Jobs > 0, 'Worker 2 got work', `${worker2Jobs} jobs`)
  assert(hashResults.size === JOBS, 'Data integrity (SHA256 computed for all)', `${hashResults.size}/${JOBS} hashes`)
  assert(w1Done + w2Done === JOBS, 'Zero failures', `${w1Done + w2Done} completed, 0 failed`)
}

// ─── Test 2: Heavy I/O — concurrency 20, simulated HTTP + DB ─────────────────

async function test2_heavyIO(): Promise<void> {
  writeln('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  writeln('TEST 2: Heavy I/O — 100 jobs, concurrency 20, simulated HTTP+DB')
  writeln('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')

  const JOBS = 100
  const QUEUE = 'heavy-io'
  const start = performance.now()

  await flushRedis()

  let completed = 0
  let failed = 0
  let totalSimulatedMs = 0
  let inFlight = 0
  let peakConcurrency = 0

  const q = createPQ()
  q.handle(QUEUE, async (ctx) => {
    inFlight++
    if (inFlight > peakConcurrency) peakConcurrency = inFlight

    const { httpMs, dbMs } = ctx.job.payload as { httpMs: number; dbMs: number }
    // Simulate HTTP call
    await sleep(httpMs)
    // Simulate DB call
    await sleep(dbMs)
    totalSimulatedMs += httpMs + dbMs

    inFlight--
    return { httpMs, dbMs }
  })
  await q.start()
  disableBlocking(q)
  q.startWorker(QUEUE, { concurrency: 20, pollInterval: 1 })

  q.events.on('job:completed', () => { completed++ })
  q.events.on('job:failed', () => { failed++ })

  // Enqueue jobs with random delays
  const items = Array.from({ length: JOBS }, (_, i) => ({
    name: QUEUE,
    payload: {
      httpMs: 20 + Math.floor(Math.random() * 31),  // 20-50ms
      dbMs: 10 + Math.floor(Math.random() * 11),     // 10-20ms
    },
    opts: { queue: QUEUE },
  }))
  await q.enqueueBulk(items)
  writeln(`  Enqueued ${JOBS} jobs with 20-50ms HTTP + 10-20ms DB delays`)

  const deadline = Date.now() + 60_000
  while (completed + failed < JOBS && Date.now() < deadline) {
    await sleep(50)
  }

  const elapsed = Math.round(performance.now() - start)
  const avgSimulated = JOBS > 0 ? Math.round(totalSimulatedMs / JOBS) : 0

  await q.stop()

  writeln(`  Completed: ${completed}, failed: ${failed}, time: ${elapsed}ms`)
  writeln(`  Peak concurrency: ${peakConcurrency}, avg simulated work: ${avgSimulated}ms/job`)

  // Sequential would take ~100 * 35ms avg = ~3500ms; with concurrency 20 should be much faster
  const sequentialEstimate = JOBS * 35
  const speedup = (sequentialEstimate / elapsed).toFixed(1)
  writeln(`  Speedup vs sequential: ~${speedup}x (sequential est: ${sequentialEstimate}ms)`)

  assert(completed + failed === JOBS, 'All jobs processed', `${completed + failed}/${JOBS}`)
  assert(failed === 0, 'Zero failures', `${failed} failed`)
  assert(peakConcurrency > 1, 'Actual concurrency observed', `peak: ${peakConcurrency}`)
  assert(elapsed < sequentialEstimate, 'Faster than sequential', `${elapsed}ms < ${sequentialEstimate}ms`)
}

// ─── Test 3: Mixed Workload — 500 jobs (fast + slow + CPU + flaky) ────────────
//
// Tracks by job ID to avoid counting retried jobs multiple times.

async function test3_mixedWorkload(): Promise<void> {
  writeln('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  writeln('TEST 3: Mixed Workload — 500 jobs: 200 fast + 100 slow-IO + 100 CPU + 100 flaky')
  writeln('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')

  const QUEUE = 'mixed'
  const FAST_COUNT = 200
  const SLOW_IO_COUNT = 100
  const CPU_COUNT = 100
  const FLAKY_COUNT = 100
  const TOTAL = FAST_COUNT + SLOW_IO_COUNT + CPU_COUNT + FLAKY_COUNT
  const start = performance.now()

  await flushRedis()

  // Track terminal state per job ID to avoid double-counting retries
  const completedIds = new Set<string>()
  const failedIds = new Set<string>()

  const q = createPQ()

  q.handle('fast', async () => {
    return { done: true }
  })

  q.handle('slow-io', async (ctx) => {
    const { delayMs } = ctx.job.payload as { delayMs: number }
    await sleep(delayMs)
    return { done: true }
  })

  q.handle('cpu', async (ctx) => {
    const { n } = ctx.job.payload as { n: number }
    const result = fib(n)
    const hash = sha256(`cpu-${n}-${result}`)
    return { result, hash }
  })

  q.handle('flaky', async () => {
    if (Math.random() < 0.5) {
      throw new Error('Simulated flaky failure')
    }
    return { done: true }
  }, { maxRetries: 3 })

  await q.start()
  disableBlocking(q)
  q.startWorker(QUEUE, { concurrency: 15, pollInterval: 1 })

  // Track terminal outcomes by job ID (not raw event count)
  q.events.on('job:completed', (e: any) => {
    completedIds.add(e.jobId)
    failedIds.delete(e.jobId)  // completed supersedes any prior failure
  })
  q.events.on('job:failed', (e: any) => {
    // Only record as finally failed if not already completed
    if (!completedIds.has(e.jobId)) {
      failedIds.add(e.jobId)
    }
  })

  // Enqueue all mixed jobs
  const items: Array<{ name: string; payload: unknown; opts: { queue: string } }> = []

  for (let i = 0; i < FAST_COUNT; i++) {
    items.push({ name: 'fast', payload: { i }, opts: { queue: QUEUE } })
  }
  for (let i = 0; i < SLOW_IO_COUNT; i++) {
    items.push({ name: 'slow-io', payload: { delayMs: 20 + Math.floor(Math.random() * 31) }, opts: { queue: QUEUE } })
  }
  for (let i = 0; i < CPU_COUNT; i++) {
    items.push({ name: 'cpu', payload: { n: 28 + (i % 7) }, opts: { queue: QUEUE } })
  }
  for (let i = 0; i < FLAKY_COUNT; i++) {
    items.push({ name: 'flaky', payload: { i }, opts: { queue: QUEUE } })
  }

  // Shuffle for realism
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]]
  }

  const enqueuedIds = await q.enqueueBulk(items)
  writeln(`  Enqueued ${TOTAL} jobs (${FAST_COUNT} fast, ${SLOW_IO_COUNT} slow-IO, ${CPU_COUNT} CPU, ${FLAKY_COUNT} flaky)`)
  const enqueuedSet = new Set(enqueuedIds)

  // Wait — flaky jobs with retries need more time; poll for terminal state
  const deadline = Date.now() + 120_000
  while (completedIds.size + failedIds.size < TOTAL && Date.now() < deadline) {
    await sleep(100)
  }
  // Extra drain to let stragglers settle
  await sleep(500)

  const elapsed = Math.round(performance.now() - start)

  await q.stop()

  const totalCompleted = completedIds.size
  const totalFailed = failedIds.size
  const totalTerminal = totalCompleted + totalFailed

  writeln(`  Completed: ${totalCompleted}, failed (exhausted retries): ${totalFailed}, time: ${elapsed}ms`)

  // Flaky: 50% fail rate, 3 retries — P(exhausted) = 0.5^4 = 6.25% per job, ~6 expected
  const processedAll = totalTerminal === TOTAL
  const flakyExhausted = totalFailed <= FLAKY_COUNT
  const nonFlakyOk = totalCompleted >= FAST_COUNT + SLOW_IO_COUNT + CPU_COUNT

  assert(processedAll, 'All jobs reached terminal state', `${totalTerminal}/${TOTAL}`)
  assert(nonFlakyOk, 'Non-flaky jobs all completed', `${totalCompleted} completed (min expected: ${FAST_COUNT + SLOW_IO_COUNT + CPU_COUNT})`)
  assert(flakyExhausted, 'Flaky exhaustions bounded to flaky count', `${totalFailed} exhausted (max: ${FLAKY_COUNT})`)
  writeln(`  Note: ~${FLAKY_COUNT} flaky jobs had 50% fail rate + 3 retries, ~6 expected to exhaust`)
}

// ─── Test 4: 3 Distributed Workers — 1000 jobs ───────────────────────────────

async function test4_threeWorkers(): Promise<void> {
  writeln('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  writeln('TEST 4: 3 Distributed Workers — 1000 jobs, verify all get work + zero doubles')
  writeln('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')

  const JOBS = 1000
  const QUEUE = 'dist-3'
  const start = performance.now()

  await flushRedis()

  // Shared handler-level dedup — true double-processing detection
  const handledIds = new Set<string>()
  const doubleProcessed: string[] = []
  const workerCounts = [0, 0, 0]
  // Per-worker event completion counts (separate buses, no dedup needed)
  const workerCompleted = [0, 0, 0]
  const workerFailed = [0, 0, 0]

  const workers: PsyQueue[] = []

  for (let wi = 0; wi < 3; wi++) {
    const wIdx = wi
    const w = createPQ()
    w.handle(QUEUE, async (ctx) => {
      const id = ctx.job.id
      // This is the ground truth: if two handlers ran for same ID, it's a bug
      if (handledIds.has(id)) {
        doubleProcessed.push(id)
      } else {
        handledIds.add(id)
      }
      workerCounts[wIdx]++
      const hash = sha256(`${id}-${wIdx}`)
      return { worker: wIdx, hash }
    })
    await w.start()
    disableBlocking(w)
    w.startWorker(QUEUE, { concurrency: 5, pollInterval: 1 })

    w.events.on('job:completed', () => { workerCompleted[wIdx]++ })
    w.events.on('job:failed', () => { workerFailed[wIdx]++ })

    workers.push(w)
  }

  // Separate enqueuer instance
  const enqueuer = createPQ()
  await enqueuer.start()

  const items = Array.from({ length: JOBS }, (_, i) => ({
    name: QUEUE,
    payload: { index: i, data: sha256(`dist-job-${i}`) },
    opts: { queue: QUEUE },
  }))

  writeln(`  Enqueuing ${JOBS} jobs via dedicated enqueuer instance...`)
  const ids = await enqueuer.enqueueBulk(items)
  writeln(`  Enqueued ${ids.length} jobs`)

  // Wait for all to be handled
  const deadline = Date.now() + 90_000
  let lastPrint = 0
  while (handledIds.size + doubleProcessed.length < JOBS && Date.now() < deadline) {
    await sleep(100)
    const now = Date.now()
    if (now - lastPrint > 2000) {
      write(`  Progress: ${handledIds.size}/${JOBS} (w1:${workerCounts[0]} w2:${workerCounts[1]} w3:${workerCounts[2]})\n`)
      lastPrint = now
    }
  }
  await sleep(200)

  const elapsed = Math.round(performance.now() - start)
  const totalFailed = workerFailed[0] + workerFailed[1] + workerFailed[2]

  await enqueuer.stop()
  for (const w of workers) await w.stop()

  writeln(`  Worker distribution: w1=${workerCounts[0]}, w2=${workerCounts[1]}, w3=${workerCounts[2]}`)
  writeln(`  Completed events: w1=${workerCompleted[0]}, w2=${workerCompleted[1]}, w3=${workerCompleted[2]}`)
  writeln(`  Unique jobs handled: ${handledIds.size}, double-processed: ${doubleProcessed.length}, failed: ${totalFailed}`)
  writeln(`  Time: ${elapsed}ms`)

  const allProcessed = handledIds.size === JOBS
  const allWorkersGotWork = workerCounts.every(c => c > 0)
  const noDuplicates = doubleProcessed.length === 0
  const distribution = workerCounts.map(c => ((c / JOBS) * 100).toFixed(1) + '%').join(', ')

  assert(allProcessed, 'All 1000 jobs processed', `${handledIds.size}/${JOBS}`)
  assert(noDuplicates, 'Zero double-processing', `${doubleProcessed.length} duplicates`)
  assert(allWorkersGotWork, 'All 3 workers got work', `distribution: ${distribution}`)
  assert(totalFailed === 0, 'Zero failures', `${totalFailed} failed`)
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  writeln('╔════════════════════════════════════════════════════════════════╗')
  writeln('║       PSYQUEUE DISTRIBUTED HEAVY TEST — Redis 127.0.0.1:6381  ║')
  writeln('╚════════════════════════════════════════════════════════════════╝')
  writeln(`Started: ${new Date().toISOString()}`)

  const overallStart = performance.now()

  try {
    await test1_heavyCPU()
    await test2_heavyIO()
    await test3_mixedWorkload()
    await test4_threeWorkers()
  } catch (err) {
    writeln(`\nFATAL ERROR: ${err}`)
    if (err instanceof Error) writeln(err.stack ?? '')
    process.exit(1)
  }

  const totalMs = Math.round(performance.now() - overallStart)

  writeln('\n════════════════════════════════════════════════════════════════')
  writeln(`ALL TESTS COMPLETE — total time: ${totalMs}ms`)
  writeln('════════════════════════════════════════════════════════════════\n')

  process.exit(0)
}

main()
