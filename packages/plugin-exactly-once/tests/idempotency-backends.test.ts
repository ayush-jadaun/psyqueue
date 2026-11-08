/**
 * Idempotent enqueue against real backends, through two PsyQueue instances
 * sharing one store (= two processes). SQLite always runs; Redis/Postgres
 * run when reachable on localhost.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PsyQueue } from '../../core/src/index.js'
import { DuplicateJobError } from '@psyqueue/core' // same class the plugin throws
import type { BackendAdapter, PsyPlugin } from '../../core/src/index.js'
import { sqlite } from '../../backend-sqlite/src/index.js'
import { redis } from '../../backend-redis/src/index.js'
import { postgres } from '../../backend-postgres/src/index.js'
import { exactlyOnce } from '../src/index.js'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const PG_URL = 'postgres://psyqueue:psyqueue@localhost:5432/psyqueue_test'
const tmp = mkdtempSync(join(tmpdir(), 'psyq-idem-'))
let n = 0
const uid = () => `${Date.now().toString(36)}${n++}`

async function reachable(plugin: PsyPlugin): Promise<boolean> {
  const q = new PsyQueue()
  q.use(plugin)
  try {
    await Promise.race([q.start(), sleep(1500).then(() => { throw new Error('timeout') })])
    await q.stop()
    return true
  } catch {
    await q.stop().catch(() => {})
    return false
  }
}

const cases = [
  { name: 'sqlite', available: true, plugin: (s: string) => sqlite({ path: join(tmp, `${s}.db`) }) },
  { name: 'redis', available: await reachable(redis({ keyPrefix: 'psyq_probe' })), plugin: (s: string) => redis({ keyPrefix: `psyq_i_${s}` }) },
  { name: 'postgres', available: await reachable(postgres({ connectionString: PG_URL })), plugin: (_s: string) => postgres({ connectionString: PG_URL }) },
]

for (const bc of cases) {
  describe.skipIf(!bc.available)(`idempotent enqueue – ${bc.name}`, () => {
    const open: PsyQueue[] = []
    afterEach(async () => { for (const q of open.splice(0)) await q.stop().catch(() => {}) })

    async function make(shared: string, opts?: Parameters<typeof exactlyOnce>[0], withPlugin = true) {
      const q = new PsyQueue()
      q.use(bc.plugin(shared))
      if (withPlugin) q.use(exactlyOnce(opts))
      await q.start()
      open.push(q)
      return { q, backend: q.getExposed('backend') as unknown as BackendAdapter }
    }
    const count = async (b: BackendAdapter, queue: string) => (await b.listJobs({ queue, limit: 1000 })).total

    it('dedupes across two processes sharing the backend', async () => {
      const s = uid(); const queue = `xp_${s}`
      const a = await make(s); const b = await make(s)
      const id1 = await a.q.enqueue('charge', {}, { queue, idempotencyKey: 'k' })
      const id2 = await b.q.enqueue('charge', {}, { queue, idempotencyKey: 'k' })
      expect(id2).toBe(id1)
      expect(await count(a.backend, queue)).toBe(1)
    })

    it('dedupes concurrent enqueues racing from two processes', async () => {
      const s = uid(); const queue = `race_${s}`
      const a = await make(s); const b = await make(s)
      const ids = await Promise.all(Array.from({ length: 20 }, (_, i) =>
        (i % 2 ? a : b).q.enqueue('charge', {}, { queue, idempotencyKey: 'k' })))
      expect(new Set(ids).size).toBe(1)
      expect(await count(a.backend, queue)).toBe(1)
    })

    it('survives a restart', async () => {
      const s = uid(); const queue = `rs_${s}`
      const a = await make(s)
      const id1 = await a.q.enqueue('charge', {}, { queue, idempotencyKey: 'k' })
      await a.q.stop()
      const b = await make(s)
      expect(await b.q.enqueue('charge', {}, { queue, idempotencyKey: 'k' })).toBe(id1)
    })

    it('works without the plugin (core feature)', async () => {
      const s = uid(); const queue = `core_${s}`
      const a = await make(s, undefined, false)
      const id1 = await a.q.enqueue('charge', {}, { queue, idempotencyKey: 'k' })
      expect(await a.q.enqueue('charge', {}, { queue, idempotencyKey: 'k' })).toBe(id1)
    })

    it('dedupes enqueueBulk, within the batch and against existing jobs', async () => {
      const s = uid(); const queue = `bulk_${s}`
      const a = await make(s)
      const existing = await a.q.enqueue('charge', {}, { queue, idempotencyKey: 'old' })
      const ids = await a.q.enqueueBulk([
        { name: 'charge', payload: 1, opts: { queue, idempotencyKey: 'new' } },
        { name: 'charge', payload: 2, opts: { queue, idempotencyKey: 'new' } },
        { name: 'charge', payload: 3, opts: { queue, idempotencyKey: 'old' } },
        { name: 'charge', payload: 4, opts: { queue } },
      ])
      expect(ids[1]).toBe(ids[0])
      expect(ids[2]).toBe(existing)
      expect(await count(a.backend, queue)).toBe(3)
    })

    it('frees the key once its job is dead', async () => {
      const s = uid(); const queue = `dead_${s}`
      const a = await make(s)
      a.q.handle('charge', async () => { throw new Error('fatal') })
      const id1 = await a.q.enqueue('charge', {}, { queue, idempotencyKey: 'k', maxRetries: 1 })
      await a.q.processNext(queue)
      expect((await a.backend.getJob(id1))!.status).toBe('dead')
      const id2 = await a.q.enqueue('charge', {}, { queue, idempotencyKey: 'k' })
      expect(id2).not.toBe(id1)
    })

    it('scopes keys by job name', async () => {
      const s = uid(); const queue = `name_${s}`
      const a = await make(s)
      const email = await a.q.enqueue('email.send', {}, { queue, idempotencyKey: '42' })
      const sms = await a.q.enqueue('sms.send', {}, { queue, idempotencyKey: '42' })
      expect(sms).not.toBe(email)
    })

    it('emits job:enqueued only for the original', async () => {
      const s = uid(); const queue = `ev_${s}`
      const a = await make(s)
      let events = 0
      a.q.events.on('job:enqueued', () => { events++ })
      await a.q.enqueue('charge', {}, { queue, idempotencyKey: 'k' })
      await a.q.enqueue('charge', {}, { queue, idempotencyKey: 'k' })
      expect(events).toBe(1)
    })

    it('rejects duplicates in reject mode', async () => {
      const s = uid(); const queue = `rej_${s}`
      const a = await make(s, { onDuplicate: 'reject' })
      const id1 = await a.q.enqueue('charge', {}, { queue, idempotencyKey: 'k' })
      const err = await a.q.enqueue('charge', {}, { queue, idempotencyKey: 'k' }).catch(e => e)
      expect(err).toBeInstanceOf(DuplicateJobError)
      expect((err as DuplicateJobError).existingJobId).toBe(id1)
    })

    it('allows the key again after the window', async () => {
      const s = uid(); const queue = `win_${s}`
      const a = await make(s, { window: '150ms' })
      const id1 = await a.q.enqueue('charge', {}, { queue, idempotencyKey: 'k' })
      await sleep(300)
      expect(await a.q.enqueue('charge', {}, { queue, idempotencyKey: 'k' })).not.toBe(id1)
    })

    it('dedupes delayed (scheduled) jobs', async () => {
      const s = uid(); const queue = `sch_${s}`
      const a = await make(s)
      const runAt = new Date(Date.now() + 60_000)
      const id1 = await a.q.enqueue('charge', {}, { queue, idempotencyKey: 'k', runAt })
      expect(await a.q.enqueue('charge', {}, { queue, idempotencyKey: 'k', runAt })).toBe(id1)
      expect((await a.backend.getJob(id1))!.status).toBe('scheduled')
      expect(await a.q.processNext(queue)).toBe(false) // not due yet
    })
  })
}
