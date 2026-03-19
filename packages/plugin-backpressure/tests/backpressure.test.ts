import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { SignalMonitor } from '../src/signals.js'
import { resolveActions } from '../src/actions.js'
import { backpressure } from '../src/index.js'
import { PsyQueue } from 'psyqueue'
import { sqlite } from '../../backend-sqlite/src/index.js'

// ============================================================================
// Unit tests: SignalMonitor
// ============================================================================

describe('SignalMonitor', () => {
  it('starts HEALTHY', () => {
    const m = new SignalMonitor({ queueDepth: { pressure: 10, critical: 50 } })
    expect(m.currentState).toBe('HEALTHY')
  })

  it('transitions HEALTHY → PRESSURE on threshold cross', () => {
    const m = new SignalMonitor({ queueDepth: { pressure: 10, critical: 50 } })
    const state = m.update({ queueDepth: 10 })
    expect(state).toBe('PRESSURE')
    expect(m.currentState).toBe('PRESSURE')
  })

  it('transitions PRESSURE → CRITICAL when critical threshold crossed', () => {
    const m = new SignalMonitor({ queueDepth: { pressure: 10, critical: 50 } })
    m.update({ queueDepth: 10 })
    const state = m.update({ queueDepth: 50 })
    expect(state).toBe('CRITICAL')
    expect(m.currentState).toBe('CRITICAL')
  })

  it('transitions back to HEALTHY when below thresholds', () => {
    const m = new SignalMonitor({ queueDepth: { pressure: 10, critical: 50 } })
    m.update({ queueDepth: 50 })
    expect(m.currentState).toBe('CRITICAL')
    const state = m.update({ queueDepth: 0 })
    expect(state).toBe('HEALTHY')
  })

  it('errorRate signal triggers PRESSURE', () => {
    const m = new SignalMonitor({ errorRate: { pressure: 0.1, critical: 0.5 } })
    const state = m.update({ errorRate: 0.15 })
    expect(state).toBe('PRESSURE')
  })

  it('errorRate signal triggers CRITICAL', () => {
    const m = new SignalMonitor({ errorRate: { pressure: 0.1, critical: 0.5 } })
    const state = m.update({ errorRate: 0.6 })
    expect(state).toBe('CRITICAL')
  })

  it('CRITICAL wins over PRESSURE when both signals fire at different levels', () => {
    const m = new SignalMonitor({
      queueDepth: { pressure: 10, critical: 50 },
      errorRate: { pressure: 0.1, critical: 0.5 },
    })
    // queueDepth at pressure level, errorRate at critical level
    const state = m.update({ queueDepth: 15, errorRate: 0.6 })
    expect(state).toBe('CRITICAL')
  })

  it('stays HEALTHY when metrics below thresholds', () => {
    const m = new SignalMonitor({ queueDepth: { pressure: 10, critical: 50 } })
    const state = m.update({ queueDepth: 5 })
    expect(state).toBe('HEALTHY')
  })
})

// ============================================================================
// Unit tests: resolveActions
// ============================================================================

describe('resolveActions', () => {
  it('executes built-in throttle action (sets concurrency to 1)', async () => {
    const fn = resolveActions(['throttle'])
    let c = 10
    await fn({ setConcurrency: async (n) => { c = n } })
    expect(c).toBe(1)
  })

  it('executes built-in pause action (sets concurrency to 0)', async () => {
    const fn = resolveActions(['pause'])
    let c = 10
    await fn({ setConcurrency: async (n) => { c = n } })
    expect(c).toBe(0)
  })

  it('throws when both action names and callback provided', () => {
    expect(() => resolveActions(['throttle'], async () => {})).toThrow(
      'cannot specify both action names and a callback',
    )
  })

  it('throws on unknown action name', () => {
    expect(() => resolveActions(['unknown-action'])).toThrow('unknown action')
  })

  it('uses callback when no names provided', async () => {
    const called: boolean[] = []
    const fn = resolveActions([], async () => { called.push(true) })
    await fn({ setConcurrency: async () => {} })
    expect(called).toEqual([true])
  })
})

// ============================================================================
// Integration tests: backpressure plugin with PsyQueue
// ============================================================================

