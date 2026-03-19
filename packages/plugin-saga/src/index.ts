import type { PsyPlugin, Kernel, PsyEvent } from 'psyqueue'
import type { WorkflowEngine } from '@psyqueue/plugin-workflows'
import { Compensator } from './compensator.js'

export { Compensator } from './compensator.js'

/**
 * Saga Compensation Plugin for PsyQueue.
 *
 * When a workflow fails (after all retries are exhausted on the failing step),
 * this plugin automatically runs compensation handlers on all completed steps
 * in reverse completion order (last completed → first completed).
 *
 * Compensation lifecycle events emitted:
 *   - workflow:compensating  — triggered before compensation begins
 *   - workflow:compensated   — all compensations succeeded
 *   - workflow:compensation-failed — a compensation handler threw
 */
export function saga(): PsyPlugin {
  const compensator = new Compensator()

  return {
    name: 'saga',
    version: '0.1.0',
    depends: ['workflows'],

    init(kernel: Kernel): void {
      kernel.events.on('workflow:failed', async (event: PsyEvent) => {
        const data = event.data as {
          workflowId: string
          definitionName: string
          failedStep: string
          error: string
        }

        const { workflowId, definitionName } = data

        // Resolve the workflows exposed API to get engine access
        const workflowsApi = kernel.getExposed('workflows')
        if (!workflowsApi) {
          // Workflows plugin not loaded — nothing to compensate
          return
        }

        const engine = (workflowsApi['getEngine'] as () => WorkflowEngine)()

        // Get workflow instance and definition
        const instance = engine.store.get(workflowId)
        if (!instance) return

        const workflowDef = engine.getDefinition(definitionName)
        if (!workflowDef) return

        // Emit compensating event
        kernel.events.emit('workflow:compensating', {
          workflowId,
          definitionName,
        })

        // Run the compensation
        const outcome = await compensator.runCompensation(
          instance,
          workflowDef,
          kernel.events,
        )

        // Update workflow status
        instance.status = outcome
        instance.updatedAt = new Date()

        // Emit outcome event
        if (outcome === 'COMPENSATED') {
          kernel.events.emit('workflow:compensated', {
            workflowId,
            definitionName,
          })
        } else {
          kernel.events.emit('workflow:compensation-failed', {
            workflowId,
            definitionName,
          })
        }
      })
    },
  }
}
