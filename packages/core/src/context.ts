import type { Job, JobContext, LifecycleEvent, EnqueueOpts, Logger } from './types.js'

export function createContext(
  job: Job,
  event: LifecycleEvent,
  internals: {
    enqueue: (name: string, payload: unknown, opts?: EnqueueOpts) => Promise<string>
    updateJob: (jobId: string, updates: Partial<Job>) => Promise<void>
  }
): JobContext {
  const log: Logger = {
    debug: (msg, data) => console.debug(`[${job.id}] ${msg}`, data ?? ''),
    info: (msg, data) => console.info(`[${job.id}] ${msg}`, data ?? ''),
    warn: (msg, data) => console.warn(`[${job.id}] ${msg}`, data ?? ''),
    error: (msg, data) => console.error(`[${job.id}] ${msg}`, data ?? ''),
  }

  const ctx: JobContext = {
    job,
    event,
    state: {},
    log,
    requeue(opts) {
      ctx.state['_requeue'] = opts ?? {}
    },
    deadLetter(reason) {
      ctx.state['_deadLetter'] = reason
    },
    async breaker(_name, fn) {
      return fn() // Default — circuit breaker plugin overrides this
    },
    async updateJob(updates) {
      await internals.updateJob(job.id, updates)
      Object.assign(job, updates)
    },
    async enqueue(name, payload, opts) {
      return internals.enqueue(name, payload, opts)
    },
  }
  return ctx
}
