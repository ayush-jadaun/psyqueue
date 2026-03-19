import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Breaker } from '../src/breaker.js'
import { circuitBreaker } from '../src/index.js'
import { PsyQueue } from 'psyqueue'
import { sqlite } from '../../backend-sqlite/src/index.js'

// ============================================================================
// Unit tests: Breaker state machine
// ============================================================================

describe('Breaker', () => {
  it('starts in CLOSED state', () => {
    const b = new Breaker({ failureThreshold: 3, failureWindow: 60000, resetTimeout: 5000, halfOpenRequests: 1 })
    expect(b.currentState).toBe('CLOSED')
  })

  it('stays CLOSED below threshold', () => {
    const b = new Breaker({ failureThreshold: 3, failureWindow: 60000, resetTimeout: 5000, halfOpenRequests: 1 })
    b.recordFailure()
    b.recordFailure()
    expect(b.currentState).toBe('CLOSED')
  })

  it('opens after failure threshold', () => {
    const b = new Breaker({ failureThreshold: 3, failureWindow: 60000, resetTimeout: 5000, halfOpenRequests: 1 })
    b.recordFailure()
    b.recordFailure()
    b.recordFailure()
    expect(b.currentState).toBe('OPEN')
  })

  it('transitions OPEN → HALF_OPEN after resetTimeout', async () => {
    const b = new Breaker({ failureThreshold: 1, failureWindow: 60000, resetTimeout: 50, halfOpenRequests: 1 })
    b.recordFailure()
    expect(b.currentState).toBe('OPEN')
    await new Promise(r => setTimeout(r, 60))
    expect(b.currentState).toBe('HALF_OPEN')
  })

  it('closes after successful half-open requests', async () => {
    const b = new Breaker({ failureThreshold: 1, failureWindow: 60000, resetTimeout: 50, halfOpenRequests: 2 })
    b.recordFailure()
    await new Promise(r => setTimeout(r, 60))
    expect(b.currentState).toBe('HALF_OPEN')
    b.recordSuccess()
    expect(b.currentState).toBe('HALF_OPEN') // need 2
    b.recordSuccess()
    expect(b.currentState).toBe('CLOSED')
  })

  it('re-opens on failure during half-open', async () => {
    const b = new Breaker({ failureThreshold: 1, failureWindow: 60000, resetTimeout: 50, halfOpenRequests: 2 })
    b.recordFailure()
    await new Promise(r => setTimeout(r, 60))
    b.recordFailure() // fails during half-open
    expect(b.currentState).toBe('OPEN')
  })

  it('prunes old failures outside window', async () => {
    const b = new Breaker({ failureThreshold: 3, failureWindow: 50, resetTimeout: 5000, halfOpenRequests: 1 })
    b.recordFailure()
    b.recordFailure()
    await new Promise(r => setTimeout(r, 60))
    b.recordFailure() // old 2 expired, only 1 in window
    expect(b.currentState).toBe('CLOSED')
  })

  it('canExecute returns false when OPEN', () => {
    const b = new Breaker({ failureThreshold: 1, failureWindow: 60000, resetTimeout: 5000, halfOpenRequests: 1 })
    b.recordFailure()
    expect(b.canExecute()).toBe(false)
  })

  it('canExecute returns true when CLOSED', () => {
    const b = new Breaker({ failureThreshold: 3, failureWindow: 60000, resetTimeout: 5000, halfOpenRequests: 1 })
    expect(b.canExecute()).toBe(true)
  })

  it('canExecute returns true when HALF_OPEN', async () => {
    const b = new Breaker({ failureThreshold: 1, failureWindow: 60000, resetTimeout: 50, halfOpenRequests: 1 })
    b.recordFailure()
    await new Promise(r => setTimeout(r, 60))
    expect(b.canExecute()).toBe(true) // HALF_OPEN allows attempts
  })

  it('resets failures array when closing from HALF_OPEN', async () => {
    const b = new Breaker({ failureThreshold: 2, failureWindow: 60000, resetTimeout: 50, halfOpenRequests: 1 })
    b.recordFailure()
    b.recordFailure() // trips to OPEN
    await new Promise(r => setTimeout(r, 60)) // transitions to HALF_OPEN
    b.recordSuccess() // closes the circuit
    expect(b.currentState).toBe('CLOSED')
    // After close, single failure should not immediately re-open (threshold is 2)
    b.recordFailure()
    expect(b.currentState).toBe('CLOSED')
  })

  it('recordSuccess is a no-op when CLOSED', () => {
    const b = new Breaker({ failureThreshold: 3, failureWindow: 60000, resetTimeout: 5000, halfOpenRequests: 1 })
    b.recordSuccess()
    b.recordSuccess()
    expect(b.currentState).toBe('CLOSED')
  })
})

