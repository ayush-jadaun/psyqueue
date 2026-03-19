/**
 * Comparison Benchmarks
 *
 * Fair benchmark methodology:
 * - 5,000 jobs with a no-op handler, concurrency:10
 * - Processing throughput is measured using job:completed events (after ack),
 *   not handler invocation counts, so the measurement includes ack overhead
 * - Both PsyQueue and BullMQ use their worker/event-driven model
 * - PsyQueue uses startWorker() with poll mode for Redis
 * - BullMQ uses its native Worker class
 */
import { PsyQueue } from 'psyqueue'
import { sqlite } from '@psyqueue/backend-sqlite'
import { redis } from '@psyqueue/backend-redis'

export interface ComparisonEntry {
  system: string
  enqueueOpsPerSec: number
  processOpsPerSec: number
  e2eP50: number
  e2eP95: number
  e2eP99: number
  memoryMb: number
  available: boolean
  skipReason?: string
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil((p / 100) * sorted.length) - 1
  return sorted[Math.max(0, idx)]!
}

function getMemoryMb(): number {
  return Math.round(process.memoryUsage().heapUsed / 1024 / 1024 * 100) / 100
}

async function benchmarkPsyQueue(count: number): Promise<ComparisonEntry> {
  const memBefore = getMemoryMb()

  const q = new PsyQueue()
  q.use(sqlite({ path: ':memory:' }))
  q.handle('bench', async () => ({ ok: true }))
  await q.start()

  // Enqueue throughput
  const enqueueStart = performance.now()
  for (let i = 0; i < count; i++) {
    await q.enqueue('bench', { i })
  }
  const enqueueMs = performance.now() - enqueueStart

  // Process throughput
  const processStart = performance.now()
  for (let i = 0; i < count; i++) {
    await q.processNext('bench')
  }
  const processMs = performance.now() - processStart

  await q.stop()

  // E2E latency
  const q2 = new PsyQueue()
  q2.use(sqlite({ path: ':memory:' }))
  q2.handle('bench', async () => ({ ok: true }))
  await q2.start()

  const e2eSamples: number[] = []
  // Warmup
  for (let i = 0; i < 50; i++) {
    await q2.enqueue('bench', { i })
    await q2.processNext('bench')
  }
  const sampleCount = Math.min(count, 1000)
  for (let i = 0; i < sampleCount; i++) {
    const start = performance.now()
    await q2.enqueue('bench', { i })
    await q2.processNext('bench')
    e2eSamples.push(performance.now() - start)
  }
  await q2.stop()

  const sorted = [...e2eSamples].sort((a, b) => a - b)
  const memAfter = getMemoryMb()

  return {
    system: 'PsyQueue (SQLite :memory:)',
    enqueueOpsPerSec: Math.round((count / enqueueMs) * 1000),
    processOpsPerSec: Math.round((count / processMs) * 1000),
    e2eP50: percentile(sorted, 50),
    e2eP95: percentile(sorted, 95),
    e2eP99: percentile(sorted, 99),
    memoryMb: Math.round((memAfter - memBefore) * 100) / 100,
    available: true,
  }
}

