import { PsyQueue } from 'psyqueue'
import { sqlite } from '@psyqueue/backend-sqlite'

export interface LatencyResult {
  label: string
  count: number
  p50: number
  p95: number
  p99: number
  min: number
  max: number
  mean: number
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil((p / 100) * sorted.length) - 1
  return sorted[Math.max(0, idx)]!
}

function computeStats(label: string, samples: number[]): LatencyResult {
  const sorted = [...samples].sort((a, b) => a - b)
  const sum = sorted.reduce((a, b) => a + b, 0)
  return {
    label,
    count: sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!,
    mean: sum / sorted.length,
  }
}

async function benchmarkEnqueueLatency(count: number): Promise<LatencyResult> {
  const q = new PsyQueue()
  q.use(sqlite({ path: ':memory:' }))
  q.handle('bench', async () => ({ ok: true }))
  await q.start()

  const samples: number[] = []

  // Warmup
  for (let i = 0; i < 50; i++) {
    await q.enqueue('bench', { i })
  }

  for (let i = 0; i < count; i++) {
    const start = performance.now()
    await q.enqueue('bench', { i })
    samples.push(performance.now() - start)
  }

  await q.stop()
  return computeStats('Enqueue', samples)
}

async function benchmarkE2ELatency(count: number): Promise<LatencyResult> {
  const q = new PsyQueue()
  q.use(sqlite({ path: ':memory:' }))
  q.handle('bench', async () => ({ ok: true }))
  await q.start()

  const samples: number[] = []

  // Warmup
  for (let i = 0; i < 50; i++) {
    await q.enqueue('bench', { i })
    await q.processNext('bench')
  }

  for (let i = 0; i < count; i++) {
    const start = performance.now()
    await q.enqueue('bench', { i })
    await q.processNext('bench')
    samples.push(performance.now() - start)
  }

  await q.stop()
  return computeStats('E2E', samples)
}

async function benchmarkMiddlewareOverhead(count: number): Promise<{ bare: LatencyResult; withMiddleware: LatencyResult }> {
  // Bare kernel - no extra middleware
  const qBare = new PsyQueue()
  qBare.use(sqlite({ path: ':memory:' }))
  qBare.handle('bench', async () => ({ ok: true }))
  await qBare.start()

  const bareSamples: number[] = []
  // Warmup
  for (let i = 0; i < 50; i++) {
    await qBare.enqueue('bench', { i })
    await qBare.processNext('bench')
  }

  for (let i = 0; i < count; i++) {
    const start = performance.now()
    await qBare.enqueue('bench', { i })
    await qBare.processNext('bench')
    bareSamples.push(performance.now() - start)
  }
  await qBare.stop()

  // Kernel with 5 middleware
  const qMw = new PsyQueue()
  qMw.use(sqlite({ path: ':memory:' }))
  qMw.handle('bench', async () => ({ ok: true }))

  // Add 5 passthrough middleware on both enqueue and process
  for (let m = 0; m < 5; m++) {
    qMw.pipeline('enqueue', async (_ctx, next) => {
      await next()
    })
    qMw.pipeline('process', async (_ctx, next) => {
      await next()
    })
  }

  await qMw.start()

  const mwSamples: number[] = []
  // Warmup
  for (let i = 0; i < 50; i++) {
    await qMw.enqueue('bench', { i })
    await qMw.processNext('bench')
  }

  for (let i = 0; i < count; i++) {
    const start = performance.now()
    await qMw.enqueue('bench', { i })
    await qMw.processNext('bench')
    mwSamples.push(performance.now() - start)
  }
  await qMw.stop()

  return {
    bare: computeStats('Bare (0 middleware)', bareSamples),
    withMiddleware: computeStats('With 5 middleware', mwSamples),
  }
}

export interface LatencyResults {
  enqueue: LatencyResult
  e2e: LatencyResult
  middlewareBare: LatencyResult
  middlewareLoaded: LatencyResult
}

export async function runLatencyBenchmarks(count = 1000): Promise<LatencyResults> {
  const enqueue = await benchmarkEnqueueLatency(count)
  const e2e = await benchmarkE2ELatency(count)
  const mw = await benchmarkMiddlewareOverhead(count)

  return {
    enqueue,
    e2e,
    middlewareBare: mw.bare,
    middlewareLoaded: mw.withMiddleware,
  }
}

export function formatLatencyResults(r: LatencyResults): string {
  const fmt = (v: number) => v.toFixed(2)
  const lines: string[] = []

  lines.push(`  Enqueue (${r.enqueue.count} samples):`)
  lines.push(`    p50: ${fmt(r.enqueue.p50)}ms  p95: ${fmt(r.enqueue.p95)}ms  p99: ${fmt(r.enqueue.p99)}ms`)
  lines.push(`    min: ${fmt(r.enqueue.min)}ms  max: ${fmt(r.enqueue.max)}ms  mean: ${fmt(r.enqueue.mean)}ms`)
  lines.push('')
  lines.push(`  E2E (${r.e2e.count} samples):`)
  lines.push(`    p50: ${fmt(r.e2e.p50)}ms  p95: ${fmt(r.e2e.p95)}ms  p99: ${fmt(r.e2e.p99)}ms`)
  lines.push(`    min: ${fmt(r.e2e.min)}ms  max: ${fmt(r.e2e.max)}ms  mean: ${fmt(r.e2e.mean)}ms`)
  lines.push('')
  lines.push(`  Middleware overhead (${r.middlewareBare.count} samples):`)
  lines.push(`    Bare (0 plugins):    p50: ${fmt(r.middlewareBare.p50)}ms  p95: ${fmt(r.middlewareBare.p95)}ms  p99: ${fmt(r.middlewareBare.p99)}ms`)
  lines.push(`    With 5 middleware:   p50: ${fmt(r.middlewareLoaded.p50)}ms  p95: ${fmt(r.middlewareLoaded.p95)}ms  p99: ${fmt(r.middlewareLoaded.p99)}ms`)
  lines.push(`    Overhead:            ~${fmt(r.middlewareLoaded.p50 - r.middlewareBare.p50)}ms per E2E op (p50)`)

  return lines.join('\n')
}

// Run standalone
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  console.log('=== Latency Benchmarks ===\n')
  const results = await runLatencyBenchmarks()
  console.log(formatLatencyResults(results))
}
