import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { linearCurve, exponentialCurve, stepCurve } from '../src/curves.js'
import { deadlinePriority } from '../src/index.js'
import { PsyQueue } from '@psyqueue/core'
import { sqlite } from '../../backend-sqlite/src/index.js'

// ============================================================================
// Unit tests: curve functions
// ============================================================================

describe('linearCurve', () => {
  it('returns basePriority when timeRemainingPct >= boostThreshold', () => {
    // At 50% or above, no boost
    expect(linearCurve(0.5, 10, 95, 0.5)).toBe(10)
    expect(linearCurve(0.8, 10, 95, 0.5)).toBe(10)
    expect(linearCurve(1.0, 10, 95, 0.5)).toBe(10)
  })

  it('scales linearly below threshold toward maxBoost', () => {
    // At 0% remaining: should return maxBoost (95)
    expect(linearCurve(0, 10, 95, 0.5)).toBe(95)
  })

  it('returns intermediate value at midpoint below threshold', () => {
    // At 25% remaining with threshold 0.5: progress = 1 - (0.25/0.5) = 0.5
    // priority = 10 + (95 - 10) * 0.5 = 10 + 42.5 = 52.5 → rounded 53
    const result = linearCurve(0.25, 10, 95, 0.5)
    expect(result).toBeGreaterThan(10)
    expect(result).toBeLessThan(95)
  })

  it('never exceeds maxBoost', () => {
    for (let pct = 0; pct <= 0.5; pct += 0.05) {
      expect(linearCurve(pct, 10, 95, 0.5)).toBeLessThanOrEqual(95)
    }
  })
})

describe('exponentialCurve', () => {
  it('returns basePriority above threshold', () => {
    expect(exponentialCurve(0.5, 10, 95, 0.5)).toBe(10)
    expect(exponentialCurve(0.9, 10, 95, 0.5)).toBe(10)
  })

  it('accelerates near deadline (value at 10% > value at 40%)', () => {
    const nearDeadline = exponentialCurve(0.1, 10, 95, 0.5)
    const farFromDeadline = exponentialCurve(0.4, 10, 95, 0.5)
    expect(nearDeadline).toBeGreaterThan(farFromDeadline)
  })

  it('reaches maxBoost at 0% time remaining', () => {
    expect(exponentialCurve(0, 10, 95, 0.5)).toBe(95)
  })

  it('is lower than linear at intermediate values but same at extremes', () => {
    // Exponential curve uses progress^2, so at intermediate values below threshold
    // it boosts less than linear (slower start, faster near deadline).
    // At pct=0.25 (midway below threshold 0.5): linearProgress=0.5 → exp=0.25, lin=0.5
    // exp priority = 10 + 85*0.25 = 31.25 → 31
    // lin priority = 10 + 85*0.5 = 52.5 → 53
    const expMid = exponentialCurve(0.25, 10, 95, 0.5)
    const linMid = linearCurve(0.25, 10, 95, 0.5)
    expect(expMid).toBeLessThan(linMid)

    // At pct=0 (deadline), both should return maxBoost
    expect(exponentialCurve(0, 10, 95, 0.5)).toBe(95)
    expect(linearCurve(0, 10, 95, 0.5)).toBe(95)
  })
})

describe('stepCurve', () => {
  it('returns basePriority above threshold', () => {
    expect(stepCurve(0.5, 10, 95, 0.5)).toBe(10)
    expect(stepCurve(0.6, 10, 95, 0.5)).toBe(10)
  })

  it('jumps at specific intervals below threshold', () => {
    // Below threshold is 0..0.5
    // First third of below-threshold zone: 0.33..0.5 → 1/3 boost
    // Middle third: 0.17..0.33 → 2/3 boost
    // Last third: 0..0.17 → maxBoost

    // In first-third-below: pct = 0.4 (between 0.33 and 0.5)
    const firstStep = stepCurve(0.4, 10, 95, 0.5)
    // In middle third: pct = 0.2
    const middleStep = stepCurve(0.2, 10, 95, 0.5)
    // In last third: pct = 0.05 → maxBoost
    const lastStep = stepCurve(0.05, 10, 95, 0.5)

    expect(lastStep).toBe(95)
    expect(middleStep).toBeGreaterThan(firstStep)
    expect(lastStep).toBeGreaterThan(middleStep)
  })

  it('does not exceed maxBoost', () => {
    expect(stepCurve(0, 10, 95, 0.5)).toBe(95)
    expect(stepCurve(0.05, 10, 95, 0.5)).toBe(95)
  })
})

// ============================================================================
// Unit tests: deadline-priority plugin
// ============================================================================

