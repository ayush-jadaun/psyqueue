import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MiddlewarePipeline } from '../src/middleware-pipeline.js'
import type { JobContext, Middleware, MiddlewarePhase } from '../src/types.js'

function makeCtx(overrides: Partial<JobContext> = {}): JobContext {
  return {
    job: {
      id: 'job-1',
      queue: 'default',
      name: 'test-job',
      payload: {},
      priority: 0,
      maxRetries: 3,
      attempt: 1,
      backoff: 'exponential',
      timeout: 30000,
      status: 'pending',
      createdAt: new Date(),
      meta: {},
    },
    event: 'process',
    state: {},
    requeue: vi.fn(),
    deadLetter: vi.fn(),
    breaker: vi.fn(),
    updateJob: vi.fn(),
    enqueue: vi.fn(),
    log: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    ...overrides,
  }
}

describe('MiddlewarePipeline', () => {
  let pipeline: MiddlewarePipeline

  beforeEach(() => {
    pipeline = new MiddlewarePipeline()
  })

  describe('run() — empty pipeline', () => {
    it('resolves without error when no middleware is registered for the event', async () => {
      const ctx = makeCtx()
      await expect(pipeline.run('process', ctx)).resolves.toBeUndefined()
    })

    it('resolves without error when the event chain is empty', async () => {
      const ctx = makeCtx()
      // Add middleware to a different event, not to 'process'
      pipeline.add('enqueue', async (_ctx, next) => next(), { pluginName: 'test' })
      await expect(pipeline.run('process', ctx)).resolves.toBeUndefined()
    })
  })

  describe('run() — phase ordering', () => {
    it('executes middleware in phase order: guard → execute → finalize', async () => {
      const order: string[] = []
      pipeline.add('process', async (_ctx, next) => { order.push('execute'); await next() }, { phase: 'execute', pluginName: 'p1' })
      pipeline.add('process', async (_ctx, next) => { order.push('finalize'); await next() }, { phase: 'finalize', pluginName: 'p2' })
      pipeline.add('process', async (_ctx, next) => { order.push('guard'); await next() }, { phase: 'guard', pluginName: 'p3' })
      await pipeline.run('process', makeCtx())
      expect(order).toEqual(['guard', 'execute', 'finalize'])
    })

    it('executes all 6 phases in correct order', async () => {
      const order: string[] = []
      const phases: MiddlewarePhase[] = ['finalize', 'execute', 'observe', 'transform', 'validate', 'guard']
      for (const phase of phases) {
        pipeline.add('process', async (_ctx, next) => { order.push(phase); await next() }, { phase, pluginName: 'p' })
      }
      await pipeline.run('process', makeCtx())
      expect(order).toEqual(['guard', 'validate', 'transform', 'observe', 'execute', 'finalize'])
    })

    it('within the same phase, runs middleware in registration order', async () => {
      const order: string[] = []
      pipeline.add('process', async (_ctx, next) => { order.push('first'); await next() }, { phase: 'execute', pluginName: 'p1' })
      pipeline.add('process', async (_ctx, next) => { order.push('second'); await next() }, { phase: 'execute', pluginName: 'p2' })
      pipeline.add('process', async (_ctx, next) => { order.push('third'); await next() }, { phase: 'execute', pluginName: 'p3' })
      await pipeline.run('process', makeCtx())
      expect(order).toEqual(['first', 'second', 'third'])
    })
  })

  describe('run() — short-circuit', () => {
    it('stops the chain when a middleware does not call next()', async () => {
      const afterGuard = vi.fn()
      pipeline.add('process', async (_ctx, _next) => { /* does not call next */ }, { phase: 'guard', pluginName: 'guard' })
      pipeline.add('process', async (_ctx, next) => { afterGuard(); await next() }, { phase: 'execute', pluginName: 'exec' })
      await pipeline.run('process', makeCtx())
      expect(afterGuard).not.toHaveBeenCalled()
    })
  })

  describe('run() — wrapping next()', () => {
    it('supports before/after logic by calling code before and after next()', async () => {
      const events: string[] = []
      pipeline.add('process', async (_ctx, next) => {
        events.push('before')
        await next()
        events.push('after')
      }, { phase: 'observe', pluginName: 'observer' })
      pipeline.add('process', async (_ctx, next) => {
        events.push('work')
        await next()
      }, { phase: 'execute', pluginName: 'worker' })
      await pipeline.run('process', makeCtx())
      expect(events).toEqual(['before', 'work', 'after'])
    })
  })

  describe('run() — error propagation', () => {
    it('propagates errors thrown by middleware', async () => {
      pipeline.add('process', async () => {
        throw new Error('middleware-error')
      }, { phase: 'execute', pluginName: 'broken' })
      await expect(pipeline.run('process', makeCtx())).rejects.toThrow('middleware-error')
    })

    it('propagates errors from middleware that occur after next()', async () => {
      pipeline.add('process', async (_ctx, next) => {
        await next()
        throw new Error('after-next-error')
      }, { phase: 'guard', pluginName: 'wrapper' })
      await expect(pipeline.run('process', makeCtx())).rejects.toThrow('after-next-error')
    })
  })

  describe('run() — default phase', () => {
    it('defaults to execute phase when no phase is specified', async () => {
      const order: string[] = []
      // Add guard explicitly, then one with no phase (should default to execute)
      pipeline.add('process', async (_ctx, next) => { order.push('guard'); await next() }, { phase: 'guard', pluginName: 'g' })
      pipeline.add('process', async (_ctx, next) => { order.push('default-execute'); await next() }, { pluginName: 'e' })
      await pipeline.run('process', makeCtx())
      expect(order).toEqual(['guard', 'default-execute'])
    })
  })

  describe('run() — separate chains per event', () => {
    it('does not mix middleware registered for different lifecycle events', async () => {
      const enqueueMiddleware = vi.fn(async (_ctx: JobContext, next: () => Promise<void>) => next())
      const processMiddleware = vi.fn(async (_ctx: JobContext, next: () => Promise<void>) => next())
      pipeline.add('enqueue', enqueueMiddleware, { pluginName: 'p' })
      pipeline.add('process', processMiddleware, { pluginName: 'p' })

      await pipeline.run('enqueue', makeCtx({ event: 'enqueue' }))
      expect(enqueueMiddleware).toHaveBeenCalledOnce()
      expect(processMiddleware).not.toHaveBeenCalled()

      await pipeline.run('process', makeCtx({ event: 'process' }))
      expect(processMiddleware).toHaveBeenCalledOnce()
      expect(enqueueMiddleware).toHaveBeenCalledOnce() // still only once
    })
  })

  describe('add() — pluginName tracking', () => {
    it('accepts a pluginName without error', () => {
      expect(() =>
        pipeline.add('process', async (_ctx, next) => next(), { pluginName: 'auth-plugin', phase: 'guard' })
      ).not.toThrow()
    })
  })
})
