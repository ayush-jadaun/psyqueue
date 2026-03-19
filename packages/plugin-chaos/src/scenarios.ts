import type { Middleware } from '@psyqueue/core'

export interface ChaosScenarioConfig {
  probability: number
}

export interface SlowProcessConfig extends ChaosScenarioConfig {
  minDelay: number
  maxDelay: number
}

export interface WorkerCrashConfig extends ChaosScenarioConfig {
  message?: string
}

export interface DuplicateDeliveryConfig extends ChaosScenarioConfig {
  /** How many extra times to run the handler (default: 1) */
  extraRuns?: number
}

function shouldTrigger(probability: number): boolean {
  return Math.random() < probability
}

/**
 * Adds a random delay before processing to simulate slow workers.
 */
export function slowProcess(config: SlowProcessConfig): Middleware {
  return async (ctx, next) => {
    if (shouldTrigger(config.probability)) {
      const delay = config.minDelay + Math.random() * (config.maxDelay - config.minDelay)
      ctx.state['chaos_slowProcess'] = true
      ctx.state['chaos_delay'] = Math.round(delay)
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
    await next()
  }
}

/**
 * Throws an error to simulate a worker crash.
 */
export function workerCrash(config: WorkerCrashConfig): Middleware {
  return async (_ctx, next) => {
    if (shouldTrigger(config.probability)) {
      throw new Error(config.message || 'Chaos: simulated worker crash')
    }
    await next()
  }
}

/**
 * Runs the downstream middleware chain multiple times to simulate duplicate delivery.
 */
export function duplicateDelivery(config: DuplicateDeliveryConfig): Middleware {
  return async (ctx, next) => {
    await next()
    if (shouldTrigger(config.probability)) {
      const extraRuns = config.extraRuns ?? 1
      ctx.state['chaos_duplicateDelivery'] = true
      ctx.state['chaos_extraRuns'] = extraRuns
      for (let i = 0; i < extraRuns; i++) {
        await next()
      }
    }
  }
}
