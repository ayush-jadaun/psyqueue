import { PsyQueue } from 'psyqueue'
import { redis } from '@psyqueue/backend-redis'

const N = 5000

// ============================================================
// PsyQueue benchmark — measure FULL lifecycle (including ack)
// ============================================================
const q = new PsyQueue()
q.use(redis({ url: 'redis://127.0.0.1:6381' }))

// Count jobs AFTER completion event (includes ack), same as BullMQ
let psyCompleted = 0
q.events.on('job:completed', () => { psyCompleted++ })

q.handle('bench', async () => ({ ok: true }))
await q.start()

// Flush stale data
const client = (q as any).backend.getClient()
await client.flushdb()

// Enqueue
const enqStart = performance.now()
for (let i = 0; i < N; i++) await q.enqueue('bench', { i })
const enqMs = performance.now() - enqStart
process.stdout.write(`PsyQueue Enqueue: ${N} in ${enqMs.toFixed(0)}ms = ${Math.round(N/enqMs*1000)}/sec\n`)

// Process — count via job:completed event (fires AFTER ack)
psyCompleted = 0
const backend = (q as any).backend
backend.supportsBlocking = false
const psyStart = performance.now()
q.startWorker('bench', { concurrency: 10, pollInterval: 1 })
while (psyCompleted < N) await new Promise(r => setTimeout(r, 2))
const psyMs = performance.now() - psyStart
process.stdout.write(`PsyQueue Process: ${N} in ${psyMs.toFixed(0)}ms = ${Math.round(N/psyMs*1000)}/sec (measured at job:completed event, after ack)\n`)
await q.stop()

// ============================================================
// BullMQ benchmark — measure via 'completed' event (after ack)
// ============================================================
try {
  const { Queue, Worker } = await import('bullmq')

  const bq = new Queue('bench-' + Date.now(), { connection: { host: '127.0.0.1', port: 6381 } })
  await bq.waitUntilReady()

  const bEnqStart = performance.now()
  for (let i = 0; i < N; i++) await bq.add('job', { i })
  const bEnqMs = performance.now() - bEnqStart
  process.stdout.write(`BullMQ   Enqueue: ${N} in ${bEnqMs.toFixed(0)}ms = ${Math.round(N/bEnqMs*1000)}/sec\n`)

  let bCompleted = 0
  const bStart = performance.now()
  const w = new Worker(bq.name, async () => ({ ok: true }), { connection: { host: '127.0.0.1', port: 6381 }, concurrency: 10 })
  await new Promise<void>(r => { w.on('completed', () => { bCompleted++; if (bCompleted >= N) r() }) })
  const bMs = performance.now() - bStart
  process.stdout.write(`BullMQ   Process: ${N} in ${bMs.toFixed(0)}ms = ${Math.round(N/bMs*1000)}/sec (measured at 'completed' event, after ack)\n`)

  await w.close()
  await bq.obliterate({ force: true })
  await bq.close()
} catch (e: any) {
  process.stdout.write('BullMQ skipped: ' + e.message + '\n')
}

process.exit(0)
