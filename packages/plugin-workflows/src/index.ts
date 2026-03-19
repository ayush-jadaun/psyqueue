import type { PsyPlugin, Kernel, PsyEvent } from '@psyqueue/core'
import { WorkflowEngine } from './engine.js'

export { workflow, WorkflowBuilder } from './builder.js'
export { WorkflowEngine } from './engine.js'
export { WorkflowStore } from './state.js'
export type { StepDefinition, WorkflowDefinition, StepOpts } from './builder.js'
export type { WorkflowInstance, WorkflowStatus, StepStatus, StepState } from './state.js'

interface StepJobMeta {
  workflowId: string
  stepName: string
}

/**
 * Creates the workflow plugin.
 *
 * The plugin:
 * - Intercepts enqueue calls for registered workflow names -> starts a workflow
 * - Listens to job:completed -> advances the workflow DAG
 * - Listens to job:dead -> fails the workflow
 * - Injects step results into JobContext.workflow / ctx.results for step handlers
 *
 * Returns the engine instance on the plugin for direct access.
 */
export function workflows(): PsyPlugin & { engine: WorkflowEngine } {
  const engine = new WorkflowEngine()

  // Cache workflow metadata for active step jobs so event handlers
  // can look it up synchronously without querying the backend.
  const activeStepJobs = new Map<string, StepJobMeta>()

  const plugin: PsyPlugin & { engine: WorkflowEngine } = {
    name: 'workflows',
    version: '0.1.0',
    provides: 'workflows',
    depends: ['backend'],
    engine,

    init(kernel: Kernel): void {
      engine.init(kernel)

      // ── Enqueue middleware (transform phase) ─────────────────────────────
      // Detect if the enqueue name matches a registered workflow definition.
      // If so, intercept and start the workflow instead of creating a single job.
      kernel.pipeline(
        'enqueue',
        async (ctx, next) => {
          const jobName = ctx.job.name

          // Don't intercept step jobs (they have workflow metadata)
          if (ctx.job.meta['workflow.id']) {
            await next()
            return
          }

          // Check if this is a registered workflow name
          if (engine.hasDefinition(jobName)) {
            // Start the workflow — creates the instance, enqueues root steps via backend
            const workflowId = await engine.startWorkflow(jobName, ctx.job.payload)
            // Set the job ID to the workflow ID so the caller gets it back
            ctx.job.id = workflowId
            // Mark in meta so we know this was a workflow start
            ctx.job.meta['workflow.instance'] = workflowId
            // Do NOT call next() — we don't want to persist a "workflow" job
            return
          }

          await next()
        },
        { phase: 'transform' },
      )

      // ── Process middleware (transform phase) ─────────────────────────────
      // For workflow step jobs, inject prior step results into the context
      // so the handler can access them via ctx.workflow.results and ctx.results.
      kernel.pipeline(
        'process',
        async (ctx, next) => {
          const workflowId = ctx.job.meta['workflow.id'] as string | undefined
          const stepName = ctx.job.meta['workflow.step'] as string | undefined

          if (workflowId && stepName) {
            // Ensure this job is in the active cache
            activeStepJobs.set(ctx.job.id, { workflowId, stepName })

            const results = engine.getStepResults(workflowId)
            ctx.workflow = {
              workflowId,
              stepId: stepName,
              results,
            }
            ctx.results = results
          }

          await next()
        },
        { phase: 'transform' },
      )

      // ── Event: job:completed ─────────────────────────────────────────────
      // When a workflow step job completes, advance the workflow.
      // Uses cached metadata for synchronous lookup + event data for the result.
      kernel.events.on('job:completed', (event: PsyEvent) => {
        const data = event.data as {
          jobId: string
          queue: string
          name: string
          result?: unknown
        }

        const meta = activeStepJobs.get(data.jobId)
        if (!meta) return // not a workflow step job

        // Clean up cache
        activeStepJobs.delete(data.jobId)

        // Advance the workflow — use the result from the event data
        // (backend doesn't store result, only in-memory ctx.job.result)
        engine.onStepCompleted(meta.workflowId, data.jobId, data.result).catch(() => {
          // Swallow — workflow advancement errors must not crash the queue
        })
      })

      // ── Event: job:failed ────────────────────────────────────────────────
      // On each failure attempt, we don't fail the workflow — only on dead letter.
      // But we still need to track it.

      // ── Event: job:dead ──────────────────────────────────────────────────
      // When a workflow step job is dead-lettered, fail the workflow.
      kernel.events.on('job:dead', (event: PsyEvent) => {
        const data = event.data as {
          jobId: string
          queue: string
          name: string
          error?: unknown
        }

        const meta = activeStepJobs.get(data.jobId)
        if (!meta) return // not a workflow step job

        // Clean up cache
        activeStepJobs.delete(data.jobId)

        const errorMsg = typeof data.error === 'string'
          ? data.error
          : (data.error && typeof data.error === 'object' && 'message' in data.error)
            ? String((data.error as { message: string }).message)
            : 'Unknown error'

        engine.onStepFailed(meta.workflowId, data.jobId, errorMsg)
      })

      // ── Expose the engine for external access ───────────────────────────
      kernel.expose('workflows', {
        registerWorkflow: (def: unknown) => engine.registerDefinition(def as import('./builder.js').WorkflowDefinition),
        getEngine: () => engine,
        list: () => engine.store.list(),
        get: (id: string) => engine.store.get(id),
        cancel: (id: string) => engine.cancel(id),
      })
    },
  }

  return plugin
}
