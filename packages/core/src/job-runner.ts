import type {
  BackendAdapter,
  DequeuedJob,
  EnqueueOpts,
  EventBusInterface,
  HandlerOpts,
  Job,
  JobContext,
  JobError,
  JobHandler,
  LifecycleEvent,
} from './types.js'
import type { MiddlewarePipeline } from './middleware-pipeline.js'
import { createContext } from './context.js'

export interface RegisteredHandler {
  handler: JobHandler
  opts: HandlerOpts
}

export interface RunnerDeps {
  backend: BackendAdapter
  pipeline: MiddlewarePipeline
  handlers: Map<string, RegisteredHandler>
  eventBus: EventBusInterface
  enqueue: (name: string, payload: unknown, opts?: EnqueueOpts) => Promise<string>
  classifyError: (error: Error) => NonNullable<JobError['category']>
  calculateBackoff: (job: Job) => number
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/**
 * Process one dequeued job end to end: run the `process` pipeline with the
 * handler as its innermost step, then ack, requeue, retry or dead-letter it.
 *
 * Every backend write passes the job's completion token, so if this worker's
 * lease expired and another worker took the job over, nothing here can clobber
 * the new owner's state.
 *
 * With `fetchNext`, the ack also fetches the next job (backend.ackAndFetch);
 * it is returned so the caller can run it.
 */
export async function runJob(
  dequeued: DequeuedJob,
  deps: RunnerDeps,
  opts: { fetchNext?: boolean } = {},
): Promise<DequeuedJob | null> {
  const { backend, eventBus } = deps
  const job = dequeued as Job
  const token = dequeued.completionToken || undefined
  const base = { jobId: job.id, queue: job.queue, name: job.name }

  const registered = deps.handlers.get(job.name)
  if (!registered) {
    const reason = `No handler registered for job "${job.name}"`
    await backend.nack(job.id, { requeue: false, deadLetter: true, reason, completionToken: token })
    eventBus.emit('job:dead', { ...base, reason, error: { message: reason, retryable: false }, attempt: job.attempt })
    eventBus.emit('job:failed', { ...base, error: reason })
    return null
  }

  const ctx = createContext(job, 'process', {
    enqueue: deps.enqueue,
    updateJob: async (id, updates) => {
      await backend.atomic([{ type: 'update', jobId: id, updates }])
    },
  })

  eventBus.emit('job:started', base)

  try {
    await deps.pipeline.run('process', ctx, async () => {
      ctx.job.result = await registered.handler(ctx)
    })
  } catch (err) {
    await handleFailure(err, ctx, token, deps)
    return null
  }

  if (ctx.state['_deadLetter']) {
    const reason = String(ctx.state['_deadLetter'])
    await backend.nack(job.id, { requeue: false, deadLetter: true, reason, completionToken: token })
    eventBus.emit('job:dead', { ...base, reason, error: { message: reason, retryable: false }, attempt: job.attempt })
    return null
  }

  if (ctx.state['_requeue']) {
    const { delay } = ctx.state['_requeue'] as { delay?: number }
    await backend.nack(job.id, { requeue: true, delay, completionToken: token })
    eventBus.emit('job:requeued', base)
    return null
  }

  const resultJson = job.result !== undefined ? JSON.stringify(job.result) : undefined
  let nextJob: DequeuedJob | null = null
  let alreadyCompleted: boolean
  if (opts.fetchNext && backend.ackAndFetch) {
    const r = await backend.ackAndFetch(job.id, token, job.queue, resultJson)
    alreadyCompleted = r.ackResult.alreadyCompleted
    nextJob = r.nextJob
  } else {
    alreadyCompleted = (await backend.ack(job.id, token, resultJson)).alreadyCompleted
  }

  if (alreadyCompleted) {
    // Our token was rejected: the lease expired and another worker owns the job.
    eventBus.emit('job:ack-rejected', base)
    return nextJob
  }

  await runSideStage(deps, 'complete', ctx)
  eventBus.emit('job:completed', { ...base, result: job.result })
  return nextJob
}

async function handleFailure(err: unknown, ctx: JobContext, token: string | undefined, deps: RunnerDeps): Promise<void> {
  const { backend, eventBus } = deps
  const job = ctx.job
  const base = { jobId: job.id, queue: job.queue, name: job.name }
  const error = err instanceof Error ? err : new Error(String(err))
  const category = deps.classifyError(error)
  const retryable = category !== 'fatal' && category !== 'validation'
  const jobError: JobError = { message: error.message, stack: error.stack, category, retryable }
  ctx.state['error'] = jobError

  await runSideStage(deps, 'fail', ctx)

  if (retryable && job.attempt < job.maxRetries) {
    const delay = deps.calculateBackoff(job)
    if (delay > 0 && delay <= 1000) {
      // Short delay: wait in-process (the lease heartbeat keeps the job ours),
      // avoiding a round-trip through the scheduled set.
      await sleep(delay)
      await backend.nack(job.id, { requeue: true, delay: 0, completionToken: token })
    } else {
      await backend.nack(job.id, { requeue: true, delay, completionToken: token })
    }
    await runSideStage(deps, 'retry', ctx)
    eventBus.emit('job:retry', { ...base, attempt: job.attempt, delay, error: error.message })
  } else {
    await backend.nack(job.id, { requeue: false, deadLetter: true, reason: error.message, completionToken: token })
    eventBus.emit('job:dead', { ...base, error: jobError, attempt: job.attempt })
  }

  eventBus.emit('job:failed', { ...base, error: error.message })
}

/** Runs a notification-only pipeline stage; its errors never change the job's outcome. */
async function runSideStage(deps: RunnerDeps, event: LifecycleEvent, ctx: JobContext): Promise<void> {
  ctx.event = event
  try {
    await deps.pipeline.run(event, ctx)
  } catch (err) {
    deps.eventBus.emit('pipeline:error', {
      jobId: ctx.job.id,
      event,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
