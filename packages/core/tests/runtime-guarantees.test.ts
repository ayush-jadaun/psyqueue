/**
 * Runtime guarantees, checked against every backend through the real
 * PsyQueue API (processNext and startWorker), not adapter helpers.
 * SQLite always runs; Redis and Postgres run when reachable on localhost.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PsyQueue } from '../src/kernel.js'
import type { BackendAdapter, PsyPlugin } from '../src/types.js'
import { sqlite } from '../../backend-sqlite/src/index.js'
import { redis } from '../../backend-redis/src/index.js'
import { postgres } from '../../backend-postgres/src/index.js'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const PG_URL = 'postgres://psyqueue:psyqueue@localhost:5432/psyqueue_test'

async function reachable(plugin: PsyPlugin): Promise<boolean> {
  const q = new PsyQueue()
  q.use(plugin)
  try {
    await Promise.race([q.start(), sleep(10_000).then(() => { throw new Error('timeout') })])
    await q.stop()
    return true
  } catch {
    await q.stop().catch(() => {})
    return false
  }
}

const tmp = mkdtempSync(join(tmpdir(), 'psyq-guarantees-'))
let n = 0
const uid = () => `${Date.now().toString(36)}${n++}`

interface BackendCase {
  name: string
  available: boolean
  /** Instances made with the same `shared` value see the same data. */
  plugin: (shared: string) => PsyPlugin
}

const cases: BackendCase[] = [
  { name: 'sqlite', available: true, plugin: s => sqlite({ path: join(tmp, `${s}.db`) }) },
  {
    name: 'redis',
    available: await reachable(redis({ keyPrefix: 'psyq_probe' })),
    plugin: s => redis({ keyPrefix: `psyq_g_${s}` }),
  },
  {
    name: 'postgres',
    available: await reachable(postgres({ connectionString: PG_URL })),
    plugin: () => postgres({ connectionString: PG_URL }), // isolation via unique queue names
  },
]

afterEach(() => {})
process.on('exit', () => { try { rmSync(tmp, { recursive: true, force: true }) } catch { /* locked on Windows */ } })