describe('Backpressure Plugin Integration', () => {
  let q: PsyQueue

  beforeEach(() => {
    q = new PsyQueue()
  })

  afterEach(async () => {
    await q.stop()
  })

  it('emits backpressure:pressure event during PRESSURE state on enqueue', async () => {
    const events: string[] = []

    const plugin = backpressure({
      signals: { queueDepth: { pressure: 5, critical: 20 } },
      actions: { pressure: ['throttle'] },
    }) as ReturnType<typeof backpressure> & {
      updateMetrics(m: { queueDepth?: number; errorRate?: number }): Promise<void>
      getState(): string
    }

    q.use(sqlite({ path: ':memory:' }))
    q.use(plugin)
    q.handle('job', async () => ({}))
    await q.start()

    q.events.on('backpressure:pressure', () => events.push('pressure'))

    // Drive the monitor into PRESSURE
    await plugin.updateMetrics({ queueDepth: 10 })
    expect(plugin.getState()).toBe('PRESSURE')
    expect(events).toContain('pressure')

    // Enqueue a job — guard should fire the pressure event again
    const id = await q.enqueue('job', {})
    expect(id).toBeTruthy()
  })

  it('emits backpressure:critical event during CRITICAL state on enqueue', async () => {
    const events: string[] = []

    const plugin = backpressure({
      signals: { queueDepth: { pressure: 5, critical: 20 } },
      actions: { critical: ['pause'] },
    }) as ReturnType<typeof backpressure> & {
      updateMetrics(m: { queueDepth?: number; errorRate?: number }): Promise<void>
      getState(): string
    }

    q.use(sqlite({ path: ':memory:' }))
    q.use(plugin)
    q.handle('job', async () => ({}))
    await q.start()

    q.events.on('backpressure:critical', () => events.push('critical'))

    await plugin.updateMetrics({ queueDepth: 25 })
    expect(plugin.getState()).toBe('CRITICAL')
    expect(events).toContain('critical')
  })

  it('emits backpressure:healthy event on recovery', async () => {
    const events: string[] = []

    const plugin = backpressure({
      signals: { queueDepth: { pressure: 5, critical: 20 } },
    }) as ReturnType<typeof backpressure> & {
      updateMetrics(m: { queueDepth?: number; errorRate?: number }): Promise<void>
    }

    q.use(sqlite({ path: ':memory:' }))
    q.use(plugin)
    q.handle('job', async () => ({}))
    await q.start()

    q.events.on('backpressure:healthy', () => events.push('healthy'))

    await plugin.updateMetrics({ queueDepth: 25 }) // CRITICAL
    await plugin.updateMetrics({ queueDepth: 0 })  // back to HEALTHY

    expect(events).toContain('healthy')
  })

  it('onPressure callback is called instead of actions', async () => {
    const called: string[] = []

    const plugin = backpressure({
      signals: { queueDepth: { pressure: 5, critical: 20 } },
      onPressure: async () => { called.push('pressure-cb') },
    }) as ReturnType<typeof backpressure> & {
      updateMetrics(m: { queueDepth?: number; errorRate?: number }): Promise<void>
    }

    q.use(sqlite({ path: ':memory:' }))
    q.use(plugin)
    q.handle('job', async () => ({}))
    await q.start()

    await plugin.updateMetrics({ queueDepth: 10 })
    expect(called).toContain('pressure-cb')
  })

  it('onCritical callback is called on critical state', async () => {
    const called: string[] = []

    const plugin = backpressure({
      signals: { queueDepth: { pressure: 5, critical: 20 } },
      onCritical: async () => { called.push('critical-cb') },
    }) as ReturnType<typeof backpressure> & {
      updateMetrics(m: { queueDepth?: number; errorRate?: number }): Promise<void>
    }

    q.use(sqlite({ path: ':memory:' }))
    q.use(plugin)
    q.handle('job', async () => ({}))
    await q.start()

    await plugin.updateMetrics({ queueDepth: 25 })
    expect(called).toContain('critical-cb')
  })

  it('throws at construction when both actions and callback specified for same level', () => {
    expect(() => backpressure({
      signals: { queueDepth: { pressure: 5, critical: 20 } },
      actions: { pressure: ['throttle'] },
      onPressure: async () => {},
    })).toThrow('cannot specify both action names and a callback')
  })

  it('setConcurrency is called by throttle action during pressure', async () => {
    const plugin = backpressure({
      signals: { queueDepth: { pressure: 5, critical: 20 } },
      actions: { pressure: ['throttle'] },
    }) as ReturnType<typeof backpressure> & {
      updateMetrics(m: { queueDepth?: number; errorRate?: number }): Promise<void>
      getConcurrency(): number
    }

    q.use(sqlite({ path: ':memory:' }))
    q.use(plugin)
    q.handle('job', async () => ({}))
    await q.start()

    await plugin.updateMetrics({ queueDepth: 10 })
    expect(plugin.getConcurrency()).toBe(1)
  })

  it('recovery: stepUp restores concurrency after returning to HEALTHY', async () => {
    const plugin = backpressure({
      signals: { queueDepth: { pressure: 5, critical: 20 } },
      actions: { pressure: ['throttle'] },
      recovery: { cooldown: 0, stepUp: 5 },
    }) as ReturnType<typeof backpressure> & {
      updateMetrics(m: { queueDepth?: number; errorRate?: number }): Promise<void>
      getConcurrency(): number
    }

    q.use(sqlite({ path: ':memory:' }))
    q.use(plugin)
    q.handle('job', async () => ({}))
    await q.start()

    await plugin.updateMetrics({ queueDepth: 10 }) // PRESSURE → concurrency = 1
    expect(plugin.getConcurrency()).toBe(1)

    await plugin.updateMetrics({ queueDepth: 0 }) // HEALTHY → stepUp by 5 → 6
    expect(plugin.getConcurrency()).toBe(6)
  })
})
