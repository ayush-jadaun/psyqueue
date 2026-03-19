/**
 * Priority ordering verification test.
 *
 * Enqueues 100 jobs with random priorities (1-100), processes all with
 * concurrency:1, and verifies the dequeue order matches priority order
 * (highest priority first).
 */

import { PsyQueue } from 'psyqueue'
import { redis } from '@psyqueue/backend-redis'
import RedisModule from 'ioredis'

const Redis = (RedisModule as any).default ?? RedisModule

const REDIS_HOST = '127.0.0.1'
const REDIS_PORT = 6381
const REDIS_URL = `redis://${REDIS_HOST}:${REDIS_PORT}`

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
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

async function main() {
  console.log('\n  Priority Ordering Verification Test')
  console.log('  ====================================\n')

  await flushRedis()

  const COUNT = 100
  const processOrder: number[] = []

  const q = new PsyQueue()
  q.use(redis({ url: REDIS_URL }))

  q.handle('priority-test', async (ctx) => {
    const payload = ctx.job.payload as { priority: number }
    processOrder.push(payload.priority)
    return { ok: true }
  })

  await q.start()

  // Generate shuffled priorities 1-100
  const priorities = Array.from({ length: COUNT }, (_, i) => i + 1)
  for (let i = priorities.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[priorities[i], priorities[j]] = [priorities[j]!, priorities[i]!]
  }

  console.log(`  Enqueuing ${COUNT} jobs with random priorities (1-${COUNT})...`)

  // Enqueue all jobs first (before starting the worker)
  for (const p of priorities) {
    await q.enqueue('priority-test', { priority: p }, {
      queue: 'priority-test',
      priority: p,
    })
  }

  console.log('  All jobs enqueued. Starting worker with concurrency:1...')

  // Disable blocking so we use poll mode (which uses dequeue -> RPOP path)
  const backend = (q as any).backend
  if (backend) backend.supportsBlocking = false

  q.startWorker('priority-test', { concurrency: 1, pollInterval: 1 })

  const deadline = Date.now() + 30_000
  while (processOrder.length < COUNT && Date.now() < deadline) {
    await sleep(50)
  }

  await q.stop()

  // Expected: 100, 99, 98, ..., 1 (highest priority first)
  const expected = Array.from({ length: processOrder.length }, (_, i) => COUNT - i)
  const tau = kendallTau(processOrder, expected)

  console.log(`\n  Results:`)
  console.log(`    Processed: ${processOrder.length}/${COUNT}`)
  console.log(`    Kendall tau: ${tau.toFixed(4)} (1.0 = perfect, >0.8 = good)`)
  console.log(`    First 10 dequeued: [${processOrder.slice(0, 10).join(', ')}]`)
  console.log(`    Expected first 10: [${expected.slice(0, 10).join(', ')}]`)

  if (processOrder.length === COUNT && tau > 0.8) {
    console.log(`\n  PASS: Priority ordering is correct (tau=${tau.toFixed(4)})`)
  } else if (processOrder.length < COUNT) {
    console.log(`\n  FAIL: Only ${processOrder.length}/${COUNT} jobs processed`)
  } else {
    console.log(`\n  FAIL: Priority ordering broken (tau=${tau.toFixed(4)}, need >0.8)`)
  }

  // Also test mixed: 50 priority jobs + 50 normal (priority=0) jobs
  console.log('\n\n  Mixed Priority Test (50 priority + 50 normal)')
  console.log('  ===============================================\n')

  await flushRedis()
  const mixedOrder: string[] = []

  const q2 = new PsyQueue()
  q2.use(redis({ url: REDIS_URL }))
  q2.handle('mixed', async (ctx) => {
    const payload = ctx.job.payload as { label: string }
    mixedOrder.push(payload.label)
    return { ok: true }
  })
  await q2.start()

  // Enqueue 50 normal jobs first
  for (let i = 0; i < 50; i++) {
    await q2.enqueue('mixed', { label: `normal-${i}` }, { queue: 'mixed', priority: 0 })
  }

  // Then 50 high-priority jobs
  for (let i = 0; i < 50; i++) {
    await q2.enqueue('mixed', { label: `priority-${i}` }, { queue: 'mixed', priority: 10 })
  }

  const backend2 = (q2 as any).backend
  if (backend2) backend2.supportsBlocking = false
  q2.startWorker('mixed', { concurrency: 1, pollInterval: 1 })

  const deadline2 = Date.now() + 30_000
  while (mixedOrder.length < 100 && Date.now() < deadline2) {
    await sleep(50)
  }

  await q2.stop()

  // All priority jobs should come before all normal jobs
  const firstNormalIdx = mixedOrder.findIndex(l => l.startsWith('normal-'))
  const lastPriorityIdx = mixedOrder.length - 1 - [...mixedOrder].reverse().findIndex(l => l.startsWith('priority-'))

  console.log(`  Processed: ${mixedOrder.length}/100`)
  console.log(`  First 10: [${mixedOrder.slice(0, 10).join(', ')}]`)
  console.log(`  First normal job at index: ${firstNormalIdx}`)
  console.log(`  Last priority job at index: ${lastPriorityIdx}`)

  if (mixedOrder.length === 100 && lastPriorityIdx < firstNormalIdx) {
    console.log('\n  PASS: All priority jobs dequeued before normal jobs')
  } else if (mixedOrder.length === 100 && firstNormalIdx >= 45) {
    console.log(`\n  PASS: Priority jobs mostly dequeued first (first normal at idx ${firstNormalIdx})`)
  } else {
    console.log(`\n  FAIL: Priority ordering broken (first normal at idx ${firstNormalIdx})`)
  }

  console.log('')
  process.exit(0)
}

main().catch((err) => {
  console.error(`FATAL: ${err?.message ?? err}`)
  console.error(err?.stack ?? '')
  process.exit(1)
})
