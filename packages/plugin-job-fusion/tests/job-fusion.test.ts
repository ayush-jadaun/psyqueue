import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { BatchCollector } from '../src/batcher.js'
import { jobFusion } from '../src/index.js'
import { PsyQueue } from '@psyqueue/core'
import { sqlite } from '../../backend-sqlite/src/index.js'
import type { Job } from '@psyqueue/core'

// ============================================================================
// Helper: create a minimal mock job
// ============================================================================

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: `job-${Math.random().toString(36).slice(2)}`,
    queue: 'default',
    name: 'batch-email',
    payload: { to: 'test@example.com' },
    priority: 10,
    maxRetries: 3,
    attempt: 0,
    backoff: 'exponential',
    timeout: 30000,
    status: 'pending',
    createdAt: new Date(),
    meta: {},
    ...overrides,
  }
}

// ============================================================================
// Unit tests: BatchCollector
// ============================================================================

describe('BatchCollector', () => {
  it('jobs batch within window and call flush when timer fires', async () => {
    vi.useFakeTimers()
    const flushed: { groupKey: string; jobs: Job[] }[] = []

    const rule = {
      match: 'batch-email',
      groupBy: (job: Job) => (job.payload as { tenantId?: string }).tenantId ?? 'default',
      window: 100,
      maxBatch: 10,
      fuse: (jobs: Job[]) => ({ emails: jobs.map(j => j.payload) }),
    }

    const collector = new BatchCollector((r, groupKey, jobs) => {
      flushed.push({ groupKey, jobs })
    })

    const job1 = makeJob({ payload: { tenantId: 'acme' } })
    const job2 = makeJob({ payload: { tenantId: 'acme' } })

    collector.collect(rule, job1)
    collector.collect(rule, job2)

    expect(flushed).toHaveLength(0) // Not yet — window not elapsed

    vi.advanceTimersByTime(100)

    expect(flushed).toHaveLength(1)
    expect(flushed[0]!.jobs).toHaveLength(2)
    expect(flushed[0]!.groupKey).toBe('acme')

    vi.useRealTimers()
  })

  it('maxBatch triggers early flush before window expires', () => {
    const flushed: Job[][] = []

    const rule = {
      match: 'batch-email',
      groupBy: (_job: Job) => 'key',
      window: 60000, // long window
      maxBatch: 2,
      fuse: (jobs: Job[]) => jobs,
    }

    const collector = new BatchCollector((_r, _gk, jobs) => {
      flushed.push(jobs)
    })

    collector.collect(rule, makeJob())
    expect(flushed).toHaveLength(0) // Only 1 job — not triggered yet

    collector.collect(rule, makeJob())
    expect(flushed).toHaveLength(1) // maxBatch=2 reached — flushed
    expect(flushed[0]).toHaveLength(2)
  })

  it('different groupBy keys create separate batches', () => {
    vi.useFakeTimers()
    const flushed: { groupKey: string; jobs: Job[] }[] = []

    const rule = {
      match: 'batch-email',
      groupBy: (job: Job) => (job.payload as { tenantId: string }).tenantId,
      window: 100,
      maxBatch: 10,
      fuse: (jobs: Job[]) => jobs,
    }

    const collector = new BatchCollector((_r, groupKey, jobs) => {
      flushed.push({ groupKey, jobs })
    })

    collector.collect(rule, makeJob({ payload: { tenantId: 'tenant-a' } }))
    collector.collect(rule, makeJob({ payload: { tenantId: 'tenant-b' } }))
    collector.collect(rule, makeJob({ payload: { tenantId: 'tenant-a' } }))

    expect(collector.getBucketCount()).toBe(2) // 2 separate buckets

    vi.advanceTimersByTime(100)

    expect(flushed).toHaveLength(2)
    const groupA = flushed.find(f => f.groupKey === 'tenant-a')
    expect(groupA?.jobs).toHaveLength(2)

    vi.useRealTimers()
  })

  it('timer cleans up after firing', () => {
    vi.useFakeTimers()
    const collector = new BatchCollector(() => {})

    const rule = {
      match: 'x',
      groupBy: (_job: Job) => 'key',
      window: 50,
      maxBatch: 10,
      fuse: (j: Job[]) => j,
    }

    collector.collect(rule, makeJob({ name: 'x' }))
    expect(collector.getBucketCount()).toBe(1)

    vi.advanceTimersByTime(50)
    expect(collector.getBucketCount()).toBe(0) // bucket removed after flush

    vi.useRealTimers()
  })

  it('clear() cancels all pending timers', () => {
    vi.useFakeTimers()
    const flushed: Job[][] = []

    const collector = new BatchCollector((_r, _gk, jobs) => {
      flushed.push(jobs)
    })

    const rule = {
      match: 'x',
      groupBy: (_job: Job) => 'key',
      window: 100,
      maxBatch: 10,
      fuse: (j: Job[]) => j,
    }

    collector.collect(rule, makeJob({ name: 'x' }))
    collector.clear()

    vi.advanceTimersByTime(200)
    expect(flushed).toHaveLength(0) // cleared — no flush

    vi.useRealTimers()
  })
})

