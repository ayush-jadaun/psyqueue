import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { chaosMode } from '../src/index.js'
import { PsyQueue } from 'psyqueue'
import { sqlite } from '../../backend-sqlite/src/index.js'

describe('Chaos Plugin', () => {
  let q: PsyQueue

  beforeEach(() => {
    q = new PsyQueue()
  })

  afterEach(async () => {
    try { await q.stop() } catch (_e) { /* ignore */ }
  })

  it('slowProcess adds delay when probability is 1.0', async () => {
    q.use(sqlite({ path: ':memory:' }))
    q.use(chaosMode({
      enabled: true,
      scenarios: [{
        type: 'slowProcess',
        config: { probability: 1.0, minDelay: 50, maxDelay: 100 },
      }],
    }))

    let handlerCalled = false
    q.handle('task', async () => {
      handlerCalled = true
      return 'done'
    })

    await q.start()
    await q.enqueue('task', {}, { queue: 'default' })

    const startTime = Date.now()
    await q.processNext('default')
    const elapsed = Date.now() - startTime

    expect(handlerCalled).toBe(true)
    // Should have at least 50ms delay
    expect(elapsed).toBeGreaterThanOrEqual(40)
  })

  it('workerCrash throws error when probability is 1.0', async () => {
    q.use(sqlite({ path: ':memory:' }))
    q.use(chaosMode({
      enabled: true,
      scenarios: [{
        type: 'workerCrash',
        config: { probability: 1.0, message: 'CHAOS CRASH' },
      }],
    }))

    const events: string[] = []
    q.handle('task', async () => 'done')
    q.events.on('job:failed', () => events.push('failed'))

    await q.start()
    await q.enqueue('task', {}, { queue: 'default', maxRetries: 0 })
    await q.processNext('default')

    expect(events).toContain('failed')
  })

  it('workerCrash uses custom error message', async () => {
    q.use(sqlite({ path: ':memory:' }))
    q.use(chaosMode({
      enabled: true,
      scenarios: [{
        type: 'workerCrash',
        config: { probability: 1.0, message: 'Simulated OOM' },
      }],
    }))

    const errors: string[] = []
    q.handle('task', async () => 'done')
    q.events.on('job:failed', (e) => {
      const data = e.data as { error: string }
      errors.push(data.error)
    })

    await q.start()
    await q.enqueue('task', {}, { queue: 'default', maxRetries: 0 })
    await q.processNext('default')

    expect(errors).toContain('Simulated OOM')
  })

  it('duplicateDelivery runs handler multiple times', async () => {
    q.use(sqlite({ path: ':memory:' }))
    q.use(chaosMode({
      enabled: true,
      scenarios: [{
        type: 'duplicateDelivery',
        config: { probability: 1.0, extraRuns: 2 },
      }],
    }))

    let callCount = 0
    q.handle('task', async () => {
      callCount++
      return 'done'
    })

    // Register an observe middleware to count how many times `next` is invoked
    // by the duplicateDelivery guard middleware
    let observeCount = 0
    q.pipeline('process', async (_ctx, next) => {
      observeCount++
      await next()
    }, { phase: 'observe' })

    await q.start()
    await q.enqueue('task', {}, { queue: 'default' })
    await q.processNext('default')

    // The observe middleware should have been called 3 times
    // (1 original + 2 extra from duplicateDelivery)
    expect(observeCount).toBeGreaterThanOrEqual(3)
  })

  it('disabled mode does not inject any scenarios', async () => {
    q.use(sqlite({ path: ':memory:' }))
    q.use(chaosMode({
      enabled: false,
      scenarios: [{
        type: 'workerCrash',
        config: { probability: 1.0 },
      }],
    }))

    let handlerCalled = false
    q.handle('task', async () => {
      handlerCalled = true
      return 'done'
    })

    await q.start()
    await q.enqueue('task', {}, { queue: 'default' })
    await q.processNext('default')

    // Handler should complete without crash since chaos is disabled
    expect(handlerCalled).toBe(true)
  })

  it('multiple scenarios can be combined', async () => {
    q.use(sqlite({ path: ':memory:' }))
    q.use(chaosMode({
      enabled: true,
      scenarios: [
        {
          type: 'slowProcess',
          config: { probability: 1.0, minDelay: 10, maxDelay: 20 },
        },
        {
          type: 'workerCrash',
          config: { probability: 1.0, message: 'combined crash' },
        },
      ],
    }))

    const events: string[] = []
    q.handle('task', async () => 'done')
    q.events.on('job:failed', () => events.push('failed'))

    await q.start()
    await q.enqueue('task', {}, { queue: 'default', maxRetries: 0 })

    const startTime = Date.now()
    await q.processNext('default')
    const elapsed = Date.now() - startTime

    // slowProcess runs first (guard phase, registered first), then workerCrash throws
    expect(events).toContain('failed')
    // Should have at least the min delay from slowProcess
    expect(elapsed).toBeGreaterThanOrEqual(5)
  })
})
