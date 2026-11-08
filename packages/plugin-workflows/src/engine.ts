import type { Kernel, BackendAdapter, JobHandler, JobContext } from '@psyqueue/core'
import { generateId, createJob } from '@psyqueue/core'
import type { WorkflowDefinition, StepDefinition } from './builder.js'
import { WorkflowStore } from './state.js'
import type { WorkflowInstance, StepState } from './state.js'

const LOCK_TTL_MS = 30_000
const LOCK_WAIT_MS = 30_000
/** Step/compensation jobs are deduped per workflow for this long */
const STEP_KEY_TTL_MS = 30 * 24 * 60 * 60 * 1000

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

type PendingEvent = [name: string, data: unknown]

/** What the process middleware should do with a workflow job. */
export type StepPlan =
  | { run: false }
  | { run: true; results: Record<string, unknown> }

// ─── Engine ──────────────────────────────────────────────────────────────────

/**
 * Runs workflow DAGs on top of ordinary jobs.
 *
 * Durability: instance state lives in the backend (see WorkflowStore), and
 * every state change happens under a backend lock for that workflow, so any
 * number of processes can run steps of the same workflow.
 *
 * Exactly-once advancement: a step's completion is recorded, and its
 * downstream steps enqueued, inside the step job's own processing, before it
 * is acked. A crash in between re-runs the step (at-least-once) instead of
 * stalling the workflow. Step jobs carry a deterministic idempotency key, so
 * a step is never enqueued twice.
 *
 * Failure: when a step fails for good, the workflow is FAILED; once no step is
 * still running, `workflow:failed` is emitted and, if compensation is enabled
 * (saga plugin), compensation jobs run for completed steps in reverse
 * completion order, one at a time, each with retries.
 */
export class WorkflowEngine {
  private readonly definitions = new Map<string, WorkflowDefinition>()
  readonly store = new WorkflowStore(() => this.backend)
  /** Set by the saga plugin */
  compensationEnabled = false
  private _kernel: Kernel | null = null

  get kernel(): Kernel {
    if (!this._kernel) throw new Error('Engine not initialized')
    return this._kernel
  }

  private get backend(): BackendAdapter {
    return this.kernel.getBackend()
  }

  registerDefinition(def: WorkflowDefinition): void {
    this.definitions.set(def.name, def)
  }

  getDefinition(name: string): WorkflowDefinition | undefined {
    return this.definitions.get(name)
  }

  hasDefinition(name: string): boolean {
    return this.definitions.has(name)
  }

  getStepDefinition(definitionName: string, stepName: string): StepDefinition | undefined {
    return this.definitions.get(definitionName)?.steps.find(s => s.name === stepName)
  }

  init(kernel: Kernel): void {
    this._kernel = kernel
  }

