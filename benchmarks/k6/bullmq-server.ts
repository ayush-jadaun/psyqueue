import express from 'express'
import { createHash } from 'crypto'
import { Queue, Worker } from 'bullmq'
import RedisModule from 'ioredis'

const Redis = (RedisModule as any).default ?? RedisModule
const app = express()
app.use(express.json())

const conn = { host: '127.0.0.1', port: 6381 }
const queue = new Queue('work', { connection: conn })

const worker = new Worker('work', async (job) => {
  const data = JSON.stringify(job.data)
  const reversed = data.split('').reverse().join('')
  return { hash: createHash('sha256').update(reversed).digest('hex') }
}, { connection: conn, concurrency: 20 })

app.post('/enqueue', async (req, res) => {
  try {
    const job = await queue.add('work', req.body.payload || req.body || {})
    res.json({ id: job.id })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})
app.get('/health', (_, res) => res.json({ ok: true, system: 'bullmq' }))

async function start() {
  const c = new Redis(conn); await c.flushdb(); await c.quit()
  await queue.waitUntilReady()
  app.listen(3002, () => process.stdout.write('BullMQ server on :3002\n'))
}
start().catch(e => { console.error(e); process.exit(1) })