// ============================================================================
// Integration tests: circuit breaker plugin with PsyQueue
// ============================================================================

describe('Circuit Breaker Integration', () => {
  let q: PsyQueue

  beforeEach(() => {
    q = new PsyQueue()
  })

  afterEach(async () => {
    await q.stop()
  })

  it('ctx.breaker passes through and returns value when circuit is CLOSED', async () => {
    const called: string[] = []

    q.use(sqlite({ path: ':memory:' }))
    q.use(circuitBreaker({
      breakers: {
        stripe: { failureThreshold: 3, failureWindow: 60000, resetTimeout: 30000, halfOpenRequests: 1 },
      },
    }))
    q.handle('payment', async (ctx) => {
      const result = await ctx.breaker('stripe', async () => {
        called.push('fn')
        return 'ok'
      })
      return result
    })
    await q.start()

    await q.enqueue('payment', {})
    await q.processNext('payment')

    expect(called).toEqual(['fn'])
  })

  it('emits circuit:open event when breaker trips', async () => {
    const events: string[] = []

    q.use(sqlite({ path: ':memory:' }))
    q.use(circuitBreaker({
      breakers: {
        svc: { failureThreshold: 2, failureWindow: 60000, resetTimeout: 30000, halfOpenRequests: 1 },
      },
    }))

    // Give jobs a retry so errors don't dead-letter on first attempt
    q.handle('job', async (ctx) => {
      return ctx.breaker('svc', async () => {
        throw new Error('svc down')
      })
    })

    q.events.on('circuit:open', () => events.push('open'))
    await q.start()

    // First failure — below threshold (threshold=2)
    await q.enqueue('job', {}, { maxRetries: 5 })
    await q.processNext('job')
    expect(events).not.toContain('open')

    // Second failure — hits threshold, trips breaker
    await q.enqueue('job', {}, { maxRetries: 5 })
    await q.processNext('job')
    expect(events).toContain('open')
  })

  it('requeues job when circuit is open (onOpen: requeue)', async () => {
    const events: string[] = []

    q.use(sqlite({ path: ':memory:' }))
    const plugin = circuitBreaker({
      breakers: {
        stripe: { failureThreshold: 1, failureWindow: 60000, resetTimeout: 30000, halfOpenRequests: 1, onOpen: 'requeue' },
      },
    })
    q.use(plugin)

    let callCount = 0
    q.handle('payment', async (ctx) => {
      callCount++
      return ctx.breaker('stripe', async () => {
        throw new Error('stripe down')
      })
    })

    q.events.on('circuit:open', () => events.push('open'))
    q.events.on('job:requeued', () => events.push('requeued'))
    await q.start()

    // First process — fn throws, trips circuit (threshold=1)
    await q.enqueue('payment', {}, { maxRetries: 5 })
    await q.processNext('payment')
    expect(events).toContain('open')
    expect(callCount).toBe(1)

    // Enqueue a fresh job while circuit is OPEN.
    // ctx.breaker detects open circuit, calls ctx.requeue(), returns without calling fn.
    // The job completes "successfully" (no throw) so processNext checks ctx.state['_requeue']
    // and requeues it, emitting 'job:requeued'.
    await q.enqueue('payment', {})
    await q.processNext('payment')
    expect(events).toContain('requeued')
    expect(callCount).toBe(2)
  })

  it('dead-letters job when circuit is open (onOpen: fail)', async () => {
    const events: string[] = []

    q.use(sqlite({ path: ':memory:' }))
    const plugin = circuitBreaker({
      breakers: {
        stripe: { failureThreshold: 1, failureWindow: 60000, resetTimeout: 30000, halfOpenRequests: 1, onOpen: 'fail' },
      },
    })
    q.use(plugin)

    let callCount = 0
    q.handle('payment', async (ctx) => {
      callCount++
      return ctx.breaker('stripe', async () => {
        throw new Error('stripe down')
      })
    })

    q.events.on('circuit:open', () => events.push('open'))
    q.events.on('job:dead', () => events.push('dead'))
    await q.start()

    // First process — fn throws, trips circuit (threshold=1)
    await q.enqueue('payment', {}, { maxRetries: 5 })
    await q.processNext('payment')
    expect(events).toContain('open')
    expect(callCount).toBe(1)

    // Enqueue a fresh job while circuit is OPEN.
    // ctx.breaker detects open circuit, calls ctx.deadLetter(), returns without calling fn.
    // The job completes "successfully" (no throw) so processNext checks ctx.state['_deadLetter']
    // and dead-letters it, emitting 'job:dead'.
    await q.enqueue('payment', {})
    await q.processNext('payment')
    expect(events).toContain('dead')
    expect(callCount).toBe(2)
  })

  it('emits circuit:close event when breaker recovers via HALF_OPEN', async () => {
    const events: string[] = []

    q.use(sqlite({ path: ':memory:' }))
    q.use(circuitBreaker({
      breakers: {
        svc: { failureThreshold: 1, failureWindow: 60000, resetTimeout: 50, halfOpenRequests: 1 },
      },
    }))

    let shouldFail = true
    q.handle('job', async (ctx) => {
      return ctx.breaker('svc', async () => {
        if (shouldFail) throw new Error('svc down')
        return 'ok'
      })
    })

    q.events.on('circuit:open', () => events.push('open'))
    q.events.on('circuit:half-open', () => events.push('half-open'))
    q.events.on('circuit:close', () => events.push('close'))
    await q.start()

    // Trip the breaker
    await q.enqueue('job', {}, { maxRetries: 5 })
    await q.processNext('job')
    expect(events).toContain('open')

    // Wait for reset timeout to elapse so circuit can transition to HALF_OPEN
    await new Promise(r => setTimeout(r, 80))

    // Now try with success — should transition HALF_OPEN → CLOSED
    shouldFail = false
    await q.enqueue('job', {})
    await q.processNext('job')

    expect(events).toContain('half-open')
    expect(events).toContain('close')
  })

  it('passes through unknown breaker names via default implementation', async () => {
    const called: string[] = []

    q.use(sqlite({ path: ':memory:' }))
    q.use(circuitBreaker({
      breakers: {
        stripe: { failureThreshold: 3, failureWindow: 60000, resetTimeout: 30000, halfOpenRequests: 1 },
      },
    }))

    q.handle('job', async (ctx) => {
      // 'unknown' is not in the breakers config — passes through to default
      return ctx.breaker('unknown', async () => {
        called.push('called')
        return 'result'
      })
    })

    await q.start()
    await q.enqueue('job', {})
    await q.processNext('job')

    expect(called).toEqual(['called'])
  })

  it('multiple independent breakers do not affect each other', async () => {
    const openEvents: string[] = []

    q.use(sqlite({ path: ':memory:' }))
    q.use(circuitBreaker({
      breakers: {
        svcA: { failureThreshold: 1, failureWindow: 60000, resetTimeout: 30000, halfOpenRequests: 1 },
        svcB: { failureThreshold: 3, failureWindow: 60000, resetTimeout: 30000, halfOpenRequests: 1 },
      },
    }))

    // svcA trips on first failure (threshold=1)
    // svcB does NOT trip because threshold=3 and we only fail once
    q.handle('job', async (ctx) => {
      await ctx.breaker('svcA', async () => {
        throw new Error('svcA down')
      }).catch(() => {})
      return ctx.breaker('svcB', async () => 'ok')
    })

    q.events.on('circuit:open', (e) => openEvents.push((e.data as { name: string }).name))
    await q.start()

    await q.enqueue('job', {})
    await q.processNext('job')

    expect(openEvents).toContain('svcA')
    expect(openEvents).not.toContain('svcB')
  })

  it('getBreaker returns the Breaker instance by name', () => {
    const plugin = circuitBreaker({
      breakers: {
        stripe: { failureThreshold: 3, failureWindow: 60000, resetTimeout: 5000, halfOpenRequests: 1 },
      },
    })

    const breaker = plugin.getBreaker('stripe')
    expect(breaker).toBeDefined()
    expect(breaker?.currentState).toBe('CLOSED')
  })

  it('getBreaker returns undefined for unknown name', () => {
    const plugin = circuitBreaker({
      breakers: {
        stripe: { failureThreshold: 3, failureWindow: 60000, resetTimeout: 5000, halfOpenRequests: 1 },
      },
    })

    expect(plugin.getBreaker('unknown')).toBeUndefined()
  })
})
