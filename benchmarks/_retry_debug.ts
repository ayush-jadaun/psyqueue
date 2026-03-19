import { PsyQueue } from 'psyqueue'
import { redis } from '@psyqueue/backend-redis'

const q = new PsyQueue()
q.use(redis({ url: 'redis://127.0.0.1:6381' }))
let attempts = 0
q.handle('retry-test', async () => {
  attempts++
  process.stdout.write('Attempt ' + attempts + '\n')
  if (attempts < 3) throw new Error('transient failure')
  return { ok: true }
})
await q.start()
const cl = (q as any).backend.getClient()
await cl.flushdb()
await q.enqueue('retry-test', {}, { maxRetries: 5 })

for (let i = 0; i < 6; i++) {
  const r = await q.processNext('retry-test')
  process.stdout.write('processNext[' + i + '] returned: ' + r + '\n')
}
process.stdout.write('Total attempts: ' + attempts + '\n')
await q.stop()
process.exit(0)
