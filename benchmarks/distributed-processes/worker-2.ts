// WORKER 2 — Separate process
import { PsyQueue } from '../../packages/core/src/index.js'
import { redis } from '../../packages/backend-redis/src/index.js'
import { writeFileSync } from 'fs'
import { join } from 'path'
import { createHash } from 'crypto'

const OUT = join(import.meta.dirname || '.', '..', 'dist-output')
const q = new PsyQueue()
q.use(redis({ url: 'redis://127.0.0.1:6381' }))

let count = 0
q.handle('dist-work', async (ctx) => {
  const { id, data } = ctx.job.payload as any
  const hash = createHash('sha256').update(JSON.stringify(data)).digest('hex')
  writeFileSync(join(OUT, 'result-' + id + '.txt'), 'worker-2:' + hash)
  count++
  return { worker: 2, hash }
})

await q.start()
const be = (q as any).backend; be.supportsBlocking = false
q.startWorker('dist-work', { concurrency: 5, pollInterval: 1 })
process.stdout.write('WORKER-2 STARTED (PID ' + process.pid + ')\n')

setTimeout(async () => {
  await q.stop()
  process.stdout.write('WORKER-2 DONE: processed ' + count + ' jobs (PID ' + process.pid + ')\n')
  process.exit(0)
}, 20000)