describe('deadlinePriority plugin — computePriority', () => {
  it('returns basePriority when no deadline', () => {
    const plugin = deadlinePriority({ urgencyCurve: 'linear' }) as ReturnType<typeof deadlinePriority> & {
      computePriority(job: { createdAt: Date; deadline?: Date; priority: number }): number
    }
    const result = plugin.computePriority({
      createdAt: new Date(),
      priority: 20,
    })
    expect(result).toBe(20)
  })

  it('custom function works', () => {
    const plugin = deadlinePriority({
      urgencyCurve: (pct, base) => base + (1 - pct) * 50,
    }) as ReturnType<typeof deadlinePriority> & {
      computePriority(job: { createdAt: Date; deadline?: Date; priority: number }): number
    }

    const createdAt = new Date(Date.now() - 5000)
    const deadline = new Date(Date.now() + 5000)
    const result = plugin.computePriority({ createdAt, deadline, priority: 10 })
    // timeRemainingPct ≈ 0.5 → priority ≈ 10 + 0.5 * 50 = 35
    expect(result).toBeGreaterThan(10)
  })

  it('maxBoost is respected — priority never exceeds maxBoost', () => {
    const plugin = deadlinePriority({
      urgencyCurve: 'linear',
      maxBoost: 50,
      boostThreshold: 0.9,
    }) as ReturnType<typeof deadlinePriority> & {
      computePriority(job: { createdAt: Date; deadline?: Date; priority: number }): number
    }

    const now = Date.now()
    // Job created 90% through its lifetime, 10% left — below threshold
    const createdAt = new Date(now - 9000)
    const deadline = new Date(now + 1000)
    const result = plugin.computePriority({ createdAt, deadline, priority: 5 })
    expect(result).toBeLessThanOrEqual(50)
  })

  it('no boost above threshold — returns basePriority', () => {
    const plugin = deadlinePriority({
      urgencyCurve: 'linear',
      boostThreshold: 0.3,
    }) as ReturnType<typeof deadlinePriority> & {
      computePriority(job: { createdAt: Date; deadline?: Date; priority: number }): number
    }

    const now = Date.now()
    // 70% of time remaining → above threshold (0.3) → no boost
    const createdAt = new Date(now - 3000)
    const deadline = new Date(now + 7000)
    const result = plugin.computePriority({ createdAt, deadline, priority: 15 })
    expect(result).toBe(15)
  })
})

// ============================================================================
// Integration tests: deadline-priority plugin with PsyQueue
// ============================================================================

describe('Deadline Priority Integration', () => {
  let q: PsyQueue

  beforeEach(() => {
    q = new PsyQueue()
    vi.useFakeTimers()
  })

  afterEach(async () => {
    vi.useRealTimers()
    await q.stop()
  })

  it('tracks jobs with deadlines after enqueue', async () => {
    const plugin = deadlinePriority({
      urgencyCurve: 'linear',
      interval: 1000,
    }) as ReturnType<typeof deadlinePriority> & {
      getTrackedCount(): number
    }

    q.use(sqlite({ path: ':memory:' }))
    q.use(plugin)
    q.handle('email', async () => ({}))
    await q.start()

    const deadline = new Date(Date.now() + 60000)
    await q.enqueue('email', {}, { deadline })

    expect(plugin.getTrackedCount()).toBe(1)
  })

  it('does not track jobs without deadlines', async () => {
    const plugin = deadlinePriority({
      urgencyCurve: 'linear',
      interval: 1000,
    }) as ReturnType<typeof deadlinePriority> & {
      getTrackedCount(): number
    }

    q.use(sqlite({ path: ':memory:' }))
    q.use(plugin)
    q.handle('email', async () => ({}))
    await q.start()

    await q.enqueue('email', {})
    expect(plugin.getTrackedCount()).toBe(0)
  })

  it('emits job:deadline-missed when deadline passes during interval', async () => {
    vi.useRealTimers()

    const events: unknown[] = []
    const plugin = deadlinePriority({
      urgencyCurve: 'linear',
      interval: 50,
      onDeadlineMiss: 'process-anyway',
    })

    q.use(sqlite({ path: ':memory:' }))
    q.use(plugin)
    q.handle('email', async () => ({}))
    q.events.on('job:deadline-missed', (e) => events.push(e.data))
    await q.start()

    // Enqueue a job with a deadline in the past
    const deadline = new Date(Date.now() - 100)
    await q.enqueue('email', {}, { deadline })

    // Wait for at least one interval tick
    await new Promise(r => setTimeout(r, 150))

    expect(events.length).toBeGreaterThan(0)
  })

  it('dead-letters job when onDeadlineMiss is fail', async () => {
    vi.useRealTimers()

    const events: string[] = []
    const plugin = deadlinePriority({
      urgencyCurve: 'linear',
      interval: 5000,
      onDeadlineMiss: 'fail',
    })

    q.use(sqlite({ path: ':memory:' }))
    q.use(plugin)
    q.handle('email', async () => ({}))
    q.events.on('job:dead', () => events.push('dead'))
    q.events.on('job:deadline-missed', () => events.push('missed'))
    await q.start()

    const deadline = new Date(Date.now() - 1000)
    await q.enqueue('email', {}, { deadline })

    // processNext should dead-letter due to deadline miss
    await q.processNext('email')

    expect(events).toContain('missed')
    expect(events).toContain('dead')
  })
})
