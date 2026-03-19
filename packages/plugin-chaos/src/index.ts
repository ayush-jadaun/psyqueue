import type { PsyPlugin, Kernel, Middleware } from '@psyqueue/core'
import {
  slowProcess,
  workerCrash,
  duplicateDelivery,
} from './scenarios.js'
import type {
  SlowProcessConfig,
  WorkerCrashConfig,
  DuplicateDeliveryConfig,
} from './scenarios.js'

export {
  slowProcess,
  workerCrash,
  duplicateDelivery,
} from './scenarios.js'

export type {
  ChaosScenarioConfig,
  SlowProcessConfig,
  WorkerCrashConfig,
  DuplicateDeliveryConfig,
} from './scenarios.js'

export interface ChaosScenarioEntry {
  type: 'slowProcess' | 'workerCrash' | 'duplicateDelivery'
  config: SlowProcessConfig | WorkerCrashConfig | DuplicateDeliveryConfig
}

export interface ChaosModeOpts {
  enabled: boolean
  scenarios: ChaosScenarioEntry[]
}

export function chaosMode(opts: ChaosModeOpts): PsyPlugin {
  return {
    name: 'chaos',
    version: '0.1.0',
    provides: 'chaos',

    init(k: Kernel): void {
      if (!opts.enabled) return

      for (const scenario of opts.scenarios) {
        let middleware: Middleware

        switch (scenario.type) {
          case 'slowProcess':
            middleware = slowProcess(scenario.config as SlowProcessConfig)
            break
          case 'workerCrash':
            middleware = workerCrash(scenario.config as WorkerCrashConfig)
            break
          case 'duplicateDelivery':
            middleware = duplicateDelivery(scenario.config as DuplicateDeliveryConfig)
            break
          default:
            throw new Error(`Unknown chaos scenario: ${String(scenario.type)}`)
        }

        k.pipeline('process', middleware, { phase: 'guard' })
      }

      k.events.emit('chaos:enabled', {
        scenarios: opts.scenarios.map((s) => s.type),
      }, 'chaos')
    },
  }
}
