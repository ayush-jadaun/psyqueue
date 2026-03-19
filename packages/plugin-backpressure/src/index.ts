import type { PsyPlugin, Kernel } from '@psyqueue/core'
import { SignalMonitor } from './signals.js'
import { resolveActions } from './actions.js'
import type { PressureState } from './signals.js'

export type { PressureState } from './signals.js'
export { SignalMonitor } from './signals.js'
export { resolveActions } from './actions.js'

export interface BackpressureOpts {
  signals: {
    queueDepth?: { pressure: number; critical: number }
    errorRate?: { pressure: number; critical: number }
  }
  actions?: { pressure?: string[]; critical?: string[] }
  onPressure?: (ctx: { setConcurrency: (n: number) => Promise<void> }) => Promise<void>
  onCritical?: (ctx: { setConcurrency: (n: number) => Promise<void> }) => Promise<void>
  recovery?: { cooldown?: number; stepUp?: number }
}

export function backpressure(opts: BackpressureOpts): PsyPlugin {
  // Validate mutual exclusivity at construction time
  const pressureAction = resolveActions(
    opts.actions?.pressure ?? [],
    opts.onPressure,
  )
  const criticalAction = resolveActions(
    opts.actions?.critical ?? [],
    opts.onCritical,
  )

  const monitor = new SignalMonitor(opts.signals)
  let currentState: PressureState = 'HEALTHY'
  let concurrency = 10
  let cooldownUntil = 0
  let kernelRef: Kernel | null = null

  const setConcurrency = async (n: number): Promise<void> => {
    concurrency = n
  }

  const actionCtx = { setConcurrency }

  const applyActions = async (state: PressureState): Promise<void> => {
    if (state === 'CRITICAL') {
      await criticalAction(actionCtx)
    } else if (state === 'PRESSURE') {
      await pressureAction(actionCtx)
    }
  }

  const plugin: PsyPlugin = {
    name: 'backpressure',
    version: '0.1.0',
    provides: 'backpressure',

    init(k: Kernel): void {
      kernelRef = k

      // Guard on enqueue: check state and potentially block/emit events
      k.pipeline(
        'enqueue',
        async (ctx, next) => {
          if (currentState === 'CRITICAL') {
            k.events.emit('backpressure:critical', { state: currentState, jobId: ctx.job.id })
            // Don't call next — short circuit to apply pressure
            // We still let the job through but emit the event
            // (throwing would break the API; events notify consumers)
          } else if (currentState === 'PRESSURE') {
            k.events.emit('backpressure:pressure', { state: currentState, jobId: ctx.job.id })
          }
          await next()
        },
        { phase: 'guard' },
      )
    },

    async start(): Promise<void> {
      // nothing to start
    },

    async stop(): Promise<void> {
      // nothing to stop
    },
  }

  // Expose updateMetrics so tests/users can drive the monitor
  const extended = plugin as PsyPlugin & {
    updateMetrics(metrics: { queueDepth?: number; errorRate?: number }): Promise<void>
    getState(): PressureState
    getConcurrency(): number
  }

  extended.getState = () => currentState
  extended.getConcurrency = () => concurrency

  extended.updateMetrics = async (metrics: { queueDepth?: number; errorRate?: number }): Promise<void> => {
    const now = Date.now()
    const prevState = currentState
    const newState = monitor.update(metrics)
    currentState = newState

    const k = kernelRef
    if (!k) return

    if (newState !== prevState) {
      if (newState === 'HEALTHY') {
        // Recovery: respect cooldown
        if (now < cooldownUntil) return
        cooldownUntil = now + (opts.recovery?.cooldown ?? 0)

        const stepUp = opts.recovery?.stepUp ?? 10
        concurrency = Math.min(concurrency + stepUp, 10)
        k.events.emit('backpressure:healthy', { state: newState })
      } else if (newState === 'CRITICAL') {
        cooldownUntil = now + (opts.recovery?.cooldown ?? 0)
        await applyActions('CRITICAL')
        k.events.emit('backpressure:critical', { state: newState })
      } else if (newState === 'PRESSURE') {
        cooldownUntil = now + (opts.recovery?.cooldown ?? 0)
        await applyActions('PRESSURE')
        k.events.emit('backpressure:pressure', { state: newState })
      }
    }
  }

  return extended
}
