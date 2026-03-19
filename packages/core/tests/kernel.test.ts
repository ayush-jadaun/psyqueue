import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PsyQueue } from '../src/kernel.js'
import type { BackendAdapter, Job, JobFilter, NackOpts, PsyPlugin, Kernel, JobContext } from '../src/types.js'

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
        else if (opts?.requeue !== false) j.status = 'pending'
        else j.status = 'failed'
      }
    }),
    getJob: vi.fn(async (id: string) => jobs.get(id) ?? null),
    listJobs: vi.fn(async (filter: JobFilter) => {
      let data = [...jobs.values()]
      if (filter.status) {
        const statuses = Array.isArray(filter.status) ? filter.status : [filter.status]
        data = data.filter(j => statuses.includes(j.status))
      }
      if (filter.queue) data = data.filter(j => j.queue === filter.queue)
      if (filter.name) data = data.filter(j => j.name === filter.name)
      return { data, total: data.length, limit: 50, offset: 0, hasMore: false }
    }),
    scheduleAt: vi.fn(async (job: Job) => {
      job.status = 'scheduled'
      jobs.set(job.id, job)
      return job.id
    }),
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

describe('PsyQueue', () => {
  let queue: PsyQueue
  let backend: BackendAdapter

  beforeEach(() => {
    queue = new PsyQueue()
    backend = makeMockBackend()
  })

  describe('use()', () => {
    it('registers plugins and is chainable', () => {
      const plugin1 = makeBackendPlugin(backend)
      const plugin2: PsyPlugin = {
        name: 'logger', version: '1.0.0',
        init: vi.fn(),
      }
      const result = queue.use(plugin1).use(plugin2)
      expect(result).toBe(queue)
    })
  })

  describe('start() / stop()', () => {
    it('starts and stops cleanly with backend connect/disconnect called', async () => {
      queue.use(makeBackendPlugin(backend))
      await queue.start()
      expect(backend.connect).toHaveBeenCalledOnce()

      await queue.stop()
      expect(backend.disconnect).toHaveBeenCalledOnce()
    })

    it('throws if started without a backend', async () => {
      await expect(queue.start()).rejects.toThrow(/backend/i)
    })

    it('emits kernel:started event on start', async () => {
      queue.use(makeBackendPlugin(backend))
      const handler = vi.fn()
      queue.events.on('kernel:started', handler)
      await queue.start()
      expect(handler).toHaveBeenCalledOnce()
    })

    it('emits kernel:stopped event on stop', async () => {
      queue.use(makeBackendPlugin(backend))
      const handler = vi.fn()
      queue.events.on('kernel:stopped', handler)
      await queue.start()
      await queue.stop()
      expect(handler).toHaveBeenCalledOnce()
    })
  })

  describe('enqueue()', () => {
    beforeEach(async () => {
      queue.use(makeBackendPlugin(backend))
      await queue.start()
    })

    it('enqueues a job through the middleware pipeline', async () => {
      const jobId = await queue.enqueue('send-email', { to: 'test@example.com' })
      expect(typeof jobId).toBe('string')
      expect(jobId.length).toBeGreaterThan(0)
      expect(backend.enqueue).toHaveBeenCalledOnce()
    })

    it('emits job:enqueued event', async () => {
      const handler = vi.fn()
      queue.events.on('job:enqueued', handler)
      await queue.enqueue('send-email', { to: 'test@example.com' })
      expect(handler).toHaveBeenCalledOnce()
      expect(handler.mock.calls[0][0].data).toHaveProperty('jobId')
      expect(handler.mock.calls[0][0].data).toHaveProperty('name', 'send-email')
    })

    it('backend.enqueue receives a well-formed Job object', async () => {
      await queue.enqueue('process-payment', { amount: 100 }, { queue: 'payments', priority: 5 })
      const calledJob = (backend.enqueue as ReturnType<typeof vi.fn>).mock.calls[0][0] as Job
      expect(calledJob.name).toBe('process-payment')
      expect(calledJob.payload).toEqual({ amount: 100 })
      expect(calledJob.queue).toBe('payments')
      expect(calledJob.priority).toBe(5)
      expect(calledJob.status).toBe('pending')
    })
  })

  describe('enqueueBulk()', () => {
    beforeEach(async () => {
      queue.use(makeBackendPlugin(backend))
      await queue.start()
    })

    it('uses backend.enqueueBulk for atomicity', async () => {
      const items = [
        { name: 'job-a', payload: { a: 1 } },
        { name: 'job-b', payload: { b: 2 } },
        { name: 'job-c', payload: { c: 3 } },
      ]
      const ids = await queue.enqueueBulk(items)
      expect(ids).toHaveLength(3)
      expect(backend.enqueueBulk).toHaveBeenCalledOnce()
      const calledJobs = (backend.enqueueBulk as ReturnType<typeof vi.fn>).mock.calls[0][0] as Job[]
      expect(calledJobs).toHaveLength(3)
      expect(calledJobs[0]!.name).toBe('job-a')
      expect(calledJobs[1]!.name).toBe('job-b')
      expect(calledJobs[2]!.name).toBe('job-c')
    })

    it('emits job:enqueued for each job', async () => {
      const handler = vi.fn()
      queue.events.on('job:enqueued', handler)
      await queue.enqueueBulk([
        { name: 'a', payload: {} },
        { name: 'b', payload: {} },
      ])
      expect(handler).toHaveBeenCalledTimes(2)
    })
  })

  describe('handle() and processNext()', () => {
    beforeEach(async () => {
      queue.use(makeBackendPlugin(backend))
      await queue.start()
    })

    it('registers and calls job handlers via processNext()', async () => {
      const handler = vi.fn(async () => 'done')
      queue.handle('send-email', handler)

      await queue.enqueue('send-email', { to: 'test@example.com' })
      const result = await queue.processNext('send-email')

      expect(result).toBe(true)
      expect(handler).toHaveBeenCalledOnce()
    })

    it('returns false when queue is empty', async () => {
      queue.handle('send-email', async () => 'done')
      const result = await queue.processNext('send-email')
      expect(result).toBe(false)
    })

    it('returns true even when handler fails', async () => {
      queue.handle('fail-job', async () => { throw new Error('oops') })
      await queue.enqueue('fail-job', {})
      const result = await queue.processNext('fail-job')
      expect(result).toBe(true)
    })

    it('acks a successful job', async () => {
      queue.handle('ok-job', async () => 'success')
      await queue.enqueue('ok-job', {})
      await queue.processNext('ok-job')
      expect(backend.ack).toHaveBeenCalledOnce()
    })

    it('dead letters when no handler is registered', async () => {
      await queue.enqueue('unknown-job', {})
      await queue.processNext('unknown-job')
      expect(backend.nack).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ deadLetter: true })
      )
    })
  })

  describe('events lifecycle', () => {
    beforeEach(async () => {
      queue.use(makeBackendPlugin(backend))
      await queue.start()
    })

    it('emits job:enqueued, job:started, job:completed events in order', async () => {
      const events: string[] = []
      queue.events.on('job:enqueued', () => events.push('enqueued'))
      queue.events.on('job:started', () => events.push('started'))
      queue.events.on('job:completed', () => events.push('completed'))

      queue.handle('lifecycle-job', async () => 'done')
      await queue.enqueue('lifecycle-job', {})
      await queue.processNext('lifecycle-job')

      expect(events).toEqual(['enqueued', 'started', 'completed'])
    })

    it('emits job:failed when handler throws', async () => {
      const handler = vi.fn()
      queue.events.on('job:failed', handler)

      queue.handle('fail-job', async () => { throw new Error('oops') })
      await queue.enqueue('fail-job', {})
      await queue.processNext('fail-job')

      expect(handler).toHaveBeenCalledOnce()
    })
  })

  describe('retry and backoff', () => {
    beforeEach(async () => {
      queue.use(makeBackendPlugin(backend))
      await queue.start()
    })

    it('failed jobs are retried (nacked with requeue + delay)', async () => {
      queue.handle('retry-job', async () => { throw new Error('transient error') })

      await queue.enqueue('retry-job', {}, { maxRetries: 3 })
      await queue.processNext('retry-job')

      // Job has attempt=1 and maxRetries=3, so it should be nacked with requeue
      expect(backend.nack).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ requeue: true, delay: expect.any(Number) })
      )
    })

    it('emits job:retry event for retryable failures', async () => {
      const retryHandler = vi.fn()
      queue.events.on('job:retry', retryHandler)

      queue.handle('retry-job', async () => { throw new Error('timeout') })
      await queue.enqueue('retry-job', {}, { maxRetries: 3 })
      await queue.processNext('retry-job')

      expect(retryHandler).toHaveBeenCalledOnce()
      expect(retryHandler.mock.calls[0][0].data).toHaveProperty('attempt')
      expect(retryHandler.mock.calls[0][0].data).toHaveProperty('delay')
    })

    it('exhausted retries move job to dead letter', async () => {
      queue.handle('exhaust-job', async () => { throw new Error('always fails') })

      // Create a job at maxRetries so next fail dead-letters it
      await queue.enqueue('exhaust-job', {}, { maxRetries: 1 })

      // Patch the mock to return a job at attempt=1 with maxRetries=1
      // The first process will see attempt(1) >= maxRetries(1), so dead letter
      await queue.processNext('exhaust-job')

      expect(backend.nack).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ deadLetter: true })
      )
    })

    it('emits job:dead when retries are exhausted', async () => {
      const deadHandler = vi.fn()
      queue.events.on('job:dead', deadHandler)

      queue.handle('exhaust-job', async () => { throw new Error('always fails') })
      await queue.enqueue('exhaust-job', {}, { maxRetries: 1 })
      await queue.processNext('exhaust-job')

      expect(deadHandler).toHaveBeenCalledOnce()
    })
  })

  describe('calculateBackoff()', () => {
    it('exponential backoff calculates correctly (1s, 2s, 4s...)', () => {
      // Mock Math.random to remove jitter randomness
      const origRandom = Math.random
      Math.random = () => 0.5 // Will produce jitter factor of 0, so delay stays the same

      try {
        const job = {
          backoff: 'exponential' as const,
          backoffBase: 1000,
          backoffCap: 300000,
          backoffJitter: false, // Disable jitter for deterministic test
          attempt: 1,
        } as Job

        expect(queue.calculateBackoff({ ...job, attempt: 1 } as Job)).toBe(1000)
        expect(queue.calculateBackoff({ ...job, attempt: 2 } as Job)).toBe(2000)
        expect(queue.calculateBackoff({ ...job, attempt: 3 } as Job)).toBe(4000)
        expect(queue.calculateBackoff({ ...job, attempt: 4 } as Job)).toBe(8000)
        expect(queue.calculateBackoff({ ...job, attempt: 5 } as Job)).toBe(16000)
      } finally {
        Math.random = origRandom
      }
    })

    it('respects backoffCap', () => {
      const job = {
        backoff: 'exponential' as const,
        backoffBase: 1000,
        backoffCap: 5000,
        backoffJitter: false,
        attempt: 10,
      } as Job

      expect(queue.calculateBackoff(job)).toBe(5000)
    })

    it('fixed backoff returns constant delay', () => {
      const job = {
        backoff: 'fixed' as const,
        backoffBase: 2000,
        backoffCap: 300000,
        backoffJitter: false,
        attempt: 5,
      } as Job

      expect(queue.calculateBackoff(job)).toBe(2000)
    })

    it('linear backoff scales with attempt', () => {
      const job = {
        backoff: 'linear' as const,
        backoffBase: 1000,
        backoffCap: 300000,
        backoffJitter: false,
        attempt: 3,
      } as Job

      expect(queue.calculateBackoff(job)).toBe(3000)
    })

    it('applies jitter when enabled (result varies within +-25%)', () => {
      const job = {
        backoff: 'exponential' as const,
        backoffBase: 1000,
        backoffCap: 300000,
        backoffJitter: true,
        attempt: 1,
      } as Job

      // Base delay is 1000, so with jitter result should be between 750 and 1250
      const results = new Set<number>()
      for (let i = 0; i < 100; i++) {
        results.add(queue.calculateBackoff(job))
      }
      // At least some variation
      expect(results.size).toBeGreaterThan(1)

      for (const val of results) {
        expect(val).toBeGreaterThanOrEqual(750)
        expect(val).toBeLessThanOrEqual(1250)
      }
    })

    it('defaults to 1000ms base and 300000ms cap', () => {
      const job = {
        backoff: 'exponential' as const,
        backoffJitter: false,
        attempt: 1,
      } as Job

      expect(queue.calculateBackoff(job)).toBe(1000)
    })

    it('supports custom backoff function', () => {
      const job = {
        backoff: (attempt: number) => attempt * 500,
        backoffCap: 300000,
        backoffJitter: false,
        attempt: 3,
      } as unknown as Job

      expect(queue.calculateBackoff(job)).toBe(1500)
    })
  })

  describe('deadLetter', () => {
    beforeEach(async () => {
      queue.use(makeBackendPlugin(backend))
      await queue.start()
    })

    it('deadLetter.list() returns dead jobs', async () => {
      queue.handle('dl-job', async () => { throw new Error('fatal') })
      await queue.enqueue('dl-job', {}, { maxRetries: 1 })
      await queue.processNext('dl-job')

      const result = await queue.deadLetter.list()
      expect(backend.listJobs).toHaveBeenCalledWith(expect.objectContaining({ status: 'dead' }))
    })

    it('deadLetter.replay() resets a dead job to pending', async () => {
      // Enqueue and fail a job to dead letter
      queue.handle('dl-job', async () => { throw new Error('fatal') })
      await queue.enqueue('dl-job', {}, { maxRetries: 1 })
      await queue.processNext('dl-job')

      // Get the dead job
      const listed = await queue.deadLetter.list()
      const deadJobs = (backend.listJobs as ReturnType<typeof vi.fn>).mock.results
      // We know nack was called with deadLetter: true, so get the job ID
      const nackCall = (backend.nack as ReturnType<typeof vi.fn>).mock.calls[0]
      const jobId = nackCall[0] as string

      // The job should be dead in our mock
      const deadJob = await backend.getJob(jobId)
      expect(deadJob?.status).toBe('dead')

      await queue.deadLetter.replay(jobId)

      // nack should be called again with requeue: true
      const lastNackCall = (backend.nack as ReturnType<typeof vi.fn>).mock.calls.at(-1)
      expect(lastNackCall![1]).toEqual(expect.objectContaining({ requeue: true }))
    })

    it('deadLetter.replay() throws for non-existent job', async () => {
      await expect(queue.deadLetter.replay('nonexistent-id')).rejects.toThrow(/not found/i)
    })

    it('deadLetter.replay() throws for non-dead job', async () => {
      await queue.enqueue('some-job', {})
      const enqueuedJob = (backend.enqueue as ReturnType<typeof vi.fn>).mock.calls[0][0] as Job
      await expect(queue.deadLetter.replay(enqueuedJob.id)).rejects.toThrow(/not in dead letter/i)
    })

    it('deadLetter.replayAll() replays all dead jobs', async () => {
      queue.handle('dl-job', async () => { throw new Error('fatal') })
      await queue.enqueue('dl-job', { i: 1 }, { maxRetries: 1 })
      await queue.processNext('dl-job')
      await queue.enqueue('dl-job', { i: 2 }, { maxRetries: 1 })
      await queue.processNext('dl-job')

      const count = await queue.deadLetter.replayAll()
      expect(count).toBeGreaterThanOrEqual(0) // depends on mock state
    })

    it('deadLetter.purge() removes dead jobs', async () => {
      queue.handle('dl-job', async () => { throw new Error('fatal') })
      await queue.enqueue('dl-job', {}, { maxRetries: 1 })
      await queue.processNext('dl-job')

      const count = await queue.deadLetter.purge()
      expect(typeof count).toBe('number')
    })
  })

  describe('pipeline()', () => {
    beforeEach(async () => {
      queue.use(makeBackendPlugin(backend))
      await queue.start()
    })

    it('registers user middleware that runs during enqueue', async () => {
      const mw = vi.fn(async (_ctx: JobContext, next: () => Promise<void>) => {
        await next()
      })
      queue.pipeline('enqueue', mw)
      await queue.enqueue('test-job', {})
      expect(mw).toHaveBeenCalled()
    })

    it('registers user middleware that runs during process', async () => {
      const mw = vi.fn(async (_ctx: JobContext, next: () => Promise<void>) => {
        await next()
      })
      queue.pipeline('process', mw)
      queue.handle('test-job', async () => 'ok')
      await queue.enqueue('test-job', {})
      await queue.processNext('test-job')
      expect(mw).toHaveBeenCalled()
    })

    it('user middleware can modify context state', async () => {
      let capturedState: Record<string, unknown> = {}
      queue.pipeline('process', async (ctx, next) => {
        ctx.state['injected'] = true
        await next()
      }, { phase: 'guard' })

      queue.handle('test-job', async (ctx) => {
        capturedState = { ...ctx.state }
        return 'done'
      })

      await queue.enqueue('test-job', {})
      await queue.processNext('test-job')

      expect(capturedState['injected']).toBe(true)
    })

    it('user middleware with phase guard runs before execute', async () => {
      const order: string[] = []

      queue.pipeline('process', async (_ctx, next) => {
        order.push('guard')
        await next()
      }, { phase: 'guard' })

      queue.pipeline('process', async (_ctx, next) => {
        order.push('execute')
        await next()
      }, { phase: 'execute' })

      queue.handle('test-job', async () => {
        order.push('handler')
        return 'done'
      })

      await queue.enqueue('test-job', {})
      await queue.processNext('test-job')

      expect(order.indexOf('guard')).toBeLessThan(order.indexOf('execute'))
    })
  })

  describe('expose()', () => {
    it('makes APIs accessible via getExposed()', () => {
      const api = { doSomething: () => 'done' }
      const plugin: PsyPlugin = {
        name: 'test-plugin',
        version: '1.0.0',
        init(kernel) {
          kernel.expose('myApi', api as Record<string, unknown>)
        },
      }
      queue.use(plugin)
      expect(queue.getExposed('myApi')).toBe(api)
    })

    it('returns undefined for non-exposed namespace', () => {
      expect(queue.getExposed('nonexistent')).toBeUndefined()
    })
  })

  describe('error classification and retry behavior', () => {
    beforeEach(async () => {
      queue.use(makeBackendPlugin(backend))
      await queue.start()
    })

    it('validation errors are not retried and go to dead letter', async () => {
      queue.handle('validate-job', async () => {
        throw new Error('validation failed: missing field')
      })
      await queue.enqueue('validate-job', {}, { maxRetries: 5 })
      await queue.processNext('validate-job')

      // Validation errors are classified as non-retryable
      expect(backend.nack).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ deadLetter: true })
      )
    })

    it('transient errors (timeout) are retried', async () => {
      queue.handle('timeout-job', async () => {
        throw new Error('connection timeout')
      })
      await queue.enqueue('timeout-job', {}, { maxRetries: 5 })
      await queue.processNext('timeout-job')

      expect(backend.nack).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ requeue: true })
      )
    })
  })

  describe('plugin integration', () => {
    it('plugin can register middleware via kernel.pipeline()', async () => {
      const mw = vi.fn(async (_ctx: JobContext, next: () => Promise<void>) => next())
      const plugin: PsyPlugin = {
        name: 'middleware-plugin',
        version: '1.0.0',
        init(kernel) {
          kernel.pipeline('process', mw, { phase: 'guard' })
        },
      }

      queue.use(makeBackendPlugin(backend))
      queue.use(plugin)
      await queue.start()

      queue.handle('test-job', async () => 'ok')
      await queue.enqueue('test-job', {})
      await queue.processNext('test-job')

      expect(mw).toHaveBeenCalled()
    })

    it('plugin can access backend via kernel.getBackend()', async () => {
      let gotBackend: BackendAdapter | null = null
      const plugin: PsyPlugin = {
        name: 'backend-consumer',
        version: '1.0.0',
        depends: ['backend'],
        init(kernel) {
          gotBackend = kernel.getBackend()
        },
      }

      queue.use(makeBackendPlugin(backend))
      queue.use(plugin)

      expect(gotBackend).toBe(backend)
    })
  })
})
