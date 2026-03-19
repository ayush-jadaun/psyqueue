import express from 'express'
import { createHash } from 'crypto'
import { PsyQueue } from '../../packages/core/src/index.js'
import { redis } from '../../packages/backend-redis/src/index.js'

const app = express()
app.use(express.json())
const q = new PsyQueue()
q.use(redis({ url: 'redis://127.0.0.1:6381' }))

q.handle('work', async (ctx) => {
  const data = JSON.stringify(ctx.job.payload)
  const reversed = data.split('').reverse().join('')
  return { hash: createHash('sha256').update(reversed).digest('hex') }
})

app.post('/enqueue', async (req, res) => {
  try {
    const id = await q.enqueue('work', req.body.payload || req.body || {})
    res.json({ id })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})
app.get('/health', (_, res) => res.json({ ok: true, system: 'psyqueue' }))

async function start() {
  await q.start()
  const cl = (q as any).backend.getClient(); await cl.flushdb()
  const be = (q as any).backend; be.supportsBlocking = false
  q.startWorker('work', { concurrency: 20, pollInterval: 1 })
  app.listen(3001, () => process.stdout.write('PsyQueue server on :3001\n'))
}
start().catch(e => { console.error(e); process.exit(1) })
