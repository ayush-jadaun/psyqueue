import { PsyQueue } from 'psyqueue'
import { redis } from '@psyqueue/backend-redis'

const N = 1000

// PsyQueue Redis benchmark
const q = new PsyQueue()
q.use(redis({ url: 'redis://127.0.0.1:6381' }))
let processed = 0
q.handle('bench', async () => { processed++; return {} })
await q.start()

// Enqueue
const t1 = performance.now()
for (let i = 0; i < N; i++) await q.enqueue('bench', { i })
const enqMs = performance.now() - t1
process.stdout.write(`PsyQueue Enqueue: ${N} jobs in ${enqMs.toFixed(0)}ms = ${Math.round(N/enqMs*1000)} jobs/sec\n`)

// Process with worker (poll mode, concurrency:10)
processed = 0
const backend = (q as any).backend
backend.supportsBlocking = false
const t2 = performance.now()
q.startWorker('bench', { concurrency: 10, pollInterval: 1 })
while (processed < N) await new Promise(r => setTimeout(r, 2))
const procMs = performance.now() - t2
process.stdout.write(`PsyQueue Process: ${N} jobs in ${procMs.toFixed(0)}ms = ${Math.round(N/procMs*1000)} jobs/sec\n`)
await q.stop()

// BullMQ benchmark
try {
  const bullmq = await import('bullmq')
  const { Queue, Worker } = bullmq

  const bq = new Queue('bullmq-bench-' + Date.now(), { connection: { host: '127.0.0.1', port: 6381 } })
  await bq.waitUntilReady()

  const t3 = performance.now()
  for (let i = 0; i < N; i++) await bq.add('job', { i })
  const bEnqMs = performance.now() - t3
  process.stdout.write(`BullMQ  Enqueue: ${N} jobs in ${bEnqMs.toFixed(0)}ms = ${Math.round(N/bEnqMs*1000)} jobs/sec\n`)

  let bProcessed = 0
  const t4 = performance.now()
  const w = new Worker(bq.name, async () => ({ ok: true }), { connection: { host: '127.0.0.1', port: 6381 }, concurrency: 10 })
  await new Promise<void>(resolve => {
    w.on('completed', () => { bProcessed++; if (bProcessed >= N) resolve() })
  })
  const bProcMs = performance.now() - t4
  process.stdout.write(`BullMQ  Process: ${N} jobs in ${bProcMs.toFixed(0)}ms = ${Math.round(N/bProcMs*1000)} jobs/sec\n`)

  await w.close()
  await bq.obliterate({ force: true })
  await bq.close()
} catch (e: any) {
  process.stdout.write('BullMQ skipped: ' + e.message + '\n')
}

process.exit(0)