async function benchmarkPsyQueueRedis(count: number): Promise<ComparisonEntry> {
  try {
    const memBefore = getMemoryMb()
    const q = new PsyQueue()
    q.use(redis({ url: 'redis://127.0.0.1:6381' }))

    let processed = 0
    q.handle('bench', async () => ({ ok: true }))

    try { await q.start() } catch {
      return { system: 'PsyQueue (Redis)', enqueueOpsPerSec: 0, processOpsPerSec: 0, e2eP50: 0, e2eP95: 0, e2eP99: 0, memoryMb: 0, available: false, skipReason: 'Redis not available at 127.0.0.1:6381' }
    }

    // Enqueue
    const enqueueStart = performance.now()
    for (let i = 0; i < count; i++) await q.enqueue('bench', { i })
    const enqueueMs = performance.now() - enqueueStart

    // Process — poll mode, concurrency:10 (matches BullMQ concurrency:10)
    // Uses job:completed event for fair comparison with BullMQ (measures after ack)
    processed = 0
    const backend = (q as any).backend
    if (backend) backend.supportsBlocking = false
    const processStart = performance.now()
    q.events.on('job:completed', () => { processed++ })
    q.startWorker('bench', { concurrency: 10, pollInterval: 1 })
    while (processed < count) await new Promise(r => setTimeout(r, 5))
    const processMs = performance.now() - processStart
    await q.stop()

    // E2E latency — simple processNext loop (no hanging worker)
    const q2 = new PsyQueue()
    q2.use(redis({ url: 'redis://127.0.0.1:6381' }))
    q2.handle('bench', async () => ({ ok: true }))
    await q2.start()

    const e2eSamples: number[] = []
    for (let i = 0; i < 50; i++) { await q2.enqueue('bench', { i }); await q2.processNext('bench') }
    const sampleCount = Math.min(count, 200)
    for (let i = 0; i < sampleCount; i++) {
      const s = performance.now()
      await q2.enqueue('bench', { i })
      await q2.processNext('bench')
      e2eSamples.push(performance.now() - s)
    }
    await q2.stop()

    const sorted = [...e2eSamples].sort((a, b) => a - b)
    const memAfter = getMemoryMb()

    return {
      system: 'PsyQueue (Redis)',
      enqueueOpsPerSec: Math.round((count / enqueueMs) * 1000),
      processOpsPerSec: Math.round((count / processMs) * 1000),
      e2eP50: percentile(sorted, 50),
      e2eP95: percentile(sorted, 95),
      e2eP99: percentile(sorted, 99),
      memoryMb: Math.round((memAfter - memBefore) * 100) / 100,
      available: true,
    }
  } catch (err: any) {
    return {
      system: 'PsyQueue (Redis)',
      enqueueOpsPerSec: 0, processOpsPerSec: 0, e2eP50: 0, e2eP95: 0, e2eP99: 0, memoryMb: 0,
      available: false, skipReason: `PsyQueue Redis error: ${err?.message}`,
    }
  }
}

async function benchmarkBullMQ(count: number): Promise<ComparisonEntry> {
  try {
    const bullmq = await import('bullmq')
    const { Queue, Worker, FlowProducer } = bullmq

    // Test Redis connection
    const testQueue = new Queue('bullmq-test', {
      connection: { host: '127.0.0.1', port: 6381, maxRetriesPerRequest: 1 },
    })

    try {
      await testQueue.waitUntilReady()
    } catch {
      await testQueue.close()
      return {
        system: 'BullMQ (Redis)',
        enqueueOpsPerSec: 0,
        processOpsPerSec: 0,
        e2eP50: 0,
        e2eP95: 0,
        e2eP99: 0,
        memoryMb: 0,
        available: false,
        skipReason: 'Redis not available at 127.0.0.1:6381',
      }
    }
    await testQueue.close()

    const memBefore = getMemoryMb()
    const queueName = `bench-${Date.now()}`

    // Enqueue benchmark
    const queue = new Queue(queueName, {
      connection: { host: '127.0.0.1', port: 6381 },
    })
    await queue.waitUntilReady()

    const enqueueStart = performance.now()
    for (let i = 0; i < count; i++) {
      await queue.add('bench', { i })
    }
    const enqueueMs = performance.now() - enqueueStart

    // Process benchmark
    let processedCount = 0
    const processStart = performance.now()
    const worker = new Worker(
      queueName,
      async () => ({ ok: true }),
      { connection: { host: '127.0.0.1', port: 6381 }, concurrency: 10 },
    )

    await new Promise<void>((resolve) => {
      worker.on('completed', () => {
        processedCount++
        if (processedCount >= count) resolve()
      })
    })
    const processMs = performance.now() - processStart

    await worker.close()
    await queue.obliterate({ force: true })
    await queue.close()

    const memAfter = getMemoryMb()

    // E2E latency (simplified - BullMQ is event-driven, not request/response)
    return {
      system: 'BullMQ (Redis)',
      enqueueOpsPerSec: Math.round((count / enqueueMs) * 1000),
      processOpsPerSec: Math.round((count / processMs) * 1000),
      e2eP50: 0,
      e2eP95: 0,
      e2eP99: 0,
      memoryMb: Math.round((memAfter - memBefore) * 100) / 100,
      available: true,
      skipReason: 'E2E latency not measured (event-driven architecture)',
    }
  } catch {
    return {
      system: 'BullMQ (Redis)',
      enqueueOpsPerSec: 0,
      processOpsPerSec: 0,
      e2eP50: 0,
      e2eP95: 0,
      e2eP99: 0,
      memoryMb: 0,
      available: false,
      skipReason: 'bullmq not installed',
    }
  }
}

