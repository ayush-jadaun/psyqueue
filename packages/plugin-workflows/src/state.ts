import type { BackendAdapter, Job } from '@psyqueue/core'
import { createJob } from '@psyqueue/core'

// ─── Workflow Instance Types ──────────────────────────────────────────────────

export type WorkflowStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'
  | 'COMPENSATING'
  | 'COMPENSATED'
  | 'COMPENSATION_FAILED'

export type StepStatus = 'pending' | 'active' | 'completed' | 'skipped' | 'failed' | 'cancelled'

export interface StepState {
  status: StepStatus
  jobId?: string
  result?: unknown
  error?: string
  /** Completion order (1, 2, 3...), used to compensate in reverse */
  seq?: number
}

export interface CompensationState {
  /** Steps still to compensate, in order; the head is in progress */
  pending: string[]
  done: string[]
  failed: string[]
}

export interface WorkflowInstance {
  id: string
  definitionName: string
  status: WorkflowStatus
  payload: unknown
  stepStates: Record<string, StepState>
  /** Last completion sequence number handed out */
  seq: number
  failedStep?: string
  /** True once workflow:failed was emitted (it fires once, when all steps settled) */
  failureReported?: boolean
  compensation?: CompensationState
  createdAt: Date
  updatedAt: Date
}

// ─── Durable Store ───────────────────────────────────────────────────────────

/** Records live in the backend as stored-only jobs in this queue (never dequeued). */
export const WORKFLOW_RECORD_QUEUE = '__psyqueue_workflows'
export const WORKFLOW_RECORD_NAME = '__workflow__'

type StoredInstance = Omit<WorkflowInstance, 'createdAt' | 'updatedAt'> & { createdAt: string; updatedAt: string }

function toStored(i: WorkflowInstance): StoredInstance {
  return { ...i, createdAt: i.createdAt.toISOString(), updatedAt: i.updatedAt.toISOString() }
}

function fromStored(s: StoredInstance): WorkflowInstance {
  return { ...s, createdAt: new Date(s.createdAt), updatedAt: new Date(s.updatedAt) }
}

function fromJob(job: Job | null): WorkflowInstance | undefined {
  if (!job || job.name !== WORKFLOW_RECORD_NAME) return undefined
  const stored = job.meta['workflow'] as StoredInstance | undefined
  return stored ? fromStored(stored) : undefined
}

/**
 * Workflow state stored in the backend, so it survives restarts and is shared
 * by every process using the same backend. Writes go through WorkflowEngine,
 * which serializes them with a backend lock per workflow.
 */
export class WorkflowStore {
  constructor(private readonly getBackend: () => BackendAdapter) {}

  async create(instance: WorkflowInstance): Promise<void> {
    const job = createJob(WORKFLOW_RECORD_NAME, null, {
      queue: WORKFLOW_RECORD_QUEUE,
      meta: { workflow: toStored(instance) },
    })
    job.id = instance.id
    job.status = 'completed' // stored only: never dequeued
    await this.getBackend().enqueue(job)
  }

  async get(id: string): Promise<WorkflowInstance | undefined> {
    return fromJob(await this.getBackend().getJob(id))
  }

  async save(instance: WorkflowInstance): Promise<void> {
    instance.updatedAt = new Date()
    await this.getBackend().atomic([
      { type: 'update', jobId: instance.id, updates: { meta: { workflow: toStored(instance) } } },
    ])
  }

  /** All workflow instances (optionally of one definition), newest first. */
  async list(definitionName?: string): Promise<WorkflowInstance[]> {
    const out: WorkflowInstance[] = []
    const limit = 500
    for (let offset = 0; ; offset += limit) {
      const page = await this.getBackend().listJobs({ queue: WORKFLOW_RECORD_QUEUE, name: WORKFLOW_RECORD_NAME, limit, offset })
      for (const job of page.data) {
        const instance = fromJob(job)
        if (instance && (!definitionName || instance.definitionName === definitionName)) out.push(instance)
      }
      if (!page.hasMore) return out
    }
  }
}
