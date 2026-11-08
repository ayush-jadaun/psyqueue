/**
 * Tenancy guarantees through the real worker path, on every backend.
 * Two PsyQueue instances on one store stand in for two processes.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PsyQueue } from '../../core/src/index.js'
import type { BackendAdapter, PsyPlugin } from '../../core/src/index.js'
import { RateLimitError } from '@psyqueue/core'
import { sqlite } from '../../backend-sqlite/src/index.js'
import { redis } from '../../backend-redis/src/index.js'
import { postgres } from '../../backend-postgres/src/index.js'
import { tenancy, type TenancyOpts } from '../src/index.js'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const PG_URL = 'postgres://psyqueue:psyqueue@localhost:5432/psyqueue_test'
const tmp = mkdtempSync(join(tmpdir(), 'psyq-tenancy-'))
let n = 0
const uid = () => `${Date.now().toString(36)}${n++}`

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

const cases = [
  { name: 'sqlite', available: true, plugin: (s: string) => sqlite({ path: join(tmp, `${s}.db`) }) },
  { name: 'redis', available: await reachable(redis({ keyPrefix: 'psyq_probe' })), plugin: (s: string) => redis({ keyPrefix: `psyq_t_${s}` }) },
  { name: 'postgres', available: await reachable(postgres({ connectionString: PG_URL })), plugin: (_s: string) => postgres({ connectionString: PG_URL }) },
]

const tiers: TenancyOpts['tiers'] = {
  free: { rateLimit: { max: 1000, window: '1m' }, concurrency: 50, weight: 1 },
  pro: { rateLimit: { max: 1000, window: '1m' }, concurrency: 50, weight: 4 },
  vip: { rateLimit: { max: 1000, window: '1m' }, concurrency: 50, weight: 20 },
  single: { rateLimit: { max: 1000, window: '1m' }, concurrency: 1, weight: 1 },
  limited: { rateLimit: { max: 3, window: '1m' }, concurrency: 50, weight: 1 },
  persec: { rateLimit: { max: 1, window: '1s' }, concurrency: 50, weight: 1 },
}
/** Tenant ids look like "<tier>-<anything>" */
const resolveTier = async (tenantId: string) => tenantId.split('-')[0]!

