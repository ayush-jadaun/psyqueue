import { PsyQueue } from 'psyqueue'
import { redis } from '@psyqueue/backend-redis'

const q = new PsyQueue()
q.use(redis({ url: 'redis://127.0.0.1:6381' }))
q.handle('x', async () => ({}))

try {
  await q.start()
  process.stdout.write('Connected\n')
  const id = await q.enqueue('x', { test: 1 })
  process.stdout.write('Enqueued: ' + id + '\n')
  const ok = await q.processNext('x')
  process.stdout.write('Processed: ' + ok + '\n')
  await q.stop()
  process.stdout.write('DONE\n')
} catch(e: any) {
  process.stderr.write('ERR: ' + e.message + '\n' + e.stack + '\n')
}
process.exit(0)