  /** Start a new workflow instance and enqueue its root steps. Returns the workflow id. */
  async startWorkflow(definitionName: string, payload: unknown): Promise<string> {
    const def = this.requireDefinition(definitionName)
    const id = generateId()
    const stepStates: Record<string, StepState> = {}
    for (const step of def.steps) stepStates[step.name] = { status: 'pending' }

    await this.store.create({
      id,
      definitionName,
      status: 'RUNNING',
      payload,
      stepStates,
      seq: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    this.kernel.events.emit('workflow:started', { workflowId: id, definitionName })
    await this.mutate(id, (inst, events) => this.advance(inst, def, events))
    return id
  }

  /** Results of all completed steps. */
  async getStepResults(workflowId: string): Promise<Record<string, unknown>> {
    const inst = await this.store.get(workflowId)
    return inst ? resultsOf(inst) : {}
  }

  /** Cancel a running workflow. Queued steps are skipped when they come up. */
  async cancel(workflowId: string): Promise<boolean> {
    let cancelled = false
    await this.mutate(workflowId, (inst, events) => {
      if (inst.status !== 'RUNNING' && inst.status !== 'PENDING') return
      inst.status = 'CANCELLED'
      cancelled = true
      events.push(['workflow:cancelled', { workflowId }])
    })
    return cancelled
  }

  /**
   * Job handler for a workflow's queue: dispatches to the step's handler, or
   * to its compensate handler for compensation jobs.
   * Usage: q.handle(workflowName, engine.createHandler(workflowName))
   */
  createHandler(definitionName: string): JobHandler {
    return async (ctx: JobContext): Promise<unknown> => {
      const compensating = ctx.job.meta['workflow.compensate'] as string | undefined
      const stepName = compensating ?? (ctx.job.meta['workflow.step'] as string | undefined)
      if (!stepName) throw new Error(`Job "${ctx.job.id}" is missing workflow.step metadata`)
      const step = this.getStepDefinition(definitionName, stepName)
      if (!step) throw new Error(`Step "${stepName}" not found in workflow "${definitionName}"`)
      if (compensating) {
        if (!step.compensate) throw new Error(`Step "${stepName}" has no compensate handler`)
        return step.compensate(ctx)
      }
      return step.handler(ctx)
    }
  }

  // ─── Called by the plugin's process middleware ─────────────────────────────

  /**
   * Decide whether a workflow job should run its handler. Jobs whose workflow
   * stopped (failed/cancelled), or whose work is already recorded (a re-run
   * after a crash), are skipped. A skipped step of a stopped workflow is
   * marked cancelled so the workflow can settle.
   */
  async planJob(workflowId: string, jobId: string, step: string, compensation: boolean): Promise<StepPlan> {
    const inst = await this.store.get(workflowId)
    if (!inst) return { run: false }
    const results = resultsOf(inst)

    if (compensation) {
      return inst.compensation?.pending[0] === step ? { run: true, results } : { run: false }
    }

    const state = inst.stepStates[step]
    if (!state || state.status !== 'active' || state.jobId !== jobId) return { run: false }
    if (inst.status === 'RUNNING') return { run: true, results }

    await this.mutate(workflowId, async (i, events) => {
      const s = i.stepStates[step]
      if (s?.status === 'active' && s.jobId === jobId && i.status !== 'RUNNING') {
        s.status = 'cancelled'
        await this.settle(i, events)
      }
    })
    return { run: false }
  }

  /** A step's handler succeeded: record it, then advance (or settle) the workflow. */
  async onStepCompleted(workflowId: string, jobId: string, step: string, result: unknown): Promise<void> {
    await this.mutate(workflowId, async (inst, events) => {
      const state = inst.stepStates[step]
      if (!state || state.status !== 'active' || state.jobId !== jobId) return // already recorded
      state.status = 'completed'
      state.result = result
      state.seq = ++inst.seq
      if (inst.status === 'RUNNING') await this.advance(inst, this.requireDefinition(inst.definitionName), events)
      else await this.settle(inst, events) // it finished after a sibling failed: compensate it too
    })
  }

  /** A step failed for good (dead-lettered). */
  async onStepFailed(workflowId: string, jobId: string, step: string, error: string): Promise<void> {
    await this.mutate(workflowId, async (inst, events) => {
      const state = inst.stepStates[step]
      if (!state || state.status !== 'active' || state.jobId !== jobId) return
      state.status = 'failed'
      state.error = error
      if (inst.status === 'RUNNING') {
        inst.status = 'FAILED'
        inst.failedStep = step
      }
      await this.settle(inst, events)
    })
  }

  /** A compensation job finished (ok=false: it failed for good). Continue with the next one. */
  async onCompensationDone(workflowId: string, step: string, ok: boolean): Promise<void> {
    await this.mutate(workflowId, async (inst, events) => {
      const comp = inst.compensation
      if (!comp || comp.pending[0] !== step) return // already recorded
      comp.pending.shift()
      ;(ok ? comp.done : comp.failed).push(step)
      if (!ok) events.push(['workflow:compensation-step-failed', { workflowId, step }])
      await this.nextCompensation(inst, events)
    })
  }

  // ─── Internal ─────────────────────────────────────────────────────────────

  private requireDefinition(name: string): WorkflowDefinition {
    const def = this.definitions.get(name)
    if (!def) throw new Error(`No workflow definition registered with name "${name}"`)
    return def
  }

  /**
   * Load the instance under its lock, apply `fn`, save, then emit the events
   * `fn` queued (after the lock is released, so listeners can mutate too).
   */
  private async mutate(
    workflowId: string,
    fn: (inst: WorkflowInstance, events: PendingEvent[]) => void | Promise<void>,
  ): Promise<void> {
    const backend = this.backend
    const lockKey = `workflow:${workflowId}`
    const deadline = Date.now() + LOCK_WAIT_MS
    while (!(await backend.acquireLock(lockKey, LOCK_TTL_MS))) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for the lock on workflow ${workflowId}`)
      await sleep(5 + Math.random() * 15)
    }
    const events: PendingEvent[] = []
    try {
      const inst = await this.store.get(workflowId)
      if (!inst) return
      await fn(inst, events)
      await this.store.save(inst)
    } finally {
      await backend.releaseLock(lockKey)
    }
    for (const [name, data] of events) this.kernel.events.emit(name, data)
  }

  /** Enqueue every pending step whose dependencies are resolved; complete the workflow when done. */
  private async advance(inst: WorkflowInstance, def: WorkflowDefinition, events: PendingEvent[]): Promise<void> {
    if (inst.status !== 'RUNNING') return
    let changed = true
    while (changed) {
      changed = false
      for (const step of def.steps) {
        const state = inst.stepStates[step.name]
        if (!state || state.status !== 'pending') continue
        const ready = step.dependencies.every(dep => {
          const s = inst.stepStates[dep]?.status
          return s === 'completed' || s === 'skipped'
        })
        if (!ready) continue
        if (step.when && !step.when({ results: resultsOf(inst) })) {
          inst.stepStates[step.name] = { status: 'skipped' }
        } else {
          const jobId = await this.enqueueWorkflowJob(inst, step, false)
          inst.stepStates[step.name] = { status: 'active', jobId }
        }
        changed = true
      }
    }

    const done = Object.values(inst.stepStates).every(s => s.status === 'completed' || s.status === 'skipped')
    if (done) {
      inst.status = 'COMPLETED'
      events.push(['workflow:completed', { workflowId: inst.id, definitionName: inst.definitionName, results: resultsOf(inst) }])
    }
  }

  /**
   * A stopped workflow settles once no step is still active: report the
   * failure (once) and start compensation if enabled.
   */
  private async settle(inst: WorkflowInstance, events: PendingEvent[]): Promise<void> {
    if (Object.values(inst.stepStates).some(s => s.status === 'active')) return
    if (inst.status !== 'FAILED' || inst.failureReported) return
    inst.failureReported = true
    const failed = inst.stepStates[inst.failedStep ?? '']
    events.push(['workflow:failed', {
      workflowId: inst.id,
      definitionName: inst.definitionName,
      failedStep: inst.failedStep,
      error: failed?.error,
    }])
    if (!this.compensationEnabled) return

    const def = this.requireDefinition(inst.definitionName)
    const pending = Object.entries(inst.stepStates)
      .filter(([name, s]) => s.status === 'completed' && def.steps.find(d => d.name === name)?.compensate)
      .sort(([, a], [, b]) => (b.seq ?? 0) - (a.seq ?? 0)) // reverse completion order
      .map(([name]) => name)
    inst.compensation = { pending, done: [], failed: [] }
    inst.status = 'COMPENSATING'
    events.push(['workflow:compensating', { workflowId: inst.id, definitionName: inst.definitionName, steps: pending }])
    await this.nextCompensation(inst, events)
  }

  private async nextCompensation(inst: WorkflowInstance, events: PendingEvent[]): Promise<void> {
    const comp = inst.compensation!
    const next = comp.pending[0]
    if (next) {
      await this.enqueueWorkflowJob(inst, this.getStepDefinition(inst.definitionName, next)!, true)
      return
    }
    inst.status = comp.failed.length > 0 ? 'COMPENSATION_FAILED' : 'COMPENSATED'
    const base = { workflowId: inst.id, definitionName: inst.definitionName }
    events.push(comp.failed.length > 0
      ? ['workflow:compensation-failed', { ...base, failedSteps: comp.failed }]
      : ['workflow:compensated', base])
  }

  /** Enqueue a step (or its compensation) job; the idempotency key makes this safe to repeat. */
  private async enqueueWorkflowJob(inst: WorkflowInstance, step: StepDefinition, compensation: boolean): Promise<string> {
    const meta: Record<string, unknown> = {
      'workflow.id': inst.id,
      'workflow.definition': inst.definitionName,
      [compensation ? 'workflow.compensate' : 'workflow.step']: step.name,
    }
    const job = createJob(inst.definitionName, inst.payload, {
      queue: inst.definitionName,
      meta,
      maxRetries: step.retry?.maxRetries ?? 3,
      backoff: step.retry?.backoff,
      backoffBase: step.retry?.backoffBase,
      idempotencyKey: `wf:${inst.id}:${compensation ? 'compensate' : 'step'}:${step.name}`,
      idempotencyTtl: STEP_KEY_TTL_MS,
    })
    job.workflowId = inst.id
    job.stepId = step.name
    return this.backend.enqueue(job)
  }
}

function resultsOf(inst: WorkflowInstance): Record<string, unknown> {
  const results: Record<string, unknown> = {}
  for (const [name, state] of Object.entries(inst.stepStates)) {
    if (state.status === 'completed' && state.result !== undefined) results[name] = state.result
  }
  return results
}