for (const bc of cases) {
  describe.skipIf(!bc.available)(`runtime guarantees – ${bc.name}`, () => {
    const open: PsyQueue[] = []

    afterEach(async () => {
      for (const q of open.splice(0)) await q.stop().catch(() => {})
    })

    async function make(shared = uid()): Promise<{ q: PsyQueue; shared: string; backend: BackendAdapter }> {
      const q = new PsyQueue()
      q.use(bc.plugin(shared))
      await q.start()
      open.push(q)
      return { q, shared, backend: q.getExposed('backend') as unknown as BackendAdapter }
    }

    it('process middleware wraps the handler (runs around it and sees its errors)', async () => {
      const { q } = await make()
      const queue = `wrap_${uid()}`
      const order: string[] = []
      const seen: string[] = []
      q.pipeline('process', async (_ctx, next) => {
        order.push('before')
        try { await next() } catch (e) { seen.push((e as Error).message); throw e }
        order.push('after')
      })
      q.handle('ok', async () => { order.push('handler') })
      q.handle('bad', async () => { throw new Error('boom') })

      await q.enqueue('ok', {}, { queue })
      await q.processNext(queue)
      expect(order).toEqual(['before', 'handler', 'after'])

      await q.enqueue('bad', {}, { queue, maxRetries: 1 })
      await q.processNext(queue)
      expect(seen).toEqual(['boom'])
    })

    it('runs the complete and fail pipelines', async () => {
      const { q } = await make()
      const queue = `stages_${uid()}`
      const stages: string[] = []
      q.pipeline('complete', async (ctx, next) => { stages.push(`complete:${ctx.job.name}`); await next() })
      q.pipeline('fail', async (ctx, next) => { stages.push(`fail:${ctx.job.name}`); await next() })
      q.handle('ok', async () => 1)
      q.handle('bad', async () => { throw new Error('x') })
      await q.enqueue('ok', {}, { queue })
      await q.enqueue('bad', {}, { queue, maxRetries: 1 })
      await q.processNext(queue)
      await q.processNext(queue)
      expect(stages).toEqual(['complete:ok', 'fail:bad'])
    })

    it('stores the handler result', async () => {
      const { q, backend } = await make()
      const queue = `result_${uid()}`
      q.handle('r', async () => ({ sent: 3 }))
      const id = await q.enqueue('r', {}, { queue })
      await q.processNext(queue)
      expect((await backend.getJob(id))!.result).toEqual({ sent: 3 })
    })

    it('does not run a backed-off retry before its delay', async () => {
      const { q, backend } = await make()
      const queue = `delay_${uid()}`
      let runs = 0
      q.handle('flaky', async () => { runs++; throw new Error('transient timeout') })
      const id = await q.enqueue('flaky', {}, { queue, maxRetries: 3, backoff: 'fixed', backoffBase: 5000, backoffJitter: false })
      await q.processNext(queue)
      expect(await q.processNext(queue)).toBe(false)
      expect(runs).toBe(1)
      expect((await backend.getJob(id))!.attempt).toBe(2)
    })

    it('enqueueBulk goes through the enqueue pipeline', async () => {
      const { q } = await make()
      const queue = `bulk_${uid()}`
      const seen: unknown[] = []
      q.pipeline('enqueue', async (ctx, next) => { seen.push(ctx.job.payload); await next() }, { phase: 'guard' })
      const ids = await q.enqueueBulk([1, 2, 3].map(i => ({ name: 'b', payload: i, opts: { queue } })))
      expect(ids).toHaveLength(3)
      expect(seen).toEqual([1, 2, 3])
    })

    it('does not emit job:enqueued when a plugin short-circuits the enqueue', async () => {
      const { q } = await make()
      let events = 0
      q.events.on('job:enqueued', () => { events++ })
      q.pipeline('enqueue', async () => { /* swallow: no next() */ }, { phase: 'guard' })
      await q.enqueue('x', {}, { queue: `sc_${uid()}` })
      expect(events).toBe(0)
    })

    it('dead-letters a job with no handler and emits job:dead', async () => {
      const { q, backend } = await make()
      const queue = `nohandler_${uid()}`
      let dead = 0
      q.events.on('job:dead', () => { dead++ })
      const id = await q.enqueue('ghost', {}, { queue })
      await q.processNext(queue)
      expect(dead).toBe(1)
      expect((await backend.getJob(id))!.status).toBe('dead')
    })

    it('ignores a nack from a worker that no longer owns the job', async () => {
      const { q, backend } = await make()
      const queue = `owner_${uid()}`
      const id = await q.enqueue('j', {}, { queue })
      const [first] = await backend.dequeue(queue, 1)
      await sleep(80)
      expect(await backend.recoverStaleJobs!(queue, 50)).toEqual([id])
      const [second] = await backend.dequeue(queue, 1)
      expect(second!.completionToken).not.toBe(first!.completionToken)

      await backend.nack(id, { deadLetter: true, reason: 'late', completionToken: first!.completionToken })
      expect((await backend.getJob(id))!.status).toBe('active')
      expect((await backend.ack(id, first!.completionToken)).alreadyCompleted).toBe(true)
      expect((await backend.ack(id, second!.completionToken)).alreadyCompleted).toBe(false)
    })

    it('recovers a job whose worker crashed mid-run', async () => {
      const a = await make()
      const queue = `crash_${uid()}`
      await a.q.enqueue('work', {}, { queue })
      await a.backend.dequeue(queue, 1) // worker A takes the job, then "dies"

      const b = await make(a.shared)
      let done = 0
      b.q.handle('work', async () => { done++ })
      b.q.startWorker(queue, { leaseMs: 300, blockTimeout: 300, pollInterval: 20 })
      const deadline = Date.now() + 5000
      while (done === 0 && Date.now() < deadline) await sleep(50)
      expect(done).toBe(1)
    }, 10_000)

    it('runs a job longer than the lease exactly once across two workers', async () => {
      const a = await make()
      const b = await make(a.shared)
      const queue = `long_${uid()}`
      let runs = 0
      let completed = 0
      for (const w of [a, b]) {
        w.q.handle('long', async () => { runs++; await sleep(1200) })
        w.q.events.on('job:completed', () => { completed++ })
      }
      await a.q.enqueue('long', {}, { queue })
      a.q.startWorker(queue, { leaseMs: 300, blockTimeout: 300, pollInterval: 20 })
      await sleep(100)
      b.q.startWorker(queue, { leaseMs: 300, blockTimeout: 300, pollInterval: 20 })
      const deadline = Date.now() + 5000
      while (completed === 0 && Date.now() < deadline) await sleep(50)
      await sleep(400)
      expect(runs).toBe(1)
      expect(completed).toBe(1)
    }, 10_000)
  })
}
