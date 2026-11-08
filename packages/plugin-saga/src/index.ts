import type { PsyPlugin, Kernel } from '@psyqueue/core'
import type { WorkflowEngine } from '@psyqueue/plugin-workflows'

/**
 * Saga compensation for workflows.
 *
 * When a workflow fails, and once no step of it is still running, the
 * compensate handlers of its completed steps run in reverse completion order.
 * Each compensation is a durable job with the step's retry settings, run one
 * at a time; if one fails for good, the remaining ones still run.
 *
 * Events:
 *   - workflow:compensating          — compensation starts ({ steps })
 *   - workflow:compensation-step-failed — one compensate handler failed for good
 *   - workflow:compensated           — every compensation succeeded
 *   - workflow:compensation-failed   — finished, some failed ({ failedSteps })
 */
export function saga(): PsyPlugin {
  let kernelRef: Kernel | null = null

  return {
    name: 'saga',
    version: '0.1.0',
    depends: ['workflows'],

    init(kernel: Kernel): void {
      kernelRef = kernel
    },

    async start(): Promise<void> {
      // In start(), so it works regardless of plugin registration order
      const api = kernelRef!.getExposed('workflows')
      if (!api) throw new Error('saga plugin requires the workflows plugin')
      ;(api['getEngine'] as () => WorkflowEngine)().compensationEnabled = true
    },
  }
}
