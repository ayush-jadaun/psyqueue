import { ulid } from 'ulidx'
import type { Job, EnqueueOpts } from './types.js'

export function generateId(): string {
  return ulid()
}

export function createJob(name: string, payload: unknown, opts: EnqueueOpts = {}): Job {
  const hasRunAt = opts.runAt != null && opts.runAt > new Date()
  return {
    id: generateId(),
    queue: opts.queue ?? name,
    name,
    payload,
    priority: opts.priority ?? 0,
    deadline: opts.deadline,
    runAt: opts.runAt,
    cron: opts.cron,
    tenantId: opts.tenantId,
    idempotencyKey: opts.idempotencyKey,
    maxRetries: opts.maxRetries ?? 3,
    attempt: 1,
    backoff: opts.backoff ?? 'exponential',
    backoffBase: opts.backoffBase,
    backoffCap: opts.backoffCap,
    backoffJitter: opts.backoffJitter,
    timeout: opts.timeout ?? 30_000,
    status: hasRunAt ? 'scheduled' : 'pending',
    createdAt: new Date(),
    meta: opts.meta ? { ...opts.meta } : {},
  }
}
