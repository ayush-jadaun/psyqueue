import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { PsyQueue } from '../src/kernel.js'
import { sqlite } from '../../backend-sqlite/src/index.js'
import type { BackendAdapter, JobContext, PsyEvent } from '../src/types.js'

/**
 * End-to-end integration tests: PsyQueue kernel + real SQLite backend (in-memory).
 * No mocks — every test exercises the full enqueue → dequeue → process pipeline.
 */

describe('Integration: PsyQueue + SQLite backend', () => {
  let q: PsyQueue

  beforeEach(async () => {
    q = new PsyQueue()
    q.use(sqlite({ path: ':memory:' }))
    await q.start()
  })

  afterEach(async () => {
    await q.stop()
  })

  // ─── 1. Basic flow ──────────────────────────────────────────────────
  it('enqueue → processNext → handler receives correct payload and returns result', async () => {
    let received: unknown = null
    q.handle('greet', async (ctx) => {
      received = ctx.job.payload
      return 'hello'
    })

    const jobId = await q.enqueue('greet', { name: 'Alice' })
    expect(typeof jobId).toBe('string')

    const processed = await q.processNext('greet')
    expect(processed).toBe(true)
    expect(received).toEqual({ name: 'Alice' })
  })

  // ─── 2. Multiple jobs processed in priority order ───────────────────
  it('multiple jobs are dequeued in priority order (highest first)', async () => {
    const order: number[] = []
    q.handle('task', async (ctx) => {
      order.push(ctx.job.priority)
    })

    await q.enqueue('task', { n: 1 }, { priority: 1 })
    await q.enqueue('task', { n: 2 }, { priority: 10 })
    await q.enqueue('task', { n: 3 }, { priority: 5 })

    await q.processNext('task')
    await q.processNext('task')
    await q.processNext('task')

    expect(order).toEqual([10, 5, 1])
  })

  // ─── 3. Retry on failure ────────────────────────────────────────────
  it('retries a job that fails transiently and eventually succeeds', async () => {
    let attempts = 0
    q.handle('flaky', async () => {
      attempts++
      if (attempts < 3) throw new Error('timeout — transient')
      return 'ok'
    })

    await q.enqueue('flaky', {}, { maxRetries: 5, backoff: 'fixed', backoffBase: 0, backoffJitter: false })

    // First attempt — fails, gets requeued
    await q.processNext('flaky')
    expect(attempts).toBe(1)

    // Second attempt — fails again, gets requeued
    await q.processNext('flaky')
    expect(attempts).toBe(2)

    // Third attempt — succeeds
    await q.processNext('flaky')
    expect(attempts).toBe(3)
  })

  // ─── 4. Dead letter after exhausted retries ─────────────────────────
  it('moves job to dead letter after retries are exhausted', async () => {
    q.handle('doomed', async () => {
      throw new Error('timeout — always fails')
    })

    // maxRetries=1 means: attempt 1 fails → attempt(1) >= maxRetries(1) → dead
    await q.enqueue('doomed', { reason: 'test' }, { maxRetries: 1 })
    await q.processNext('doomed')

    const dead = await q.deadLetter.list()
    expect(dead.data).toHaveLength(1)
    expect(dead.data[0]!.name).toBe('doomed')
    expect(dead.data[0]!.status).toBe('dead')
  })

  // ─── 5. Dead letter list returns error info ─────────────────────────
  it('dead-lettered jobs carry error information', async () => {
    q.handle('err-info', async () => {
      throw new Error('something broke badly')
    })

    await q.enqueue('err-info', {}, { maxRetries: 1 })
    await q.processNext('err-info')

    const dead = await q.deadLetter.list()
    expect(dead.data).toHaveLength(1)
    const job = dead.data[0]!
    expect(job.error).toBeDefined()
    expect(job.error!.message).toContain('something broke badly')
  })

  // ─── 6. Dead letter replay ──────────────────────────────────────────
  it('replaying a dead-lettered job makes it pending again', async () => {
    q.handle('replay-me', async () => {
      throw new Error('timeout — fail for now')
    })

    await q.enqueue('replay-me', {}, { maxRetries: 1 })
    await q.processNext('replay-me')

    const dead = await q.deadLetter.list()
    expect(dead.data).toHaveLength(1)
    const deadJobId = dead.data[0]!.id

    await q.deadLetter.replay(deadJobId)

    // The job should be available again (status=pending)
    const backend = q.getExposed('backend') as unknown as BackendAdapter
    const replayedJob = await backend.getJob(deadJobId)
    expect(replayedJob).not.toBeNull()
    expect(replayedJob!.status).toBe('pending')
  })

  // ─── 7. Lifecycle events in order ───────────────────────────────────
  it('emits job:enqueued, job:started, job:completed in order', async () => {
    const events: string[] = []
    q.events.on('job:enqueued', () => events.push('enqueued'))
    q.events.on('job:started', () => events.push('started'))
    q.events.on('job:completed', () => events.push('completed'))

    q.handle('lc', async () => 'done')
    await q.enqueue('lc', {})
    await q.processNext('lc')

    expect(events).toEqual(['enqueued', 'started', 'completed'])
  })

  // ─── 8. Failed event ───────────────────────────────────────────────
  it('emits job:failed when the handler throws', async () => {
    const failEvents: PsyEvent[] = []
    q.events.on('job:failed', (e) => failEvents.push(e))

    q.handle('fail-job', async () => {
      throw new Error('handler blew up')
    })
    await q.enqueue('fail-job', {}, { maxRetries: 1 })
    await q.processNext('fail-job')

    expect(failEvents).toHaveLength(1)
    expect((failEvents[0]!.data as Record<string, unknown>).error).toContain('handler blew up')
  })

  // ─── 9. User middleware on enqueue and process ──────────────────────
  it('user middleware runs on both enqueue and process phases', async () => {
    const phases: string[] = []

    q.pipeline('enqueue', async (_ctx, next) => {
      phases.push('enqueue-mw')
      await next()
    })
    q.pipeline('process', async (_ctx, next) => {
      phases.push('process-mw')
      await next()
    })
    q.handle('mw-job', async () => 'ok')

    await q.enqueue('mw-job', {})
    await q.processNext('mw-job')

    expect(phases).toContain('enqueue-mw')
    expect(phases).toContain('process-mw')
  })

  // ─── 10. User middleware can modify context ─────────────────────────
  it('middleware can inject state that the handler sees', async () => {
    let handlerSawTag = false

    q.pipeline('process', async (ctx, next) => {
      ctx.state['tag'] = 'injected-by-middleware'
      await next()
    }, { phase: 'guard' })

    q.handle('ctx-job', async (ctx) => {
      handlerSawTag = ctx.state['tag'] === 'injected-by-middleware'
      return 'ok'
    })

    await q.enqueue('ctx-job', {})
    await q.processNext('ctx-job')

    expect(handlerSawTag).toBe(true)
  })

  // ─── 11. Handler not found ─────────────────────────────────────────
  it('dead-letters (or fails) a job when no handler is registered', async () => {
    const failEvents: PsyEvent[] = []
    q.events.on('job:failed', (e) => failEvents.push(e))

    await q.enqueue('orphan', { data: 1 })
    const processed = await q.processNext('orphan')

    expect(processed).toBe(true) // still returns true — the job was dequeued
    expect(failEvents).toHaveLength(1)
    expect((failEvents[0]!.data as Record<string, unknown>).error).toContain('No handler')
  })

  // ─── 12. Empty queue ───────────────────────────────────────────────
  it('processNext returns false when the queue is empty', async () => {
    q.handle('nothing', async () => 'nope')
    const result = await q.processNext('nothing')
    expect(result).toBe(false)
  })

  // ─── 13. Exponential backoff delay ──────────────────────────────────
  it('retried jobs are requeued with an exponential backoff delay', async () => {
    // Spy on the backend's nack to inspect the delay argument
    const backend = q.getExposed('backend') as unknown as BackendAdapter
    const nackSpy = vi.spyOn(backend, 'nack')

    q.handle('backoff-job', async () => {
      throw new Error('timeout — transient')
    })

    // backoffBase=1000, exponential, no jitter for deterministic check
    await q.enqueue('backoff-job', {}, {
      maxRetries: 5,
      backoff: 'exponential',
      backoffBase: 1000,
      backoffJitter: false,
    })

    await q.processNext('backoff-job')

    // First failure: attempt=1, delay = 1000 * 2^(1-1) = 1000
    expect(nackSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ requeue: true, delay: 1000 })
    )

    nackSpy.mockRestore()
  })

  // ─── 14. Job with metadata ─────────────────────────────────────────
  it('handler receives the metadata passed at enqueue time', async () => {
    let capturedMeta: Record<string, unknown> = {}

    q.handle('meta-job', async (ctx) => {
      capturedMeta = ctx.job.meta
      return 'ok'
    })

    await q.enqueue('meta-job', { x: 1 }, { meta: { source: 'test', priority: 'high' } })
    await q.processNext('meta-job')

    expect(capturedMeta).toEqual({ source: 'test', priority: 'high' })
  })

  // ─── 15. Concurrent processNext (no double-processing) ─────────────
  it('concurrent processNext calls each get a different job', async () => {
    const seen: string[] = []

    q.handle('conc', async (ctx) => {
      seen.push(ctx.job.id)
      return 'done'
    })

    await q.enqueue('conc', { n: 1 })
    await q.enqueue('conc', { n: 2 })

    // Fire both in parallel
    const [r1, r2] = await Promise.all([
      q.processNext('conc'),
      q.processNext('conc'),
    ])

    expect(r1).toBe(true)
    expect(r2).toBe(true)
    expect(seen).toHaveLength(2)
    expect(new Set(seen).size).toBe(2) // two distinct job IDs
  })

  // ─── 16. Plugin lifecycle: connect / disconnect ─────────────────────
  it('sqlite plugin connects on start and disconnects on stop', async () => {
    const fresh = new PsyQueue()
    fresh.use(sqlite({ path: ':memory:' }))
    const backend = fresh.getExposed('backend') as unknown as BackendAdapter

    // Before start, healthCheck should fail (not connected)
    const beforeHealth = await backend.healthCheck()
    expect(beforeHealth).toBe(false)

    await fresh.start()
    const afterHealth = await backend.healthCheck()
    expect(afterHealth).toBe(true)

    await fresh.stop()
    const stoppedHealth = await backend.healthCheck()
    expect(stoppedHealth).toBe(false)
  })

  // ─── 17. Backend health check ──────────────────────────────────────
  it('backend healthCheck returns true after start', async () => {
    const backend = q.getExposed('backend') as unknown as BackendAdapter
    const healthy = await backend.healthCheck()
    expect(healthy).toBe(true)
  })
})
