import type { Kernel, BackendAdapter, Job, JobHandler, JobContext } from '@psyqueue/core'
import { generateId, createJob } from '@psyqueue/core'
import type { WorkflowDefinition, StepDefinition } from './builder.js'
import { WorkflowStore } from './state.js'
import type { WorkflowInstance, StepState } from './state.js'

// ─── Engine ──────────────────────────────────────────────────────────────────

export class WorkflowEngine {
  private readonly definitions = new Map<string, WorkflowDefinition>()
  readonly store = new WorkflowStore()
  private _kernel: Kernel | null = null

  get kernel(): Kernel {
    if (!this._kernel) throw new Error('Engine not initialized')
    return this._kernel
  }

  private get backend(): BackendAdapter {
    return this.kernel.getBackend()
  }

  /**
   * Register a workflow definition by name.
   */
  registerDefinition(def: WorkflowDefinition): void {
    this.definitions.set(def.name, def)
  }

  /**
   * Get a registered workflow definition by name.
   */
  getDefinition(name: string): WorkflowDefinition | undefined {
    return this.definitions.get(name)
  }

  /**
   * Check if a name corresponds to a registered workflow.
   */
  hasDefinition(name: string): boolean {
    return this.definitions.has(name)
  }

  /**
   * Get the step definition by name for a given workflow.
   */
  getStepDefinition(definitionName: string, stepName: string): StepDefinition | undefined {
    const def = this.definitions.get(definitionName)
    if (!def) return undefined
    return def.steps.find(s => s.name === stepName)
  }

  /**
   * Initialize the engine with a kernel reference.
   */
  init(kernel: Kernel): void {
    this._kernel = kernel
  }

  /**
   * Start a new workflow instance. Creates instance, enqueues root steps.
   * Returns the workflow instance ID.
   */
  async startWorkflow(definitionName: string, payload: unknown): Promise<string> {
    const def = this.definitions.get(definitionName)
    if (!def) {
      throw new Error(`No workflow definition registered with name "${definitionName}"`)
    }

    const workflowId = generateId()
    const stepStates: Record<string, StepState> = {}
    for (const step of def.steps) {
      stepStates[step.name] = { status: 'pending' }
    }

    const instance: WorkflowInstance = {
      id: workflowId,
      definitionName,
      status: 'RUNNING',
      payload,
      stepStates,
      createdAt: new Date(),
      updatedAt: new Date(),
    }
    this.store.create(instance)

    // Find root steps (no dependencies) and enqueue them
    const rootSteps = def.steps.filter(s => s.dependencies.length === 0)
    for (const step of rootSteps) {
      // Evaluate when condition for root steps
      if (step.when) {
        const shouldRun = step.when({ results: {} })
        if (!shouldRun) {
          instance.stepStates[step.name] = { status: 'skipped' }
          continue
        }
      }
      await this.enqueueStep(workflowId, step, def.name, payload)
    }

    // After enqueuing/skipping root steps, check if any downstream steps
    // have all dependencies resolved (e.g., all root deps were skipped)
    await this.advanceAfterSkips(workflowId, def)

    // Check if workflow is already complete (all steps skipped)
    this.checkWorkflowCompletion(workflowId)

    this.kernel.events.emit('workflow:started', {
      workflowId,
      definitionName,
    })

    return workflowId
  }

  /**
   * Handle a step completion. Called when a workflow step job completes.
   */
  async onStepCompleted(workflowId: string, jobId: string, result: unknown): Promise<void> {
    const instance = this.store.get(workflowId)
    if (!instance) return
    if (instance.status !== 'RUNNING') return

    const def = this.definitions.get(instance.definitionName)
    if (!def) return

    // Find step name by jobId
    const stepName = this.store.findStepByJobId(workflowId, jobId)
    if (!stepName) return

    // Update step state
    const stepState = instance.stepStates[stepName]
    if (!stepState || stepState.status !== 'active') return
    stepState.status = 'completed'
    stepState.result = result
    instance.updatedAt = new Date()

    // Find and enqueue downstream steps
    await this.advanceWorkflow(workflowId, def)

    // Check completion
    this.checkWorkflowCompletion(workflowId)
  }

  /**
   * Handle a step failure (dead-lettered). Called when a workflow step job
   * is permanently dead after all retries.
   */
  onStepFailed(workflowId: string, jobId: string, error: string): void {
    const instance = this.store.get(workflowId)
    if (!instance) return
    if (instance.status !== 'RUNNING') return

    const stepName = this.store.findStepByJobId(workflowId, jobId)
    if (!stepName) return

    const stepState = instance.stepStates[stepName]
    if (!stepState) return
    stepState.status = 'failed'
    stepState.error = error
    instance.updatedAt = new Date()

    instance.status = 'FAILED'

    this.kernel.events.emit('workflow:failed', {
      workflowId,
      definitionName: instance.definitionName,
      failedStep: stepName,
      error,
    })
  }

