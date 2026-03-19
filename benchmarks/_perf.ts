import { PsyQueue } from 'psyqueue'
import { redis } from '@psyqueue/backend-redis'

const N = 1000
const q = new PsyQueue()
q.use(redis({ url: 'redis://127.0.0.1:6381' }))
let processed = 0
q.handle('bench', async () => { processed++; return {} })
await q.start()

// Flush stale data from previous runs
const client = (q as any).backend.getClient()
await client.flushdb()

for (let i = 0; i < N; i++) await q.enqueue('bench', { i })
process.stdout.write('Enqueued ' + N + '\n')

processed = 0
const backend = (q as any).backend
backend.supportsBlocking = false
const t = performance.now()
q.startWorker('bench', { concurrency: 10, pollInterval: 1 })
while (processed < N) await new Promise(r => setTimeout(r, 2))
const ms = performance.now() - t
process.stdout.write('PsyQueue: ' + N + ' jobs in ' + ms.toFixed(0) + 'ms = ' + Math.round(N / ms * 1000) + ' jobs/sec\n')
await q.stop()

// BullMQ comparison
try {
  const { Queue, Worker } = await import('bullmq')
  const bq = new Queue('bench-' + Date.now(), { connection: { host: '127.0.0.1', port: 6381 } })
  await bq.waitUntilReady()
  for (let i = 0; i < N; i++) await bq.add('job', { i })
  let bc = 0
  const bt = performance.now()
  const w = new Worker(bq.name, async () => ({ ok: true }), { connection: { host: '127.0.0.1', port: 6381 }, concurrency: 10 })
  await new Promise<void>(r => { w.on('completed', () => { bc++; if (bc >= N) r() }) })
  const bms = performance.now() - bt
  process.stdout.write('BullMQ:   ' + N + ' jobs in ' + bms.toFixed(0) + 'ms = ' + Math.round(N / bms * 1000) + ' jobs/sec\n')
  await w.close(); await bq.obliterate({ force: true }); await bq.close()
} catch (e: any) { process.stdout.write('BullMQ skipped: ' + e.message + '\n') }
process.exit(0)
