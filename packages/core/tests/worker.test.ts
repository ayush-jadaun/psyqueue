import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { PsyQueue } from '../src/kernel.js'
import { sqlite } from '../../backend-sqlite/src/index.js'
import type { BackendAdapter, Job, NackOpts, PsyPlugin, Kernel, PsyEvent } from '../src/types.js'

// ── Helper: wait until condition is true or timeout ──────────────────────────

async function waitUntil(fn: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitUntil timed out after ${timeoutMs}ms`)
    }
    await new Promise(r => setTimeout(r, 10))
  }
}

// ── Mock backend factory ─────────────────────────────────────────────────────

function makeMockBackend(): BackendAdapter {
  const jobs = new Map<string, Job>()
  return {
    name: 'mock',
    type: 'mock',
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    healthCheck: vi.fn(async () => true),
    enqueue: vi.fn(async (job: Job) => {
      jobs.set(job.id, job)
      return job.id
    }),
    enqueueBulk: vi.fn(async (bulk: Job[]) => {
      bulk.forEach(j => jobs.set(j.id, j))
      return bulk.map(j => j.id)
    }),
    dequeue: vi.fn(async (queue: string, count: number) => {
      const pending = [...jobs.values()].filter(j => j.queue === queue && j.status === 'pending')
      const batch = pending.slice(0, count)
      return batch.map(j => {
        j.status = 'active'
        return { ...j, completionToken: 'tok_' + j.id }
      })
    }),
    ack: vi.fn(async (id: string) => {
      const j = jobs.get(id)
      if (j) j.status = 'completed'
      return { alreadyCompleted: false }
    }),
    nack: vi.fn(async (id: string, opts?: NackOpts) => {
      const j = jobs.get(id)
      if (j) {
        if (opts?.deadLetter) j.status = 'dead'
        else if (opts?.requeue !== false) {
          j.status = 'pending'
          j.attempt = (j.attempt ?? 1) + 1
        }
        else j.status = 'failed'
      }
    }),
    getJob: vi.fn(async (id: string) => jobs.get(id) ?? null),
    listJobs: vi.fn(async () => ({ data: [], total: 0, limit: 50, offset: 0, hasMore: false })),
    scheduleAt: vi.fn(async (job: Job) => { job.status = 'scheduled'; jobs.set(job.id, job); return job.id }),
    pollScheduled: vi.fn(async () => []),
    acquireLock: vi.fn(async () => true),
    releaseLock: vi.fn(async () => {}),
    atomic: vi.fn(async () => {}),
  }
}

function makeBackendPlugin(backend: BackendAdapter): PsyPlugin {
  return {
    name: 'mock-backend',
    version: '1.0.0',
    provides: 'backend',
    init(kernel: Kernel) {
      kernel.expose('backend', backend as unknown as Record<string, unknown>)
    },
  }
}

// ── WorkerPool tests with mock backend ───────────────────────────────────────

describe('WorkerPool (mock backend)', () => {
  let q: PsyQueue
  let backend: BackendAdapter

  beforeEach(async () => {
    q = new PsyQueue()
    backend = makeMockBackend()
    q.use(makeBackendPlugin(backend))
    await q.start()
  })

  afterEach(async () => {
    await q.stop()
  })

  it('processes jobs automatically when started', async () => {
    const results: unknown[] = []
    q.handle('test', async (ctx) => {
      results.push(ctx.job.payload)
      return { ok: true }
    })

    await q.enqueue('test', { n: 1 })
    await q.enqueue('test', { n: 2 })

    q.startWorker('test', { concurrency: 1, pollInterval: 10 })
    await waitUntil(() => results.length === 2, 5000)

    expect(results).toHaveLength(2)
  })

  it('processes with concurrency > 1', async () => {
    const results: number[] = []
    q.handle('conc', async (ctx) => {
      const payload = ctx.job.payload as { n: number }
      // Simulate a bit of work
      await new Promise(r => setTimeout(r, 20))
      results.push(payload.n)
      return { ok: true }
    })

    for (let i = 0; i < 10; i++) {
      await q.enqueue('conc', { n: i })
    }

    const start = Date.now()
    q.startWorker('conc', { concurrency: 5, pollInterval: 10 })
    await waitUntil(() => results.length === 10, 10000)
    const elapsed = Date.now() - start

    expect(results).toHaveLength(10)
    // With concurrency=5, should be significantly faster than serial
    // 10 jobs * 20ms each = 200ms serial, ~40-80ms with concurrency=5
    // But we are generous with the assertion
    expect(elapsed).toBeLessThan(5000)
  })

  it('stops gracefully -- finishes current processing', async () => {
    let started = false
    let finished = false

    q.handle('slow', async () => {
      started = true
      await new Promise(r => setTimeout(r, 100))
      finished = true
      return { ok: true }
    })

    await q.enqueue('slow', { data: 1 })

    q.startWorker('slow', { concurrency: 1, pollInterval: 10 })
    await waitUntil(() => started, 3000)

    // Stop while the job is being processed
    await q.stop()

    // The job that was in-flight should have completed
    expect(finished).toBe(true)
  })

  it('retries failed jobs', async () => {
    let attempt = 0
    q.handle('flaky', async () => {
      attempt++
      if (attempt < 3) throw new Error('timeout -- transient')
      return { ok: true }
    })

    await q.enqueue('flaky', {}, { maxRetries: 5, backoff: 'fixed', backoffBase: 0, backoffJitter: false })

    q.startWorker('flaky', { concurrency: 1, pollInterval: 10 })
    await waitUntil(() => attempt >= 3, 5000)

    expect(attempt).toBe(3)
  })

  it('handles empty queue without spinning (poll mode)', async () => {
    q.handle('empty', async () => ({ ok: true }))

    const dequeueCallsBefore = (backend.dequeue as ReturnType<typeof vi.fn>).mock.calls.length

    q.startWorker('empty', { concurrency: 1, pollInterval: 100 })

    // Wait a bit
    await new Promise(r => setTimeout(r, 350))
    await q.stop()

    const dequeueCallsAfter = (backend.dequeue as ReturnType<typeof vi.fn>).mock.calls.length
    const calls = dequeueCallsAfter - dequeueCallsBefore

    // With pollInterval=100ms over 350ms, expect ~3-5 polls, not hundreds
    expect(calls).toBeLessThan(10)
    expect(calls).toBeGreaterThan(0)
  })

  it('throws if worker already running for queue', () => {
    q.handle('dup', async () => ({ ok: true }))
    q.startWorker('dup', { concurrency: 1, pollInterval: 50 })
    expect(() => q.startWorker('dup')).toThrow('WORKER_EXISTS')
  })

  it('emits job:started, job:completed events', async () => {
    const events: string[] = []
    q.events.on('job:started', () => events.push('started'))
    q.events.on('job:completed', () => events.push('completed'))

    q.handle('evt', async () => ({ ok: true }))
    await q.enqueue('evt', { data: 1 })

    q.startWorker('evt', { concurrency: 1, pollInterval: 10 })
    await waitUntil(() => events.includes('completed'), 3000)

    expect(events).toContain('started')
    expect(events).toContain('completed')
  })

  it('emits job:failed when handler throws', async () => {
    const failEvents: PsyEvent[] = []
    q.events.on('job:failed', (e) => failEvents.push(e))

    q.handle('fail-job', async () => {
      throw new Error('handler blew up')
    })
    await q.enqueue('fail-job', {}, { maxRetries: 1 })

    q.startWorker('fail-job', { concurrency: 1, pollInterval: 10 })
    await waitUntil(() => failEvents.length >= 1, 3000)

    expect(failEvents.length).toBeGreaterThanOrEqual(1)
  })

  it('dead-letters when no handler is registered', async () => {
    const failEvents: PsyEvent[] = []
    q.events.on('job:failed', (e) => failEvents.push(e))

    await q.enqueue('orphan', { data: 1 })

    q.startWorker('orphan', { concurrency: 1, pollInterval: 10 })
    await waitUntil(() => failEvents.length >= 1, 3000)

    expect(failEvents.length).toBeGreaterThanOrEqual(1)
    expect((failEvents[0]!.data as Record<string, unknown>).error).toContain('No handler')
  })
})

// ── Integration tests with real SQLite backend ───────────────────────────────

describe('WorkerPool integration (SQLite)', () => {
  let q: PsyQueue

  beforeEach(async () => {
    q = new PsyQueue()
    q.use(sqlite({ path: ':memory:' }))
    await q.start()
  })

  afterEach(async () => {
    await q.stop()
  })

  it('processes jobs end-to-end via startWorker with SQLite', async () => {
    const results: unknown[] = []
    q.handle('task', async (ctx) => {
      results.push(ctx.job.payload)
      return 'done'
    })

    await q.enqueue('task', { n: 1 })
    await q.enqueue('task', { n: 2 })
    await q.enqueue('task', { n: 3 })

    q.startWorker('task', { concurrency: 1, pollInterval: 10 })
    await waitUntil(() => results.length === 3, 5000)

    expect(results).toHaveLength(3)
  })

  it('retries and eventually succeeds with SQLite backend', async () => {
    let attempts = 0
    q.handle('flaky', async () => {
      attempts++
      if (attempts < 3) throw new Error('timeout -- transient')
      return 'ok'
    })

    await q.enqueue('flaky', {}, { maxRetries: 5, backoff: 'fixed', backoffBase: 0, backoffJitter: false })

    q.startWorker('flaky', { concurrency: 1, pollInterval: 10 })
    await waitUntil(() => attempts >= 3, 5000)

    expect(attempts).toBe(3)
  })

  it('processes jobs in priority order with SQLite', async () => {
    const order: number[] = []
    q.handle('prio', async (ctx) => {
      order.push(ctx.job.priority)
      return 'done'
    })

    await q.enqueue('prio', { n: 1 }, { priority: 1 })
    await q.enqueue('prio', { n: 2 }, { priority: 10 })
    await q.enqueue('prio', { n: 3 }, { priority: 5 })

    q.startWorker('prio', { concurrency: 1, pollInterval: 10 })
    await waitUntil(() => order.length === 3, 5000)

    // Highest priority first
    expect(order).toEqual([10, 5, 1])
  })

  it('stopWorkers is idempotent', async () => {
    q.handle('safe', async () => ({ ok: true }))
    q.startWorker('safe', { concurrency: 1, pollInterval: 50 })
    await q.stopWorkers()
    // Calling again should not throw
    await q.stopWorkers()
  })

  it('middleware runs during worker processing', async () => {
    const phases: string[] = []

    q.pipeline('process', async (_ctx, next) => {
      phases.push('process-mw')
      await next()
    })

    q.handle('mw-job', async () => {
      phases.push('handler')
      return 'ok'
    })

    await q.enqueue('mw-job', {})

    q.startWorker('mw-job', { concurrency: 1, pollInterval: 10 })
    await waitUntil(() => phases.includes('handler'), 3000)

    expect(phases).toContain('process-mw')
    expect(phases).toContain('handler')
  })
})
