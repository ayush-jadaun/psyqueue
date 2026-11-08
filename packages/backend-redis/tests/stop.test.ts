import { it, expect } from 'vitest'
import Redis from 'ioredis'
import { PsyQueue } from '../../core/src/index.js'
import { redis } from '../src/index.js'

async function checkRedis(): Promise<boolean> {
  const c = new Redis({ lazyConnect: true, connectTimeout: 1000, maxRetriesPerRequest: 0, retryStrategy: () => null })
  try { await c.connect(); await c.ping(); return true } catch { return false } finally { c.disconnect() }
}
const redisAvailable = await checkRedis()

it.skipIf(!redisAvailable)('stop() returns promptly while workers are blocked waiting for jobs', async () => {
  const q = new PsyQueue()
  q.use(redis({ keyPrefix: `psyq_stop_${Date.now()}` }))
  await q.start()
  q.handle('x', async () => {})
  q.startWorker('a', { blockTimeout: 5000 })
  q.startWorker('b', { blockTimeout: 5000 })
  await new Promise(r => setTimeout(r, 300)) // both now blocked in BLMOVE
  const t = Date.now()
  await q.stop()
  expect(Date.now() - t).toBeLessThan(1000)
})
