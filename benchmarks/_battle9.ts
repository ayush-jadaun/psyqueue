import { PsyQueue } from 'psyqueue'
import { redis } from '@psyqueue/backend-redis'
import RedisModule from 'ioredis'
const Redis = (RedisModule as any).default ?? RedisModule

const REDIS_HOST = '127.0.0.1'
const REDIS_PORT = 6381
const STALE = 50

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function flushRedis() {
  const c = new Redis({ host: REDIS_HOST, port: REDIS_PORT })
  await c.flushdb()
  await c.quit()
}

process.stdout.write('\n=== Battle 9: Stale Job Recovery ===\n\n')

// ── PsyQueue ──
process.stdout.write('PsyQueue: ')
await flushRedis()

const q = new PsyQueue()
q.use(redis({ url: `redis://${REDIS_HOST}:${REDIS_PORT}` }))
q.handle('stale', async () => ({ ok: true }))
await q.start()

const backend = (q as any).backend

for (let i = 0; i < STALE; i++) await q.enqueue('stale', { idx: i })
const active = await backend.dequeue('stale', STALE)
process.stdout.write(`${active.length} dequeued → `)

// Recover
let recovered: string[] = []
if (backend.recoverStaleJobs) {
  recovered = await backend.recoverStaleJobs('stale', 0)
  process.stdout.write(`${recovered.length} recovered → `)
} else {
  process.stdout.write('NO recoverStaleJobs method! → ')
}

// Process recovered
let processed = 0
for (let i = 0; i < STALE; i++) {
  const ok = await q.processNext('stale')
  if (ok) processed++
}
await q.stop()

const psyPass = active.length === STALE && recovered.length === STALE && processed === STALE
process.stdout.write(`${processed} re-processed → ${psyPass ? 'PASS' : 'FAIL'}\n`)

// ── BullMQ ──
process.stdout.write('BullMQ:   ')
await flushRedis()

const { Queue, Worker } = await import('bullmq')
const qn = `stale-${Date.now()}`
const bq = new Queue(qn, { connection: { host: REDIS_HOST, port: REDIS_PORT } })
await bq.waitUntilReady()

for (let i = 0; i < STALE; i++) await bq.add('stale', { idx: i })

let picked = 0
let stalled = 0
let completed = 0

const w = new Worker(qn, async () => {
  picked++
  await sleep(3000) // exceeds lockDuration → stall
  return { ok: true }
}, {
  connection: { host: REDIS_HOST, port: REDIS_PORT },
  concurrency: STALE,
  lockDuration: 1000,
  stalledInterval: 2000,
  maxStalledCount: 2,
})

w.on('stalled', () => { stalled++ })
w.on('completed', () => { completed++ })

const deadline = Date.now() + 30_000
while (completed < STALE && Date.now() < deadline) {
  await sleep(500)
  process.stdout.write(`\rBullMQ:   ${picked} picked, ${stalled} stalled, ${completed}/${STALE} completed...`)
}

await w.close().catch(() => {})
await bq.obliterate({ force: true }).catch(() => {})
await bq.close()

const bmqPass = completed === STALE
process.stdout.write(`\rBullMQ:   ${picked} picked, ${stalled} stalled, ${completed}/${STALE} completed → ${bmqPass ? 'PASS' : 'FAIL'}    \n`)

process.stdout.write(`\nResult: PsyQueue ${psyPass ? 'PASS' : 'FAIL'} | BullMQ ${bmqPass ? 'PASS' : 'FAIL'}\n`)
process.exit(0)