for (const bc of cases) {
  describe.skipIf(!bc.available)(`tenancy – ${bc.name}`, () => {
    const open: PsyQueue[] = []
    afterEach(async () => { for (const q of open.splice(0)) await q.stop().catch(() => {}) })

    async function proc(shared: string, queue: string, extra: Partial<TenancyOpts> = {}) {
      const q = new PsyQueue()
      q.use(bc.plugin(shared))
      q.use(tenancy({ tiers, resolveTier, queues: [queue], ...extra }))
      await q.start()
      open.push(q)
      return { q, backend: q.getExposed('backend') as unknown as BackendAdapter }
    }
    const t = (tier: string) => `${tier}-${uid()}` // unique tenant per test

    async function runUntil(cond: () => boolean, ms = 8000) {
      const deadline = Date.now() + ms
      while (!cond() && Date.now() < deadline) await sleep(10)
    }

    it('does not leave a VIP job behind a noisy tenant backlog', async () => {
      const s = uid(); const queue = `vip_${s}`
      const { q } = await proc(s, queue)
      const noisy = t('free'); const vip = t('vip')
      const order: string[] = []
      q.handle('job', async (ctx) => { order.push(ctx.job.tenantId!) })
      for (let i = 0; i < 40; i++) await q.enqueue('job', {}, { queue, tenantId: noisy })
      await q.enqueue('job', {}, { queue, tenantId: vip })
      q.startWorker(queue, { concurrency: 1, batchSize: 1, pollInterval: 5 })
      await runUntil(() => order.length === 41)
      expect(order.indexOf(vip)).toBeLessThan(3)
    }, 15_000)

    it('splits workers by tier weight', async () => {
      const s = uid(); const queue = `weight_${s}`
      const { q } = await proc(s, queue)
      const free = t('free'); const pro = t('pro')
      const order: string[] = []
      q.handle('job', async (ctx) => { order.push(ctx.job.tenantId!) })
      for (let i = 0; i < 40; i++) {
        await q.enqueue('job', {}, { queue, tenantId: free })
        await q.enqueue('job', {}, { queue, tenantId: pro })
      }
      q.startWorker(queue, { concurrency: 1, batchSize: 1, pollInterval: 5 })
      await runUntil(() => order.length >= 25)
      const first = order.slice(0, 25)
      const proShare = first.filter(x => x === pro).length
      expect(proShare).toBeGreaterThanOrEqual(18) // weight 4:1 → ~20 of 25
    }, 15_000)

    it('enforces tier concurrency across two processes', async () => {
      const s = uid(); const queue = `conc_${s}`
      const a = await proc(s, queue); const b = await proc(s, queue)
      const tenant = t('single')
      let running = 0; let maxRunning = 0; let done = 0
      for (const w of [a, b]) {
        w.q.handle('job', async () => {
          running++; maxRunning = Math.max(maxRunning, running)
          await sleep(60)
          running--; done++
        })
      }
      for (let i = 0; i < 5; i++) await a.q.enqueue('job', {}, { queue, tenantId: tenant })
      a.q.startWorker(queue, { concurrency: 5, pollInterval: 5 })
      b.q.startWorker(queue, { concurrency: 5, pollInterval: 5 })
      await runUntil(() => done === 5)
      expect(done).toBe(5)
      expect(maxRunning).toBe(1)
    }, 15_000)

    it('still runs jobs without a tenant, and other tenants, beside a capped tenant', async () => {
      const s = uid(); const queue = `mixed_${s}`
      const { q } = await proc(s, queue)
      const capped = t('single'); const other = t('free')
      const seen: string[] = []
      q.handle('job', async (ctx) => { seen.push(ctx.job.tenantId ?? 'none'); if (ctx.job.tenantId === capped) await sleep(300) })
      await q.enqueue('job', {}, { queue, tenantId: capped })
      await q.enqueue('job', {}, { queue, tenantId: capped })
      await q.enqueue('job', {}, { queue })
      await q.enqueue('job', {}, { queue, tenantId: other })
      q.startWorker(queue, { concurrency: 4, pollInterval: 5 })
      await runUntil(() => seen.length === 4)
      expect(seen.slice(0, 3).sort()).toEqual([capped, 'none', other].sort())
    }, 15_000)

    it('retries a tenant job in a fair queue', async () => {
      const s = uid(); const queue = `retry_${s}`
      const { q } = await proc(s, queue)
      let attempts = 0
      q.handle('job', async () => { if (++attempts < 3) throw new Error('timeout') })
      await q.enqueue('job', {}, { queue, tenantId: t('single'), maxRetries: 3, backoff: 'fixed', backoffBase: 1, backoffJitter: false })
      q.startWorker(queue, { pollInterval: 5 })
      await runUntil(() => attempts >= 3)
      await sleep(50)
      expect(attempts).toBe(3)
    }, 15_000)

    it('frees a capped tenant slot when its worker crashed', async () => {
      const s = uid(); const queue = `crash_${s}`
      const a = await proc(s, queue)
      const tenant = t('single')
      await a.q.enqueue('job', {}, { queue, tenantId: tenant })
      await a.q.enqueue('job', {}, { queue, tenantId: tenant })
      await a.backend.dequeue(queue, 1) // worker A takes one and "dies"
      const b = await proc(s, queue)
      let done = 0
      b.q.handle('job', async () => { done++ })
      b.q.startWorker(queue, { leaseMs: 300, blockTimeout: 300, pollInterval: 10 })
      await runUntil(() => done === 2)
      expect(done).toBe(2)
    }, 15_000)

    it('applies rate limits across processes', async () => {
      const s = uid(); const queue = `rate_${s}`
      const a = await proc(s, queue); const b = await proc(s, queue)
      const tenant = t('limited')
      let accepted = 0; let rejected = 0
      for (let i = 0; i < 6; i++) {
        try { await (i % 2 ? a : b).q.enqueue('job', {}, { queue, tenantId: tenant }); accepted++ }
        catch (e) { expect(e).toBeInstanceOf(RateLimitError); rejected++ }
      }
      expect([accepted, rejected]).toEqual([3, 3])
    })

    it('applies rate limits to enqueueBulk', async () => {
      const s = uid(); const queue = `bulk_${s}`
      const { q, backend } = await proc(s, queue)
      const tenant = t('limited')
      await expect(q.enqueueBulk(Array.from({ length: 10 }, () => ({ name: 'job', payload: {}, opts: { queue, tenantId: tenant } }))))
        .rejects.toBeInstanceOf(RateLimitError)
      expect((await backend.listJobs({ queue })).total).toBe(0) // the batch is all-or-nothing
    })

    it('does not reset a tenant quota when its tier is set again', async () => {
      const s = uid(); const queue = `quota_${s}`
      const { q } = await proc(s, queue)
      const tenant = t('limited')
      for (let i = 0; i < 3; i++) await q.enqueue('job', {}, { queue, tenantId: tenant })
      await (q.getExposed('tenancy') as { setTier: (id: string, tier: string) => Promise<void> }).setTier(tenant, 'limited')
      await expect(q.enqueue('job', {}, { queue, tenantId: tenant })).rejects.toBeInstanceOf(RateLimitError)
    })

    it('uses a true sliding window (no early expiry)', async () => {
      const s = uid(); const queue = `window_${s}`
      const { q } = await proc(s, queue)
      const tenant = t('persec')
      await q.enqueue('job', {}, { queue, tenantId: tenant })
      await sleep(700)
      await expect(q.enqueue('job', {}, { queue, tenantId: tenant })).rejects.toBeInstanceOf(RateLimitError)
      await sleep(400)
      await expect(q.enqueue('job', {}, { queue, tenantId: tenant })).resolves.toBeTruthy()
    })

    it('exposes ctx.tenant to handlers', async () => {
      const s = uid(); const queue = `ctx_${s}`
      const { q } = await proc(s, queue)
      const tenant = t('pro')
      let seen: unknown
      q.handle('job', async (ctx) => { seen = ctx.tenant })
      await q.enqueue('job', {}, { queue, tenantId: tenant })
      await q.processNext(queue)
      expect(seen).toEqual({ id: tenant, tier: 'pro' })
    })

    it('falls back to defaultTier for unknown tiers, and throws without one', async () => {
      const s = uid(); const queue = `tier_${s}`
      const strict = await proc(s, queue)
      await expect(strict.q.enqueue('job', {}, { queue, tenantId: 'nosuchtier-1' })).rejects.toThrow(/Unknown tier/)
      const lenient = await proc(uid(), queue, { defaultTier: 'free' })
      await expect(lenient.q.enqueue('job', {}, { queue, tenantId: 'nosuchtier-1' })).resolves.toBeTruthy()
    })
  })
}
