import type { PsyPlugin, Kernel } from '@psyqueue/core'
import { WorkflowEngine } from './engine.js'
import type { WorkflowDefinition } from './builder.js'

export { workflow, WorkflowBuilder } from './builder.js'
export { WorkflowEngine } from './engine.js'
export { WorkflowStore, WORKFLOW_RECORD_QUEUE, WORKFLOW_RECORD_NAME } from './state.js'
export type { StepDefinition, WorkflowDefinition, StepOpts, StepRetryOpts } from './builder.js'
export type { WorkflowInstance, WorkflowStatus, StepStatus, StepState, CompensationState } from './state.js'

/**
 * Creates the workflow plugin.
 *
 * - Enqueueing a registered workflow name starts a workflow (returns its id).
 * - Step jobs record their completion and advance the DAG inside their own
 *   processing, before they are acked, so a crash re-runs the step instead of
 *   losing the advancement. State lives in the backend (multi-process safe).
 * - A step that is dead-lettered fails the workflow.
 * - Step handlers get earlier results via ctx.workflow.results / ctx.results.
 */
export function workflows(): PsyPlugin & { engine: WorkflowEngine } {
  const engine = new WorkflowEngine()

  const plugin: PsyPlugin & { engine: WorkflowEngine } = {
    name: 'workflows',
    version: '0.1.0',
    provides: 'workflows',
    depends: ['backend'],
    engine,

    init(kernel: Kernel): void {
      engine.init(kernel)

      // ── Enqueueing a workflow name starts the workflow ──────────────────
      kernel.pipeline(
        'enqueue',
        async (ctx, next) => {
          if (ctx.job.meta['workflow.id'] || !engine.hasDefinition(ctx.job.name)) return next()
          const workflowId = await engine.startWorkflow(ctx.job.name, ctx.job.payload)
          ctx.job.id = workflowId
          ctx.job.meta['workflow.instance'] = workflowId
          // No next(): there is no job for the workflow itself
        },
        { phase: 'transform' },
      )

      /** Which workflow step a job belongs to, if any. */
      const stepOf = (meta: Record<string, unknown>) => {
        const workflowId = meta['workflow.id'] as string | undefined
        if (!workflowId) return undefined
        const compensateStep = meta['workflow.compensate'] as string | undefined
        return {
          workflowId,
          step: compensateStep ?? (meta['workflow.step'] as string),
          compensation: compensateStep !== undefined,
        }
      }

      /** A step or compensation job failed for good. */
      const onFinalFailure = (job: { id: string; meta: Record<string, unknown> }, message: string) => {
        const s = stepOf(job.meta)!
        return s.compensation
          ? engine.onCompensationDone(s.workflowId, s.step, false)
          : engine.onStepFailed(s.workflowId, job.id, s.step, message)
      }

      // ── Step / compensation jobs ────────────────────────────────────────
      // Outcomes are recorded inside the job's processing, before it is acked
      // or nacked. A crash in between re-runs the job instead of losing the
      // workflow's progress.
      kernel.pipeline(
        'process',
        async (ctx, next) => {
          const s = stepOf(ctx.job.meta)
          if (!s) return next()

          const plan = await engine.planJob(s.workflowId, ctx.job.id, s.step, s.compensation)
          if (!plan.run) return // workflow stopped, or already recorded: skip the handler

          ctx.workflow = { workflowId: s.workflowId, stepId: s.step, results: plan.results }
          ctx.results = plan.results
          await next() // a throw goes to the fail stage below

          if (ctx.state['_deadLetter']) return onFinalFailure(ctx.job, String(ctx.state['_deadLetter']))
          if (ctx.state['_requeue']) return
          if (s.compensation) await engine.onCompensationDone(s.workflowId, s.step, true)
          else await engine.onStepCompleted(s.workflowId, ctx.job.id, s.step, ctx.job.result)
        },
        { phase: 'transform' },
      )

      kernel.pipeline(
        'fail',
        async (ctx, next) => {
          if (stepOf(ctx.job.meta) && !ctx.state['willRetry']) {
            const error = ctx.state['error'] as { message?: string } | undefined
            await onFinalFailure(ctx.job, error?.message ?? 'Unknown error')
          }
          await next()
        },
        { phase: 'transform' },
      )

      kernel.expose('workflows', {
        registerWorkflow: (def: unknown) => engine.registerDefinition(def as WorkflowDefinition),
        getEngine: () => engine,
        list: (definitionName?: string) => engine.store.list(definitionName),
        get: (id: string) => engine.store.get(id),
        cancel: (id: string) => engine.cancel(id),
      })
    },
  }

  return plugin
}
