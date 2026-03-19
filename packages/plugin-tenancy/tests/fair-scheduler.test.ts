import { describe, it, expect } from 'vitest'
import { FairScheduler } from '../src/fair-scheduler.js'
import { PsyQueue } from '@psyqueue/core'
import { sqlite } from '../../backend-sqlite/src/index.js'
import { tenancy } from '../src/index.js'

describe('FairScheduler', () => {
  it('weighted-fair-queue distributes proportionally', () => {
    const scheduler = new FairScheduler('weighted-fair-queue', {
      heavy: { weight: 10 },
      light: { weight: 1 },
    })
    const selections: string[] = []
    for (let i = 0; i < 11; i++) {
      selections.push(scheduler.selectTenant(['heavy', 'light']))
    }
    const heavyCount = selections.filter(s => s === 'heavy').length
    const lightCount = selections.filter(s => s === 'light').length
    expect(heavyCount).toBeGreaterThan(lightCount)
    // Roughly 10:1 ratio
    expect(heavyCount).toBeGreaterThanOrEqual(9)
  })

  it('round-robin cycles through tenants', () => {
    const scheduler = new FairScheduler('round-robin', {
      a: { weight: 1 }, b: { weight: 1 }, c: { weight: 1 },
    })
    const selections = []
    for (let i = 0; i < 6; i++) {
      selections.push(scheduler.selectTenant(['a', 'b', 'c']))
    }
    // Should cycle: a, b, c, a, b, c
    expect(selections).toEqual(['a', 'b', 'c', 'a', 'b', 'c'])
  })

  it('strict-priority always picks highest weight first', () => {
    const scheduler = new FairScheduler('strict-priority', {
      enterprise: { weight: 10 },
      free: { weight: 1 },
    })
    for (let i = 0; i < 5; i++) {
      expect(scheduler.selectTenant(['enterprise', 'free'])).toBe('enterprise')
    }
  })

  it('skips tenants not in pending list', () => {
    const scheduler = new FairScheduler('weighted-fair-queue', {
      a: { weight: 5 }, b: { weight: 5 },
    })
    // Only 'a' has pending jobs
    expect(scheduler.selectTenant(['a'])).toBe('a')
  })

  it('round-robin handles single tenant', () => {
    const scheduler = new FairScheduler('round-robin', {
      solo: { weight: 1 },
    })
    expect(scheduler.selectTenant(['solo'])).toBe('solo')
    expect(scheduler.selectTenant(['solo'])).toBe('solo')
  })

  it('strict-priority with equal weights picks first highest found', () => {
    const scheduler = new FairScheduler('strict-priority', {
      a: { weight: 5 },
      b: { weight: 5 },
      c: { weight: 1 },
    })
    // a and b have same weight — either could be picked, but not c
    const picked = scheduler.selectTenant(['a', 'b', 'c'])
    expect(['a', 'b']).toContain(picked)
  })

  it('weighted-fair-queue with single tenant always returns that tenant', () => {
    const scheduler = new FairScheduler('weighted-fair-queue', {
      only: { weight: 3 },
    })
    for (let i = 0; i < 5; i++) {
      expect(scheduler.selectTenant(['only'])).toBe('only')
    }
  })

  it('round-robin skips tenants not in pending list', () => {
    const scheduler = new FairScheduler('round-robin', {
      a: { weight: 1 }, b: { weight: 1 }, c: { weight: 1 },
    })
    // First call registers order a,b,c. Only give a and c pending
    const first = scheduler.selectTenant(['a', 'c'])
    // Should pick 'a' (position 0)
    expect(first).toBe('a')
    // Next call — advance past b (not pending), pick c
    const second = scheduler.selectTenant(['a', 'c'])
    expect(second).toBe('c')
  })

  it('throws when no pending tenants provided', () => {
    const scheduler = new FairScheduler('round-robin', {
      a: { weight: 1 },
    })
    expect(() => scheduler.selectTenant([])).toThrow()
  })
})

// Integration test with PsyQueue
describe('Tenancy Integration', () => {
  it('rate limits tenant enqueue', async () => {
    const q = new PsyQueue()
    q.use(sqlite({ path: ':memory:' }))
    q.use(tenancy({
      tiers: { free: { rateLimit: { max: 2, window: '1m' }, concurrency: 1, weight: 1 } },
      resolveTier: async () => 'free',
      scheduling: 'weighted-fair-queue',
    }))
    q.handle('test', async () => ({}))
    await q.start()

    await q.enqueue('test', {}, { tenantId: 't1' })
    await q.enqueue('test', {}, { tenantId: 't1' })
    await expect(q.enqueue('test', {}, { tenantId: 't1' }))
      .rejects.toThrow('RATE_LIMIT_EXCEEDED')

    await q.stop()
  })

  it('jobs without tenantId are not rate limited', async () => {
    const q = new PsyQueue()
    q.use(sqlite({ path: ':memory:' }))
    q.use(tenancy({
      tiers: { free: { rateLimit: { max: 1, window: '1m' }, concurrency: 1, weight: 1 } },
      resolveTier: async () => 'free',
      scheduling: 'weighted-fair-queue',
    }))
    q.handle('test', async () => ({}))
    await q.start()

    // Should not rate limit jobs without tenantId
    const id1 = await q.enqueue('test', {})
    const id2 = await q.enqueue('test', {})
    const id3 = await q.enqueue('test', {})
    expect(id1).toBeTruthy()
    expect(id2).toBeTruthy()
    expect(id3).toBeTruthy()

    await q.stop()
  })

  it('different tenants are rate limited independently', async () => {
    const q = new PsyQueue()
    q.use(sqlite({ path: ':memory:' }))
    q.use(tenancy({
      tiers: { free: { rateLimit: { max: 1, window: '1m' }, concurrency: 1, weight: 1 } },
      resolveTier: async () => 'free',
      scheduling: 'weighted-fair-queue',
    }))
    q.handle('test', async () => ({}))
    await q.start()

    // t1 hits limit
    await q.enqueue('test', {}, { tenantId: 't1' })
    await expect(q.enqueue('test', {}, { tenantId: 't1' }))
      .rejects.toThrow('RATE_LIMIT_EXCEEDED')

    // t2 should still be allowed (independent counter)
    const id = await q.enqueue('test', {}, { tenantId: 't2' })
    expect(id).toBeTruthy()

    await q.stop()
  })

  it('exposes tenancy API via kernel', async () => {
    const q = new PsyQueue()
    q.use(sqlite({ path: ':memory:' }))
    q.use(tenancy({
      tiers: {
        free: { rateLimit: { max: 5, window: '1m' }, concurrency: 1, weight: 1 },
        premium: { rateLimit: { max: 100, window: '1m' }, concurrency: 5, weight: 5 },
      },
      resolveTier: async () => 'free',
      scheduling: 'weighted-fair-queue',
    }))
    q.handle('test', async () => ({}))
    await q.start()

    const api = q.getExposed('tenancy')
    expect(api).toBeDefined()
    expect(typeof api!['setTier']).toBe('function')
    expect(typeof api!['override']).toBe('function')
    expect(typeof api!['removeOverride']).toBe('function')
    expect(typeof api!['list']).toBe('function')

    // Enqueue so the tenant gets cached
    await q.enqueue('test', {}, { tenantId: 'my-tenant' })
    const list = (api!['list'] as () => Array<{ tenantId: string; tier: string }>)()
    expect(list.some(e => e.tenantId === 'my-tenant')).toBe(true)

    await q.stop()
  })
})