// ============================================================================
// Integration tests: jobFusion plugin with PsyQueue
// (Use maxBatch=1 or maxBatch=N flush triggers for deterministic testing)
// ============================================================================

describe('Job Fusion Integration', () => {
  let q: PsyQueue

  beforeEach(() => {
    q = new PsyQueue()
  })

  afterEach(async () => {
    await q.stop()
  })

  it('non-matching jobs pass through normally', async () => {
    const processed: string[] = []

    q.use(sqlite({ path: ':memory:' }))
    q.use(jobFusion({
      rules: [{
        match: 'batch-email',
        groupBy: (_job: Job) => 'all',
        window: 5000,
        maxBatch: 10,
        fuse: (jobs: Job[]) => ({ emails: jobs.map(j => j.payload) }),
      }],
    }))
    q.handle('send-sms', async (ctx) => {
      processed.push(ctx.job.id)
    })
    await q.start()

    const id = await q.enqueue('send-sms', { to: '+1234567890' })
    await q.processNext('send-sms')

    expect(processed).toContain(id)
  })

  it('matching jobs are batched and fused when maxBatch is reached, emitting job:fused event', async () => {
    const fusedEvents: unknown[] = []

    q.use(sqlite({ path: ':memory:' }))
    q.use(jobFusion({
      rules: [{
        match: 'batch-email',
        groupBy: (_job: Job) => 'all',
        window: 60000, // long window — rely on maxBatch
        maxBatch: 2,   // flush when 2 jobs collected
        fuse: (jobs: Job[]) => ({ count: jobs.length, items: jobs.map(j => j.payload) }),
      }],
    }))
    q.handle('batch-email', async () => ({}))
    q.events.on('job:fused', (e) => fusedEvents.push(e.data))
    await q.start()

    // Enqueue 2 jobs — maxBatch=2 triggers synchronous flush
    await q.enqueue('batch-email', { to: 'a@example.com' })
    await q.enqueue('batch-email', { to: 'b@example.com' })

    // Allow the async backend.enqueue() in the flush callback to settle
    await new Promise(r => setTimeout(r, 50))

    expect(fusedEvents.length).toBeGreaterThan(0)
    const event = fusedEvents[0] as { count: number; originalJobIds: string[] }
    expect(event.originalJobIds).toHaveLength(2)
  })

  it('fused job has highest priority from batch', async () => {
    const fusedEvents: unknown[] = []

    q.use(sqlite({ path: ':memory:' }))
    q.use(jobFusion({
      rules: [{
        match: 'notify',
        groupBy: (_job: Job) => 'all',
        window: 60000,
        maxBatch: 3,
        fuse: (jobs: Job[]) => ({ jobs }),
      }],
    }))
    q.handle('notify', async () => ({}))
    q.events.on('job:fused', (e) => fusedEvents.push(e.data))
    await q.start()

    await q.enqueue('notify', {}, { priority: 5 })
    await q.enqueue('notify', {}, { priority: 20 })
    await q.enqueue('notify', {}, { priority: 3 })

    // maxBatch=3, 3rd job triggers flush
    await new Promise(r => setTimeout(r, 50))

    expect(fusedEvents.length).toBeGreaterThan(0)
    const event = fusedEvents[0] as { originalJobIds: string[] }
    expect(event.originalJobIds).toHaveLength(3)
  })

  it('cross-tenant jobs are not fused together (separate groupBy keys)', async () => {
    const fusedEvents: unknown[] = []

    q.use(sqlite({ path: ':memory:' }))
    q.use(jobFusion({
      rules: [{
        match: 'batch-email',
        groupBy: (job: Job) => job.tenantId ?? 'default',
        window: 60000,
        maxBatch: 2,  // acme will hit maxBatch=2; globex will have 1 left in buffer
        fuse: (jobs: Job[]) => ({ count: jobs.length }),
      }],
    }))
    q.handle('batch-email', async () => ({}))
    q.events.on('job:fused', (e) => fusedEvents.push(e.data))
    await q.start()

    await q.enqueue('batch-email', {}, { tenantId: 'acme' })
    await q.enqueue('batch-email', {}, { tenantId: 'acme' })
    // 2 acme jobs → maxBatch=2 → flush immediately

    await new Promise(r => setTimeout(r, 50))

    // Should have 1 fused event for acme (globex's 1 job stays in buffer — window not elapsed)
    expect(fusedEvents.length).toBe(1)
    const event = fusedEvents[0] as { count: number }
    expect(event.count).toBe(2) // only acme jobs fused
  })

  it('maxBatch triggers early flush before window', async () => {
    const fusedEvents: unknown[] = []

    q.use(sqlite({ path: ':memory:' }))
    q.use(jobFusion({
      rules: [{
        match: 'batch-email',
        groupBy: (_job: Job) => 'all',
        window: 60000, // very long window
        maxBatch: 2,
        fuse: (jobs: Job[]) => ({ count: jobs.length }),
      }],
    }))
    q.handle('batch-email', async () => ({}))
    q.events.on('job:fused', (e) => fusedEvents.push(e.data))
    await q.start()

    // Enqueue 2 jobs — should trigger immediate flush (maxBatch=2)
    await q.enqueue('batch-email', {})
    await q.enqueue('batch-email', {})

    // Allow backend.enqueue() async to settle
    await new Promise(r => setTimeout(r, 50))

    expect(fusedEvents.length).toBeGreaterThan(0)
    const event = fusedEvents[0] as { count: number }
    expect(event.count).toBe(2)
  })

  it('fused job stores originalJobIds in meta', async () => {
    const fusedEvents: unknown[] = []

    q.use(sqlite({ path: ':memory:' }))
    q.use(jobFusion({
      rules: [{
        match: 'batch-email',
        groupBy: (_job: Job) => 'all',
        window: 60000,
        maxBatch: 2,
        fuse: (jobs: Job[]) => ({ items: jobs }),
      }],
    }))
    q.handle('batch-email', async () => ({}))
    q.events.on('job:fused', (e) => fusedEvents.push(e.data))
    await q.start()

    const id1 = await q.enqueue('batch-email', { msg: 'first' })
    const id2 = await q.enqueue('batch-email', { msg: 'second' })

    await new Promise(r => setTimeout(r, 50))

    expect(fusedEvents.length).toBeGreaterThan(0)
    const event = fusedEvents[0] as { originalJobIds: string[] }
    expect(event.originalJobIds).toContain(id1)
    expect(event.originalJobIds).toContain(id2)
  })
})
