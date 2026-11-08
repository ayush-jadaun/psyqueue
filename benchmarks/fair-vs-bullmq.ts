/**
 * Fair PsyQueue vs BullMQ processing benchmark.
 *
 * - Both libraries on default worker settings (no forced poll modes)
 * - Every run uses its own key prefix / queue name, so leftovers can't inflate counts
 * - All jobs enqueued first, then timed from worker start until N completions
 * - Median of RUNS runs per scenario
 *
 * Usage: npx tsx benchmarks/fair-vs-bullmq.ts   (Redis on REDIS_URL, default redis://127.0.0.1:6379)
 */
import Redis from 'ioredis'
import { Queue, Worker } from 'bullmq'
import { PsyQueue } from '../packages/core/src/index.js'
import { redis } from '../packages/backend-redis/src/index.js'

const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379'
const RUNS = Number(process.env.RUNS ?? 3)

const scenarios = [
  { name: 'no-op handler', jobs: 10_000, concurrency: 10, workMs: 0 },
  { name: '5 ms async work', jobs: 4_000, concurrency: 50, workMs: 5 },
  { name: '20 ms async work', jobs: 2_000, concurrency: 50, workMs: 20 },
]

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const work = (ms: number) => (ms > 0 ? sleep(ms) : Promise.resolve())
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!

let runId = 0
const nextId = () => `fairbench_${Date.now()}_${runId++}`

/** Deletes only the keys this run created. */
async function deleteKeys(pattern: string): Promise<void> {
  const c = new Redis(REDIS_URL)
  let cursor = '0'
  do {
    const [next, keys] = await c.scan(cursor, 'MATCH', pattern, 'COUNT', 1000)
    cursor = next
    if (keys.length > 0) await c.del(...keys)
  } while (cursor !== '0')
  await c.quit()
}

async function runPsyQueue(jobs: number, concurrency: number, workMs: number): Promise<number> {
  const prefix = nextId()
  const q = new PsyQueue()
  q.use(redis({ url: REDIS_URL, keyPrefix: prefix }))
  q.handle('bench', async () => { await work(workMs); return { ok: true } })
  await q.start()
  await q.enqueueBulk(Array.from({ length: jobs }, (_, i) => ({ name: 'bench', payload: { i } })))

  let done = 0
  let resolve!: () => void
  const finished = new Promise<void>(r => { resolve = r })
  q.events.on('job:completed', () => { if (++done === jobs) resolve() })

  const start = performance.now()
  q.startWorker('bench', { concurrency })
  await finished
  const ms = performance.now() - start
  await q.stop()
  await deleteKeys(`${prefix}:*`)
  return (jobs / ms) * 1000
}

async function runBullMQ(jobs: number, concurrency: number, workMs: number): Promise<number> {
  const name = nextId()
  const url = new URL(REDIS_URL)
  const connection = { host: url.hostname, port: Number(url.port || 6379) }
  const queue = new Queue(name, { connection })
  await queue.addBulk(Array.from({ length: jobs }, (_, i) => ({ name: 'bench', data: { i } })))

  let done = 0
  let resolve!: () => void
  const finished = new Promise<void>(r => { resolve = r })

  const start = performance.now()
  const worker = new Worker(name, async () => { await work(workMs); return { ok: true } }, { connection, concurrency })
  worker.on('completed', () => { if (++done === jobs) resolve() })
  await finished
  const ms = performance.now() - start
  await worker.close()
  await queue.obliterate({ force: true })
  await queue.close()
  return (jobs / ms) * 1000
}

console.log(`Redis: ${REDIS_URL}, ${RUNS} runs per scenario (median reported)\n`)
for (const s of scenarios) {
  // Ceiling: what a perfect queue with zero overhead could reach
  const ceiling = s.workMs > 0 ? Math.round((s.concurrency / s.workMs) * 1000) : null
  const psy: number[] = []
  const bull: number[] = []
  for (let r = 0; r < RUNS; r++) {
    // Alternate order so neither library always runs on a warmer process
    if (r % 2 === 0) {
      psy.push(await runPsyQueue(s.jobs, s.concurrency, s.workMs))
      bull.push(await runBullMQ(s.jobs, s.concurrency, s.workMs))
    } else {
      bull.push(await runBullMQ(s.jobs, s.concurrency, s.workMs))
      psy.push(await runPsyQueue(s.jobs, s.concurrency, s.workMs))
    }
  }
  const p = Math.round(median(psy))
  const b = Math.round(median(bull))
  console.log(`${s.name} — ${s.jobs} jobs, concurrency ${s.concurrency}${ceiling ? `, zero-overhead ceiling ${ceiling} jobs/s` : ''}`)
  console.log(`  PsyQueue: ${p} jobs/s   (runs: ${psy.map(Math.round).join(', ')})`)
  console.log(`  BullMQ:   ${b} jobs/s   (runs: ${bull.map(Math.round).join(', ')})`)
  console.log(`  Ratio:    ${(p / b).toFixed(2)}x\n`)
}
process.exit(0)
