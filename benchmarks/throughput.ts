import { PsyQueue } from 'psyqueue'
import { sqlite } from '@psyqueue/backend-sqlite'

export interface ThroughputResult {
  count: number
  enqueueMs: number
  enqueueOpsPerSec: number
  processMs: number
  processOpsPerSec: number
  e2eMs: number
  e2eOpsPerSec: number
}

async function benchmarkAtScale(count: number): Promise<ThroughputResult> {
  const q = new PsyQueue()
  q.use(sqlite({ path: ':memory:' }))
  q.handle('bench', async () => ({ ok: true }))
  await q.start()

  // --- Enqueue benchmark ---
  const enqueueStart = performance.now()
  for (let i = 0; i < count; i++) {
    await q.enqueue('bench', { i })
  }
  const enqueueMs = performance.now() - enqueueStart

  // --- Process benchmark ---
  const processStart = performance.now()
  for (let i = 0; i < count; i++) {
    await q.processNext('bench')
  }
  const processMs = performance.now() - processStart

  await q.stop()

  // --- End-to-end benchmark (enqueue + process together) ---
  const q2 = new PsyQueue()
  q2.use(sqlite({ path: ':memory:' }))
  q2.handle('bench', async () => ({ ok: true }))
  await q2.start()

  const e2eStart = performance.now()
  for (let i = 0; i < count; i++) {
    await q2.enqueue('bench', { i })
    await q2.processNext('bench')
  }
  const e2eMs = performance.now() - e2eStart

  await q2.stop()

  return {
    count,
    enqueueMs,
    enqueueOpsPerSec: Math.round((count / enqueueMs) * 1000),
    processMs,
    processOpsPerSec: Math.round((count / processMs) * 1000),
    e2eMs,
    e2eOpsPerSec: Math.round((count / e2eMs) * 1000),
  }
}

export async function runThroughputBenchmarks(): Promise<ThroughputResult[]> {
  const scales = [100, 1000, 5000, 10000]
  const results: ThroughputResult[] = []

  for (const count of scales) {
    const result = await benchmarkAtScale(count)
    results.push(result)
  }

  return results
}

export function formatThroughputResults(results: ThroughputResult[]): string {
  const lines: string[] = []

  for (const r of results) {
    lines.push(`  ${r.count.toLocaleString()} jobs:`)
    lines.push(`    Enqueue:  ${r.enqueueMs.toFixed(1)}ms (${r.enqueueOpsPerSec.toLocaleString()} jobs/sec)`)
    lines.push(`    Process:  ${r.processMs.toFixed(1)}ms (${r.processOpsPerSec.toLocaleString()} jobs/sec)`)
    lines.push(`    E2E:      ${r.e2eMs.toFixed(1)}ms (${r.e2eOpsPerSec.toLocaleString()} jobs/sec)`)
  }

  return lines.join('\n')
}

// Run standalone
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  console.log('=== Throughput Benchmarks ===\n')
  const results = await runThroughputBenchmarks()
  console.log(formatThroughputResults(results))
}
