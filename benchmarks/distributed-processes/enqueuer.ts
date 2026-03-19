// ENQUEUER — Separate process, only enqueues jobs
import { PsyQueue } from '../../packages/core/src/index.js'
import { redis } from '../../packages/backend-redis/src/index.js'

const q = new PsyQueue()
q.use(redis({ url: 'redis://127.0.0.1:6381' }))
q.handle('dist-work', async () => ({}))
await q.start()

process.stdout.write('ENQUEUER STARTED (PID ' + process.pid + ')\n')

// Enqueue 200 jobs
for (let i = 0; i < 200; i++) {
  await q.enqueue('dist-work', {
    id: i,
    data: { index: i, payload: 'job-data-' + i, timestamp: Date.now() }
  })
}
process.stdout.write('ENQUEUER: enqueued 200 jobs\n')
await q.stop()
process.exit(0)
