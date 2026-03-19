import { describe, it, expect, vi } from 'vitest'
import { createContext } from '../src/context.js'
import type { Job, LifecycleEvent } from '../src/types.js'

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-123',
    queue: 'default',
    name: 'test-job',
    payload: { foo: 'bar' },
    priority: 0,
    maxRetries: 3,
    attempt: 1,
    backoff: 'exponential',
    timeout: 30000,
    status: 'pending',
    createdAt: new Date(),
    meta: {},
    ...overrides,
  }
}

function makeInternals() {
  return {
    enqueue: vi.fn(async () => 'new-job-id'),
    updateJob: vi.fn(async () => {}),
  }
}

describe('createContext', () => {
  it('creates context with correct job and event', () => {
    const job = makeJob()
    const internals = makeInternals()
    const ctx = createContext(job, 'process', internals)

    expect(ctx.job).toBe(job)
    expect(ctx.event).toBe('process')
  })

  it('creates context with the given lifecycle event', () => {
    const events: LifecycleEvent[] = ['enqueue', 'dequeue', 'process', 'complete', 'fail', 'retry', 'schedule']
    for (const event of events) {
      const ctx = createContext(makeJob(), event, makeInternals())
      expect(ctx.event).toBe(event)
    }
  })

  it('initializes state as an empty object', () => {
    const ctx = createContext(makeJob(), 'process', makeInternals())
    expect(ctx.state).toEqual({})
  })

  describe('requeue()', () => {
    it('stores empty requeue opts in state when called without args', () => {
      const ctx = createContext(makeJob(), 'process', makeInternals())
      ctx.requeue()
      expect(ctx.state['_requeue']).toEqual({})
    })

    it('stores requeue opts in state when called with opts', () => {
      const ctx = createContext(makeJob(), 'process', makeInternals())
      ctx.requeue({ delay: 5000, priority: 10 })
      expect(ctx.state['_requeue']).toEqual({ delay: 5000, priority: 10 })
    })
  })

  describe('deadLetter()', () => {
    it('stores reason in state', () => {
      const ctx = createContext(makeJob(), 'process', makeInternals())
      ctx.deadLetter('payment gateway unreachable')
      expect(ctx.state['_deadLetter']).toBe('payment gateway unreachable')
    })
  })

  describe('breaker()', () => {
    it('calls the function directly (default behavior)', async () => {
      const ctx = createContext(makeJob(), 'process', makeInternals())
      const fn = vi.fn(async () => 42)
      const result = await ctx.breaker('test-breaker', fn)
      expect(fn).toHaveBeenCalledOnce()
      expect(result).toBe(42)
    })

    it('propagates errors from the function', async () => {
      const ctx = createContext(makeJob(), 'process', makeInternals())
      const fn = vi.fn(async () => { throw new Error('breaker-err') })
      await expect(ctx.breaker('test-breaker', fn)).rejects.toThrow('breaker-err')
    })
  })

  describe('updateJob()', () => {
    it('calls internal updater and patches job object', async () => {
      const job = makeJob({ priority: 0 })
      const internals = makeInternals()
      const ctx = createContext(job, 'process', internals)

      await ctx.updateJob({ priority: 10 })

      expect(internals.updateJob).toHaveBeenCalledWith('job-123', { priority: 10 })
      expect(job.priority).toBe(10)
    })

    it('applies multiple fields at once', async () => {
      const job = makeJob()
      const internals = makeInternals()
      const ctx = createContext(job, 'process', internals)

      await ctx.updateJob({ status: 'active', attempt: 2 })

      expect(job.status).toBe('active')
      expect(job.attempt).toBe(2)
    })
  })

  describe('enqueue()', () => {
    it('delegates to internal enqueue', async () => {
      const internals = makeInternals()
      const ctx = createContext(makeJob(), 'process', internals)

      const result = await ctx.enqueue('send-email', { to: 'a@b.com' }, { queue: 'emails' })

      expect(internals.enqueue).toHaveBeenCalledWith('send-email', { to: 'a@b.com' }, { queue: 'emails' })
      expect(result).toBe('new-job-id')
    })

    it('works without opts', async () => {
      const internals = makeInternals()
      const ctx = createContext(makeJob(), 'process', internals)

      await ctx.enqueue('cleanup', {})

      expect(internals.enqueue).toHaveBeenCalledWith('cleanup', {}, undefined)
    })
  })

  describe('log', () => {
    it('log.debug does not throw', () => {
      const ctx = createContext(makeJob(), 'process', makeInternals())
      expect(() => ctx.log.debug('test message')).not.toThrow()
    })

    it('log.info does not throw', () => {
      const ctx = createContext(makeJob(), 'process', makeInternals())
      expect(() => ctx.log.info('test message')).not.toThrow()
    })

    it('log.warn does not throw', () => {
      const ctx = createContext(makeJob(), 'process', makeInternals())
      expect(() => ctx.log.warn('test message')).not.toThrow()
    })

    it('log.error does not throw', () => {
      const ctx = createContext(makeJob(), 'process', makeInternals())
      expect(() => ctx.log.error('test message')).not.toThrow()
    })

    it('log methods accept optional data', () => {
      const ctx = createContext(makeJob(), 'process', makeInternals())
      expect(() => ctx.log.debug('msg', { key: 'value' })).not.toThrow()
      expect(() => ctx.log.info('msg', { key: 'value' })).not.toThrow()
      expect(() => ctx.log.warn('msg', { key: 'value' })).not.toThrow()
      expect(() => ctx.log.error('msg', { key: 'value' })).not.toThrow()
    })
  })
})
