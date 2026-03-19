import type { EventBusInterface } from '@psyqueue/core'
import type { WorkflowInstance } from '@psyqueue/plugin-workflows'
import type { WorkflowDefinition } from '@psyqueue/plugin-workflows'

/**
 * Compensator runs compensation handlers in reverse completion order
 * when a workflow fails. Only completed steps with a compensate handler
 * are compensated; the failed step itself is skipped (it never succeeded).
 */
export class Compensator {
  /**
   * Run compensation for all completed steps in reverse order.
   *
   * @returns 'COMPENSATED' if all compensation handlers succeed,
   *          'COMPENSATION_FAILED' if any throws.
   */
  async runCompensation(
    workflowInstance: WorkflowInstance,
    workflowDef: WorkflowDefinition,
    events: EventBusInterface,
  ): Promise<'COMPENSATED' | 'COMPENSATION_FAILED'> {
    // Collect completed steps in the order they completed.
    // WorkflowInstance.stepStates is a Record<stepName, StepState>.
    // We identify completed steps and sort by their insertion order
    // (which mirrors the definition order / completion order since steps
    // advance sequentially or in parallel DAG order).
    const completedStepNames = Object.entries(workflowInstance.stepStates)
      .filter(([, state]) => state.status === 'completed')
      .map(([name]) => name)

    // The definition's steps array is in registration order (topological).
    // We use this ordering as the canonical "completion order" to ensure
    // a stable, deterministic reverse sequence.
    const defOrderMap = new Map<string, number>()
    for (let i = 0; i < workflowDef.steps.length; i++) {
      defOrderMap.set(workflowDef.steps[i]!.name, i)
    }

    // Sort completed steps by definition order ascending, then reverse for compensation.
    const orderedCompleted = completedStepNames
      .slice()
      .sort((a, b) => (defOrderMap.get(a) ?? 0) - (defOrderMap.get(b) ?? 0))

    // Reverse: last completed → first completed
    orderedCompleted.reverse()

    // Build a results map from all completed steps (the context passed to compensate)
    const results: Record<string, unknown> = {}
    for (const [name, state] of Object.entries(workflowInstance.stepStates)) {
      if (state.status === 'completed' && state.result !== undefined) {
        results[name] = state.result
      }
    }

    // Run compensation handlers in reverse order
    for (const stepName of orderedCompleted) {
      const stepDef = workflowDef.steps.find(s => s.name === stepName)
      if (!stepDef?.compensate) {
        // No compensate handler — skip
        continue
      }

      try {
        // Build a minimal JobContext-compatible object for the compensate handler.
        // The compensate handler receives ctx.results with the original step results.
        const compensateCtx = buildCompensationContext(
          workflowInstance.id,
          stepName,
          results,
          events,
        )
        await stepDef.compensate(compensateCtx)
      } catch {
        return 'COMPENSATION_FAILED'
      }
    }

    return 'COMPENSATED'
  }
}

/**
 * Build a minimal JobContext for a compensation handler invocation.
 * Compensation handlers only need ctx.results (and optionally ctx.workflow).
 * We satisfy the full JobContext type with no-op stubs for unused fields.
 */
function buildCompensationContext(
  workflowId: string,
  stepName: string,
  results: Record<string, unknown>,
  _events: EventBusInterface,
): import('psyqueue').JobContext {
  const log: import('psyqueue').Logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }

  const job: import('psyqueue').Job = {
    id: `compensation-${workflowId}-${stepName}`,
    queue: workflowId,
    name: stepName,
    payload: null,
    priority: 0,
    maxRetries: 0,
    attempt: 1,
    backoff: 'fixed',
    timeout: 30_000,
    status: 'active',
    createdAt: new Date(),
    meta: {},
  }

  return {
    job,
    event: 'process',
    workflow: { workflowId, stepId: stepName, results },
    results,
    state: {},
    requeue: () => {},
    deadLetter: () => {},
    breaker: async (_name: string, fn: () => Promise<unknown>) => fn(),
    updateJob: async () => {},
    enqueue: async (_name: string, _payload: unknown) => '',
    log,
  }
}