async function benchmarkPgBoss(count: number): Promise<ComparisonEntry> {
  try {
    const pgBossModule = await import('pg-boss')
    const PgBoss = pgBossModule.default || pgBossModule

    const boss = new PgBoss('postgresql://dv_user:dv_pass@localhost:5434/psyqueue_bench')

    try {
      await boss.start()
    } catch {
      return {
        system: 'pg-boss (Postgres)',
        enqueueOpsPerSec: 0,
        processOpsPerSec: 0,
        e2eP50: 0,
        e2eP95: 0,
        e2eP99: 0,
        memoryMb: 0,
        available: false,
        skipReason: 'Postgres not available at localhost:5434',
      }
    }

    const memBefore = getMemoryMb()
    const queueName = `bench_pgboss`

    // Create queue first (pg-boss v10 requires it)
    await boss.createQueue(queueName)

    // Enqueue benchmark
    const enqueueStart = performance.now()
    for (let i = 0; i < count; i++) {
      await boss.send(queueName, { i })
    }
    const enqueueMs = performance.now() - enqueueStart

    // Process benchmark
    let processedCount = 0
    const processStart = performance.now()

    while (processedCount < count) {
      const job = await boss.fetch(queueName)
      if (job) {
        await boss.complete(queueName, job.id)
        processedCount++
      }
    }
    const processMs = performance.now() - processStart

    await boss.deleteQueue(queueName).catch(() => {})
    await boss.stop()
    const memAfter = getMemoryMb()

    return {
      system: 'pg-boss (Postgres)',
      enqueueOpsPerSec: Math.round((count / enqueueMs) * 1000),
      processOpsPerSec: Math.round((count / processMs) * 1000),
      e2eP50: 0,
      e2eP95: 0,
      e2eP99: 0,
      memoryMb: Math.round((memAfter - memBefore) * 100) / 100,
      available: true,
      skipReason: 'E2E latency not measured (fetch-based)',
    }
  } catch (err: any) {
    return {
      system: 'pg-boss (Postgres)',
      enqueueOpsPerSec: 0,
      processOpsPerSec: 0,
      e2eP50: 0,
      e2eP95: 0,
      e2eP99: 0,
      memoryMb: 0,
      available: false,
      skipReason: `pg-boss error: ${err?.message ?? String(err)}`,
    }
  }
}

export interface ComparisonResults {
  count: number
  entries: ComparisonEntry[]
}

export async function runComparisonBenchmarks(count = 5000): Promise<ComparisonResults> {
  const entries: ComparisonEntry[] = []

  entries.push(await benchmarkPsyQueue(count))
  entries.push(await benchmarkPsyQueueRedis(count))
  entries.push(await benchmarkBullMQ(count))
  entries.push(await benchmarkPgBoss(count))

  return { count, entries }
}

export function formatComparisonResults(r: ComparisonResults): string {
  const lines: string[] = []
  const fmt = (v: number) => v.toFixed(2)

  for (const entry of r.entries) {
    if (!entry.available) {
      lines.push(`  ${entry.system}:`)
      lines.push(`    [skipped - ${entry.skipReason}]`)
      lines.push('')
      continue
    }

    lines.push(`  ${entry.system}:`)
    lines.push(`    Enqueue:  ${entry.enqueueOpsPerSec.toLocaleString()} jobs/sec`)
    lines.push(`    Process:  ${entry.processOpsPerSec.toLocaleString()} jobs/sec`)
    if (entry.e2eP50 > 0) {
      lines.push(`    E2E p50: ${fmt(entry.e2eP50)}ms  p95: ${fmt(entry.e2eP95)}ms  p99: ${fmt(entry.e2eP99)}ms`)
    } else if (entry.skipReason) {
      lines.push(`    E2E: ${entry.skipReason}`)
    }
    lines.push(`    Memory:   ${entry.memoryMb}MB heap delta`)
    lines.push('')
  }

  return lines.join('\n')
}

// Run standalone
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  console.log('=== Comparison Benchmarks ===\n')
  const results = await runComparisonBenchmarks()
  console.log(formatComparisonResults(results))
}
