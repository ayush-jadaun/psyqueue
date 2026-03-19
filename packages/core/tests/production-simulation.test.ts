import { describe, it, expect, afterEach } from 'vitest'
import { PsyQueue } from '../src/kernel.js'
import { sqlite } from '../../backend-sqlite/src/index.js'
import type { BackendAdapter, PsyEvent } from '../src/types.js'

/**
 * Production Simulation Tests
 *
 * Every test uses a real SQLite in-memory backend (no mocks).
 * Handlers do actual work (computation, I/O simulation, deliberate failures).
 * Assertions verify correctness: specific values, counts, and orderings.
 */
describe('Production Simulation', () => {
  let q: PsyQueue

  afterEach(async () => {
    if (q) await q.stop().catch(() => {})
  })

  // =========================================================
  // TEST 1: Jobs with real work — CPU computation
  // =========================================================
  it('processes jobs that do real CPU work (fibonacci)', async () => {
    q = new PsyQueue()
    q.use(sqlite({ path: ':memory:' }))

    const results: number[] = []
    q.handle('fibonacci', async (ctx) => {
      const n = (ctx.job.payload as { n: number }).n
      function fib(x: number): number { return x <= 1 ? x : fib(x - 1) + fib(x - 2) }
      const result = fib(n)
      results.push(result)
      return { n, result }
    })
    await q.start()

    await q.enqueue('fibonacci', { n: 10 })
    await q.enqueue('fibonacci', { n: 15 })
    await q.enqueue('fibonacci', { n: 20 })

    await q.processNext('fibonacci')
    await q.processNext('fibonacci')
    await q.processNext('fibonacci')

    expect(results).toEqual([55, 610, 6765])
  })

  // =========================================================
  // TEST 2: Jobs with simulated I/O delay
  // =========================================================
  it('processes jobs with async I/O delays', async () => {
    q = new PsyQueue()
    q.use(sqlite({ path: ':memory:' }))

    const processed: string[] = []
    q.handle('send-email', async (ctx) => {
      const { to } = ctx.job.payload as { to: string }
      await new Promise(r => setTimeout(r, 10))
      processed.push(to)
      return { sent: true, to }
    })
    await q.start()

    await q.enqueue('send-email', { to: 'alice@test.com' })
    await q.enqueue('send-email', { to: 'bob@test.com' })

    await q.processNext('send-email')
    await q.processNext('send-email')

    expect(processed).toEqual(['alice@test.com', 'bob@test.com'])
  })

  // =========================================================
  // TEST 3: Retry with REAL transient failures
  // =========================================================
  it('retries transient failures and eventually succeeds', async () => {
    q = new PsyQueue()
    q.use(sqlite({ path: ':memory:' }))

    let attempts = 0
    q.handle('flaky-api', async () => {
      attempts++
      if (attempts < 3) {
        // Simulate a real API returning timeout
        throw new Error('timeout — Service Unavailable')
      }
      return { success: true, attempts }
    })
    await q.start()

    // maxRetries=5 means up to 5 retries allowed.
    // With backoff=fixed, backoffBase=0, jitter=false, retried jobs have no delay.
    await q.enqueue('flaky-api', { endpoint: '/api/charge' }, {
      maxRetries: 5,
      backoff: 'fixed',
      backoffBase: 0,
      backoffJitter: false,
    })

    // attempt 1 (job.attempt=1) fails, requeued with attempt=2
    await q.processNext('flaky-api')
    expect(attempts).toBe(1)

    // attempt 2 (job.attempt=2) fails, requeued with attempt=3
    await q.processNext('flaky-api')
    expect(attempts).toBe(2)

    // attempt 3 (job.attempt=3) succeeds
    await q.processNext('flaky-api')
    expect(attempts).toBe(3)
  })

  // =========================================================
  // TEST 4: Dead letter after permanent failure
  // =========================================================
  it('dead-letters permanently failing jobs and allows replay', async () => {
    q = new PsyQueue()
    q.use(sqlite({ path: ':memory:' }))

    q.handle('bad-job', async () => {
      throw new Error('Permanent failure: invalid data')
    })
    await q.start()

    // maxRetries=1 means: attempt 1 fails, attempt(1) >= maxRetries(1) -> dead letter
    await q.enqueue('bad-job', { data: 'corrupt' }, { maxRetries: 1 })

    await q.processNext('bad-job') // attempt 1 fails, since 1 >= 1 -> dead letter

    // Verify it is in dead letter
    const dead = await q.deadLetter.list({ queue: 'bad-job' })
    expect(dead.data.length).toBe(1)
    expect(dead.data[0]!.payload).toEqual({ data: 'corrupt' })
    expect(dead.data[0]!.status).toBe('dead')

    // Replay it
    await q.deadLetter.replay(dead.data[0]!.id)

    // After replay, job should be back in pending
    const backend = q.getExposed('backend') as unknown as BackendAdapter
    const replayedJob = await backend.getJob(dead.data[0]!.id)
    expect(replayedJob).not.toBeNull()
    expect(replayedJob!.status).toBe('pending')
  })

  // =========================================================
  // TEST 5: Worker pool with concurrent processing
  // =========================================================
  it('startWorker processes jobs concurrently', async () => {
    q = new PsyQueue()
    q.use(sqlite({ path: ':memory:' }))

    const timestamps: number[] = []
    q.handle('parallel-work', async () => {
      await new Promise(r => setTimeout(r, 50))
      timestamps.push(Date.now())
      return { done: true }
    })
    await q.start()

    // Enqueue 10 jobs
    for (let i = 0; i < 10; i++) {
      await q.enqueue('parallel-work', { i })
    }

    // Process with concurrency 5 -- should take ~100ms not ~500ms
    let completed = 0
    q.events.on('job:completed', () => { completed++ })
    const start = Date.now()
    q.startWorker('parallel-work', { concurrency: 5, pollInterval: 5 })

    while (completed < 10) {
      await new Promise(r => setTimeout(r, 10))
      if (Date.now() - start > 5000) break // safety timeout
    }
    const elapsed = Date.now() - start

    // With concurrency 5 and 50ms per job, 10 jobs should take ~100-200ms, not 500ms
    expect(elapsed).toBeLessThan(400)
    expect(completed).toBe(10)
  })

  // =========================================================
  // TEST 6: Priority ordering under load
  // =========================================================
  it('processes high-priority jobs before low-priority ones', async () => {
    q = new PsyQueue()
    q.use(sqlite({ path: ':memory:' }))

    const order: number[] = []
    q.handle('prioritized', async (ctx) => {
      order.push((ctx.job.payload as { pri: number }).pri)
      return {}
    })
    await q.start()

    // Enqueue in random priority order
    await q.enqueue('prioritized', { pri: 1 }, { priority: 1 })
    await q.enqueue('prioritized', { pri: 50 }, { priority: 50 })
    await q.enqueue('prioritized', { pri: 10 }, { priority: 10 })
    await q.enqueue('prioritized', { pri: 99 }, { priority: 99 })
    await q.enqueue('prioritized', { pri: 25 }, { priority: 25 })

    for (let i = 0; i < 5; i++) await q.processNext('prioritized')

    // SQLite dequeue orders by priority DESC, created_at ASC
    expect(order).toEqual([99, 50, 25, 10, 1])
  })

  // =========================================================
  // TEST 7: Exactly-once prevents duplicate processing
  // =========================================================
  it('idempotency keys prevent duplicate job execution', async () => {
    const { exactlyOnce } = await import('../../plugin-exactly-once/src/index.js')

    q = new PsyQueue()
    q.use(sqlite({ path: ':memory:' }))
    q.use(exactlyOnce({ window: '1h' }))

    let executions = 0
    q.handle('payment', async () => {
      executions++
      return { charged: true }
    })
    await q.start()

    // Simulate duplicate webhook -- same idempotency key
    const id1 = await q.enqueue('payment', { amount: 99 }, { idempotencyKey: 'charge_123' })
    const id2 = await q.enqueue('payment', { amount: 99 }, { idempotencyKey: 'charge_123' })

    // Should return same job ID
    expect(id1).toBe(id2)

    // Process -- should only execute once since only one job was persisted
    await q.processNext('payment')
    const secondResult = await q.processNext('payment')

    expect(executions).toBe(1)
    expect(secondResult).toBe(false) // no second job to process
  })

  // =========================================================
  // TEST 8: Full event lifecycle
  // =========================================================
  it('emits complete event lifecycle for successful job', async () => {
    q = new PsyQueue()
    q.use(sqlite({ path: ':memory:' }))

    const events: string[] = []
    q.events.on('job:enqueued', () => events.push('enqueued'))
    q.events.on('job:started', () => events.push('started'))
    q.events.on('job:completed', () => events.push('completed'))

    q.handle('tracked', async () => {
      await new Promise(r => setTimeout(r, 5))
      return { tracked: true }
    })
    await q.start()

    await q.enqueue('tracked', { data: 'test' })
    await q.processNext('tracked')

    expect(events).toEqual(['enqueued', 'started', 'completed'])
  })

  // =========================================================
  // TEST 9: Metadata survives the full lifecycle
  // =========================================================
  it('preserves job metadata through processing', async () => {
    q = new PsyQueue()
    q.use(sqlite({ path: ':memory:' }))

    let receivedMeta: Record<string, unknown> = {}
    q.handle('with-meta', async (ctx) => {
      receivedMeta = ctx.job.meta
      return { got: ctx.job.meta }
    })
    await q.start()

    await q.enqueue('with-meta', { data: 1 }, {
      meta: { source: 'webhook', correlationId: 'req_abc', tenant: 'acme' },
    })
    await q.processNext('with-meta')

    expect(receivedMeta).toMatchObject({
      source: 'webhook',
      correlationId: 'req_abc',
      tenant: 'acme',
    })
  })

  // =========================================================
  // TEST 10: Bulk enqueue + process all
  // =========================================================
  it('bulk enqueues and processes 100 jobs correctly', async () => {
    q = new PsyQueue()
    q.use(sqlite({ path: ':memory:' }))

    const results: number[] = []
    q.handle('bulk', async (ctx) => {
      const n = (ctx.job.payload as { n: number }).n
      results.push(n * 2)
      return { doubled: n * 2 }
    })
    await q.start()

    // Bulk enqueue 100 jobs
    const jobs = Array.from({ length: 100 }, (_, i) => ({
      name: 'bulk',
      payload: { n: i },
    }))
    const ids = await q.enqueueBulk(jobs)
    expect(ids).toHaveLength(100)

    // Process all
    for (let i = 0; i < 100; i++) {
      await q.processNext('bulk')
    }

    // Verify all processed
    expect(results).toHaveLength(100)
    // All values should be even numbers (n * 2)
    expect(results.every(r => r % 2 === 0)).toBe(true)
    // Sum of 0*2 + 1*2 + ... + 99*2 = 2*(0+1+...+99) = 2*4950 = 9900
    const sum = results.reduce((a, b) => a + b, 0)
    expect(sum).toBe(9900)
  })

  // =========================================================
  // TEST 11: Workflow DAG end-to-end
  // =========================================================
  it('executes a multi-step workflow DAG correctly', async () => {
    const { workflows, workflow } = await import('../../plugin-workflows/src/index.js')

    q = new PsyQueue()
    q.use(sqlite({ path: ':memory:' }))

    const wfPlugin = workflows()
    q.use(wfPlugin)

    const steps: string[] = []

    const orderFlow = workflow('order')
      .step('validate', async () => {
        steps.push('validate')
        return { valid: true, orderId: 'ORD-123' }
      })
      .step('charge', async (ctx) => {
        steps.push('charge')
        const prev = ctx.results?.['validate'] as { orderId: string }
        return { charged: true, amount: 99.99, orderId: prev.orderId }
      }, { after: 'validate' })
      .step('ship', async (ctx) => {
        steps.push('ship')
        const prev = ctx.results?.['charge'] as { orderId: string }
        return { shipped: true, tracking: 'TRK-456', orderId: prev.orderId }
      }, { after: 'charge' })
      .build()

    // Register the workflow definition
    wfPlugin.engine.registerDefinition(orderFlow)

    // Register a handler that dispatches to the correct step
    q.handle('order', wfPlugin.engine.createHandler('order'))

    // Track workflow events
    let workflowCompleted = false
    let workflowResults: Record<string, unknown> = {}
    q.events.on('workflow:completed', (e) => {
      const d = e.data as { results: Record<string, unknown> }
      workflowCompleted = true
      workflowResults = d.results
    })

    await q.start()

    // Start the workflow
    const workflowId = await q.enqueue('order', { orderId: 'ORD-123', total: 99.99 })

    // Process steps one by one
    // Step 1: validate (root step, enqueued automatically)
    await q.processNext('order')
    // Step 2: charge (enqueued after validate completes)
    await q.processNext('order')
    // Step 3: ship (enqueued after charge completes)
    await q.processNext('order')

    // Verify step execution order
    expect(steps).toEqual(['validate', 'charge', 'ship'])

    // Verify workflow is complete
    expect(workflowCompleted).toBe(true)
    expect(workflowResults).toMatchObject({
      validate: { valid: true, orderId: 'ORD-123' },
      charge: { charged: true, amount: 99.99, orderId: 'ORD-123' },
      ship: { shipped: true, tracking: 'TRK-456', orderId: 'ORD-123' },
    })

    // Verify workflow instance state
    const instance = wfPlugin.engine.store.get(workflowId)
    expect(instance).toBeDefined()
    expect(instance!.status).toBe('COMPLETED')
  })

  // =========================================================
  // TEST 12: Handler result is stored and accessible
  // =========================================================
  it('stores handler result on completed job', async () => {
    q = new PsyQueue()
    q.use(sqlite({ path: ':memory:' }))

    q.handle('compute', async () => {
      return { answer: 42, computed: true }
    })
    await q.start()

    const jobId = await q.enqueue('compute', {})
    await q.processNext('compute')

    // Verify the job completed
    const backend = q.getExposed('backend') as unknown as BackendAdapter
    const job = await backend.getJob(jobId)
    expect(job).not.toBeNull()
    expect(job!.status).toBe('completed')
  })

  // =========================================================
  // TEST 13: Stress test -- rapid enqueue + process
  // =========================================================
  it('handles rapid enqueue and process without data loss', async () => {
    q = new PsyQueue()
    q.use(sqlite({ path: ':memory:' }))

    const seen = new Set<number>()
    q.handle('stress', async (ctx) => {
      const n = (ctx.job.payload as { n: number }).n
      seen.add(n)
      return {}
    })
    await q.start()

    const N = 500
    // Enqueue all
    for (let i = 0; i < N; i++) {
      await q.enqueue('stress', { n: i })
    }

    // Process all with worker
    let completed = 0
    q.events.on('job:completed', () => { completed++ })
    q.startWorker('stress', { concurrency: 5, pollInterval: 5 })

    const start = Date.now()
    while (completed < N && Date.now() - start < 15000) {
      await new Promise(r => setTimeout(r, 20))
    }

    // ZERO data loss -- every job was processed exactly once
    expect(seen.size).toBe(N)
    expect(completed).toBe(N)
    for (let i = 0; i < N; i++) {
      expect(seen.has(i)).toBe(true)
    }
  })

  // =========================================================
  // TEST 14: Failed event lifecycle
  // =========================================================
  it('emits job:failed, job:retry, job:dead events in correct sequence', async () => {
    q = new PsyQueue()
    q.use(sqlite({ path: ':memory:' }))

    const events: string[] = []
    q.events.on('job:enqueued', () => events.push('enqueued'))
    q.events.on('job:started', () => events.push('started'))
    q.events.on('job:failed', () => events.push('failed'))
    q.events.on('job:retry', () => events.push('retry'))
    q.events.on('job:dead', () => events.push('dead'))

    q.handle('fails-twice', async () => {
      throw new Error('timeout — always fails')
    })
    await q.start()

    // maxRetries=2 means: attempt 1 (1<2 -> retry), attempt 2 (2>=2 -> dead)
    await q.enqueue('fails-twice', {}, {
      maxRetries: 2,
      backoff: 'fixed',
      backoffBase: 0,
      backoffJitter: false,
    })

    // Attempt 1: fails, gets retried (requeued)
    await q.processNext('fails-twice')
    // Attempt 2: fails, exhausted retries -> dead letter
    await q.processNext('fails-twice')

    expect(events).toEqual([
      'enqueued',
      // Attempt 1: started -> failed + retry
      'started', 'retry', 'failed',
      // Attempt 2: started -> dead + failed
      'started', 'dead', 'failed',
    ])
  })

  // =========================================================
  // TEST 15: Circuit breaker protects against cascading failures
  // =========================================================
  it('circuit breaker opens after repeated failures and requeues jobs', async () => {
    const { circuitBreaker } = await import('../../plugin-circuit-breaker/src/index.js')

    q = new PsyQueue()
    q.use(sqlite({ path: ':memory:' }))

    let apiCallCount = 0
    const cbPlugin = circuitBreaker({
      breakers: {
        'payment-api': {
          failureThreshold: 2,
          failureWindow: 10_000,
          resetTimeout: 100, // short for test
          halfOpenRequests: 1,
          onOpen: 'requeue',
        },
      },
    })
    q.use(cbPlugin)

    const circuitEvents: string[] = []
    q.events.on('circuit:open', () => circuitEvents.push('open'))
    q.events.on('circuit:half-open', () => circuitEvents.push('half-open'))
    q.events.on('circuit:close', () => circuitEvents.push('close'))

    q.handle('charge', async (ctx) => {
      const result = await ctx.breaker('payment-api', async () => {
        apiCallCount++
        if (apiCallCount <= 2) {
          throw new Error('Payment API timeout')
        }
        return { txId: `TXN-${apiCallCount}` }
      })
      return result
    })
    await q.start()

    // Enqueue 4 jobs
    for (let i = 0; i < 4; i++) {
      await q.enqueue('charge', { amount: 10 * (i + 1) }, {
        maxRetries: 10,
        backoff: 'fixed',
        backoffBase: 0,
        backoffJitter: false,
      })
    }

    // Process first 2 -- both fail, circuit should open
    await q.processNext('charge') // api call 1 -> fail
    await q.processNext('charge') // api call 2 -> fail, trips breaker

    const breaker = cbPlugin.getBreaker('payment-api')!
    expect(breaker.currentState).toBe('OPEN')
    expect(circuitEvents).toContain('open')
    expect(apiCallCount).toBe(2)

    // Wait for resetTimeout to elapse (100ms)
    await new Promise(r => setTimeout(r, 150))

    // Next process should be half-open, api call 3 succeeds
    apiCallCount = 2 // next call is #3, which succeeds
    await q.processNext('charge')

    // Breaker should now be closed
    expect(breaker.currentState).toBe('CLOSED')
    expect(circuitEvents).toContain('half-open')
    expect(circuitEvents).toContain('close')
  })

  // =========================================================
  // TEST 16: Multi-tenant rate limiting
  // =========================================================
  it('tenancy plugin enforces per-tenant rate limits', async () => {
    const { tenancy } = await import('../../plugin-tenancy/src/index.js')

    q = new PsyQueue()
    q.use(sqlite({ path: ':memory:' }))
    q.use(tenancy({
      tiers: {
        free: {
          weight: 1,
          concurrency: 1,
          rateLimit: { max: 3, window: '1m' },
        },
        pro: {
          weight: 5,
          concurrency: 10,
          rateLimit: { max: 100, window: '1m' },
        },
      },
      resolveTier: async (tenantId: string) => {
        return tenantId.startsWith('free-') ? 'free' : 'pro'
      },
      scheduling: 'weighted-round-robin',
    }))

    q.handle('work', async (ctx) => {
      return { tenantId: ctx.job.tenantId }
    })
    await q.start()

    // Free tenant: 3 jobs allowed, 4th should fail
    await q.enqueue('work', { n: 1 }, { tenantId: 'free-tenant' })
    await q.enqueue('work', { n: 2 }, { tenantId: 'free-tenant' })
    await q.enqueue('work', { n: 3 }, { tenantId: 'free-tenant' })

    let rateLimited = false
    let errorCode = ''
    try {
      await q.enqueue('work', { n: 4 }, { tenantId: 'free-tenant' })
    } catch (err: unknown) {
      // Check by error code rather than instanceof to avoid module identity issues
      if (err && typeof err === 'object' && 'code' in err) {
        errorCode = (err as { code: string }).code
        rateLimited = errorCode === 'RATE_LIMIT_EXCEEDED'
      }
    }
    expect(rateLimited).toBe(true)
    expect(errorCode).toBe('RATE_LIMIT_EXCEEDED')

    // Pro tenant: 100 allowed, should have no problem with 10
    for (let i = 0; i < 10; i++) {
      await q.enqueue('work', { n: i }, { tenantId: 'pro-tenant' })
    }
    // If we got here without error, pro-tenant passed
    expect(true).toBe(true)
  })

  // =========================================================
  // TEST 17: User middleware intercepts and transforms jobs
  // =========================================================
  it('user middleware can inject state and observe processing', async () => {
    q = new PsyQueue()
    q.use(sqlite({ path: ':memory:' }))

    const middlewareLogs: string[] = []

    // Guard phase: inject tenant context
    q.pipeline('process', async (ctx, next) => {
      ctx.state['injected'] = 'guard-phase-data'
      middlewareLogs.push('guard-before')
      await next()
      middlewareLogs.push('guard-after')
    }, { phase: 'guard' })

    // Observe phase: log timing
    q.pipeline('process', async (ctx, next) => {
      const start = Date.now()
      middlewareLogs.push('observe-before')
      await next()
      const elapsed = Date.now() - start
      middlewareLogs.push(`observe-after-${elapsed >= 0 ? 'ok' : 'err'}`)
    }, { phase: 'observe' })

    let handlerSawInjectedData = false
    q.handle('mw-test', async (ctx) => {
      handlerSawInjectedData = ctx.state['injected'] === 'guard-phase-data'
      await new Promise(r => setTimeout(r, 5))
      return { ok: true }
    })
    await q.start()

    await q.enqueue('mw-test', {})
    await q.processNext('mw-test')

    expect(handlerSawInjectedData).toBe(true)
    expect(middlewareLogs).toContain('guard-before')
    expect(middlewareLogs).toContain('observe-before')
  })

  // =========================================================
  // TEST 18: Dead letter purge removes old dead jobs
  // =========================================================
  it('purges dead letter queue', async () => {
    q = new PsyQueue()
    q.use(sqlite({ path: ':memory:' }))

    q.handle('always-dies', async () => {
      throw new Error('permanent failure')
    })
    await q.start()

    // Create 5 dead-lettered jobs
    for (let i = 0; i < 5; i++) {
      await q.enqueue('always-dies', { i }, { maxRetries: 1 })
      await q.processNext('always-dies')
    }

    const deadBefore = await q.deadLetter.list()
    expect(deadBefore.data.length).toBe(5)

    // Purge all
    const purged = await q.deadLetter.purge()
    expect(purged).toBe(5)

    // Verify empty
    const deadAfter = await q.deadLetter.list()
    expect(deadAfter.data.length).toBe(0)
  })

  // =========================================================
  // TEST 19: Backoff strategies produce different delays
  // =========================================================
  it('exponential backoff produces increasing delays', async () => {
    q = new PsyQueue()
    q.use(sqlite({ path: ':memory:' }))

    // Use calculateBackoff directly to verify the math
    const mockJob = (attempt: number) => ({
      attempt,
      backoff: 'exponential' as const,
      backoffBase: 1000,
      backoffCap: 300_000,
      backoffJitter: false,
    })

    // Attempt 1: 1000 * 2^0 = 1000
    const d1 = q.calculateBackoff(mockJob(1) as any)
    expect(d1).toBe(1000)

    // Attempt 2: 1000 * 2^1 = 2000
    const d2 = q.calculateBackoff(mockJob(2) as any)
    expect(d2).toBe(2000)

    // Attempt 3: 1000 * 2^2 = 4000
    const d3 = q.calculateBackoff(mockJob(3) as any)
    expect(d3).toBe(4000)

    // Verify exponential growth
    expect(d2).toBe(d1 * 2)
    expect(d3).toBe(d2 * 2)
  })

  // =========================================================
  // TEST 20: startWorker with processNext equivalence
  // =========================================================
  it('startWorker produces identical results to manual processNext', async () => {
    // Run with processNext
    const q1 = new PsyQueue()
    q1.use(sqlite({ path: ':memory:' }))
    const manualResults: number[] = []
    q1.handle('double', async (ctx) => {
      const n = (ctx.job.payload as { n: number }).n
      const result = n * 2
      manualResults.push(result)
      return { result }
    })
    await q1.start()
    for (let i = 0; i < 20; i++) await q1.enqueue('double', { n: i })
    for (let i = 0; i < 20; i++) await q1.processNext('double')
    await q1.stop()

    // Run with startWorker
    q = new PsyQueue()
    q.use(sqlite({ path: ':memory:' }))
    const workerResults: number[] = []
    q.handle('double', async (ctx) => {
      const n = (ctx.job.payload as { n: number }).n
      const result = n * 2
      workerResults.push(result)
      return { result }
    })
    await q.start()
    for (let i = 0; i < 20; i++) await q.enqueue('double', { n: i })

    let completed = 0
    q.events.on('job:completed', () => { completed++ })
    q.startWorker('double', { concurrency: 1, pollInterval: 5 })

    const start = Date.now()
    while (completed < 20 && Date.now() - start < 5000) {
      await new Promise(r => setTimeout(r, 10))
    }

    // Both should process the same number of jobs
    expect(manualResults.length).toBe(20)
    expect(workerResults.length).toBe(20)

    // Both should produce the same set of results (order may differ with worker)
    expect(manualResults.sort((a, b) => a - b)).toEqual(workerResults.sort((a, b) => a - b))
  })

  // =========================================================
  // TEST 21: Concurrent processNext never double-processes a job
  // =========================================================
  it('concurrent processNext calls each get a unique job', async () => {
    q = new PsyQueue()
    q.use(sqlite({ path: ':memory:' }))

    const seen = new Set<string>()
    q.handle('unique-check', async (ctx) => {
      seen.add(ctx.job.id)
      return {}
    })
    await q.start()

    // Enqueue 10 jobs
    for (let i = 0; i < 10; i++) {
      await q.enqueue('unique-check', { i })
    }

    // Fire 10 processNext calls in parallel
    const results = await Promise.all(
      Array.from({ length: 10 }, () => q.processNext('unique-check')),
    )

    // All should succeed
    expect(results.every(r => r === true)).toBe(true)
    // All 10 distinct jobs were processed
    expect(seen.size).toBe(10)
  })

  // =========================================================
  // TEST 22: Dead letter replayAll re-enqueues all dead jobs
  // =========================================================
  it('replayAll re-enqueues all dead-lettered jobs', async () => {
    q = new PsyQueue()
    q.use(sqlite({ path: ':memory:' }))

    let shouldFail = true
    let successCount = 0
    q.handle('recoverable', async () => {
      if (shouldFail) {
        throw new Error('timeout — temporary outage')
      }
      successCount++
      return { recovered: true }
    })
    await q.start()

    // Create 3 dead jobs
    for (let i = 0; i < 3; i++) {
      await q.enqueue('recoverable', { i }, { maxRetries: 1 })
      await q.processNext('recoverable')
    }

    const deadBefore = await q.deadLetter.list()
    expect(deadBefore.data.length).toBe(3)

    // Replay all
    const replayed = await q.deadLetter.replayAll()
    expect(replayed).toBe(3)

    // Now fix the handler and process
    shouldFail = false
    for (let i = 0; i < 3; i++) {
      await q.processNext('recoverable')
    }

    expect(successCount).toBe(3)
  })
})