  /**
   * Get collected results from all completed steps.
   */
  getStepResults(workflowId: string): Record<string, unknown> {
    const instance = this.store.get(workflowId)
    if (!instance) return {}

    const results: Record<string, unknown> = {}
    for (const [name, state] of Object.entries(instance.stepStates)) {
      if (state.status === 'completed' && state.result !== undefined) {
        results[name] = state.result
      }
    }
    return results
  }

  /**
   * Cancel a workflow instance.
   */
  cancel(workflowId: string): boolean {
    const instance = this.store.get(workflowId)
    if (!instance) return false
    if (instance.status !== 'RUNNING' && instance.status !== 'PENDING') return false
    instance.status = 'CANCELLED'
    instance.updatedAt = new Date()
    this.kernel.events.emit('workflow:cancelled', { workflowId })
    return true
  }

  /**
   * Create a job handler that dispatches to the correct step handler
   * based on the workflow metadata in the job context.
   *
   * Usage: q.handle(workflowName, engine.createHandler(workflowName))
   */
  createHandler(definitionName: string): JobHandler {
    return async (ctx: JobContext): Promise<unknown> => {
      const stepName = ctx.job.meta['workflow.step'] as string | undefined
      if (!stepName) {
        throw new Error(`Job "${ctx.job.id}" is missing workflow.step metadata`)
      }

      const def = this.definitions.get(definitionName)
      if (!def) {
        throw new Error(`No workflow definition registered: "${definitionName}"`)
      }

      const step = def.steps.find(s => s.name === stepName)
      if (!step) {
        throw new Error(`Step "${stepName}" not found in workflow "${definitionName}"`)
      }

      return step.handler(ctx)
    }
  }

  // ─── Internal ─────────────────────────────────────────────────────────────

  /**
   * Enqueue a step as a job directly via the backend.
   * The job gets workflow metadata so the process middleware and event
   * handlers can identify it as a workflow step.
   */
  private async enqueueStep(
    workflowId: string,
    step: StepDefinition,
    definitionName: string,
    payload: unknown,
  ): Promise<void> {
    const instance = this.store.get(workflowId)
    if (!instance) return

    // The job name is the workflow queue name (so processNext(queueName) picks it up)
    // We use the workflow definition name as the queue name.
    const job: Job = createJob(definitionName, payload, {
      queue: definitionName,
      meta: {
        'workflow.id': workflowId,
        'workflow.step': step.name,
        'workflow.definition': definitionName,
      },
      maxRetries: 0,
    })

    // Override the job name to be the workflow name (queue = workflow name)
    // The name stays as the definition name so the handler lookup works.
    await this.backend.enqueue(job)

    instance.stepStates[step.name] = {
      status: 'active',
      jobId: job.id,
    }
    instance.updatedAt = new Date()
  }

  /**
   * Find downstream steps whose dependencies are all satisfied and enqueue them.
   */
  private async advanceWorkflow(workflowId: string, def: WorkflowDefinition): Promise<void> {
    const instance = this.store.get(workflowId)
    if (!instance || instance.status !== 'RUNNING') return

    const results = this.getStepResults(workflowId)

    // We may need multiple passes as skipping a step can unblock others
    let changed = true
    while (changed) {
      changed = false
      for (const step of def.steps) {
        const state = instance.stepStates[step.name]
        if (!state || state.status !== 'pending') continue

        // Check if ALL dependencies are resolved (completed or skipped)
        const allDepsResolved = step.dependencies.every(dep => {
          const depState = instance.stepStates[dep]
          return depState && (depState.status === 'completed' || depState.status === 'skipped')
        })

        if (!allDepsResolved) continue

        // Evaluate when condition
        if (step.when) {
          const shouldRun = step.when({ results })
          if (!shouldRun) {
            instance.stepStates[step.name] = { status: 'skipped' }
            instance.updatedAt = new Date()
            changed = true
            continue // skipping may unblock further steps
          }
        }

        // Enqueue the step
        await this.enqueueStep(workflowId, step, def.name, instance.payload)
        changed = true
      }
    }
  }

  /**
   * After skipping root steps, check if downstream steps are now unblocked.
   */
  private async advanceAfterSkips(workflowId: string, def: WorkflowDefinition): Promise<void> {
    await this.advanceWorkflow(workflowId, def)
  }

  /**
   * Check if all steps are completed/skipped and mark workflow done.
   */
  private checkWorkflowCompletion(workflowId: string): void {
    const instance = this.store.get(workflowId)
    if (!instance || instance.status !== 'RUNNING') return

    const allDone = Object.values(instance.stepStates).every(
      s => s.status === 'completed' || s.status === 'skipped'
    )

    if (allDone) {
      instance.status = 'COMPLETED'
      instance.updatedAt = new Date()

      this.kernel.events.emit('workflow:completed', {
        workflowId,
        definitionName: instance.definitionName,
        results: this.getStepResults(workflowId),
      })
    }
  }
}
