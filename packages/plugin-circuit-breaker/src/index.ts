import type { PsyPlugin, Kernel } from 'psyqueue'
import { Breaker } from './breaker.js'
import type { BreakerConfig } from './breaker.js'

export type { BreakerConfig, BreakerState } from './breaker.js'
export { Breaker } from './breaker.js'

export interface CircuitBreakerOpts {
  breakers: Record<string, BreakerConfig>
}

export interface CircuitBreakerPlugin extends PsyPlugin {
  getBreaker(name: string): Breaker | undefined
}

export function circuitBreaker(opts: CircuitBreakerOpts): CircuitBreakerPlugin {
  const instances = new Map<string, Breaker>()

  // Create breaker instances up front
  for (const [name, config] of Object.entries(opts.breakers)) {
    instances.set(name, new Breaker(config))
  }

  const plugin: CircuitBreakerPlugin = {
    name: 'circuit-breaker',
    version: '0.1.0',
    provides: 'circuit-breaker',

    init(k: Kernel): void {
      // Guard phase: override ctx.breaker before the handler runs.
      // The guard phase runs before the handler, so we patch ctx.breaker here
      // and the patched version is used when the handler calls ctx.breaker().
      k.pipeline(
        'process',
        async (ctx, next) => {
          const originalBreaker = ctx.breaker.bind(ctx)

          ctx.breaker = async (breakerName: string, fn: () => Promise<unknown>): Promise<unknown> => {
            const breaker = instances.get(breakerName)

            if (!breaker) {
              // No breaker configured for this name — pass through to default
              return originalBreaker(breakerName, fn)
            }

            // Snapshot raw state BEFORE calling currentState (which may auto-transition)
            const rawBefore = breaker.rawState

            if (!breaker.canExecute()) {
              // Circuit is OPEN — apply onOpen action without calling fn().
              // We do NOT throw here: instead we signal via ctx state so that
              // processNext can handle the requeue/fail on the success path.
              const config = opts.breakers[breakerName]!
              const action = config.onOpen ?? 'requeue'

              if (action === 'requeue') {
                ctx.requeue()
              } else {
                ctx.deadLetter(`Circuit breaker "${breakerName}" is OPEN`)
              }

              return undefined
            }

            // Detect OPEN → HALF_OPEN transition: if rawState was OPEN before calling
            // canExecute(), and now the circuit is HALF_OPEN (canExecute returned true),
            // the transition just occurred.
            if (rawBefore === 'OPEN' && breaker.currentState === 'HALF_OPEN') {
              k.events.emit('circuit:half-open', { name: breakerName })
            }

            try {
              const result = await fn()
              const stateBeforeSuccess = breaker.currentState
              breaker.recordSuccess()
              const stateAfterSuccess = breaker.currentState

              // Emit circuit:close if we transitioned HALF_OPEN → CLOSED
              if (stateBeforeSuccess === 'HALF_OPEN' && stateAfterSuccess === 'CLOSED') {
                k.events.emit('circuit:close', { name: breakerName })
              }

              return result
            } catch (err) {
              const stateBeforeFailure = breaker.currentState
              breaker.recordFailure()
              const stateAfterFailure = breaker.currentState

              // Emit circuit:open if we just tripped the breaker
              if (stateBeforeFailure !== 'OPEN' && stateAfterFailure === 'OPEN') {
                k.events.emit('circuit:open', { name: breakerName })
              }

              throw err
            }
          }

          await next()
        },
        { phase: 'guard' },
      )
    },

    getBreaker(name: string): Breaker | undefined {
      return instances.get(name)
    },
  }

  return plugin
}
