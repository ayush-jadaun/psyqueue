import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import type {
  BackendAdapter,
  Job,
  DequeuedJob,
  AckResult,
  NackOpts,
  JobFilter,
  PaginatedResult,
  AtomicOp,
  JobError,
  BackoffStrategy,
} from 'psyqueue'
import { SCHEMA_SQL } from './schema.js'
import {
  INSERT_JOB,
  SELECT_JOB_BY_ID,
  SELECT_FOR_DEQUEUE,
  UPDATE_DEQUEUE,
  ACK_WITH_TOKEN,
  ACK_WITHOUT_TOKEN,
  NACK_DEAD,
  NACK_FAILED,
  NACK_REQUEUE,
  POLL_SCHEDULED,
  UPDATE_SCHEDULED_TO_PENDING,
  ACQUIRE_LOCK,
  DELETE_EXPIRED_LOCK,
  RELEASE_LOCK,
  buildListJobsQuery,
} from './queries.js'

export interface SQLiteAdapterOpts {
  path: string
}

interface JobRow {
  id: string
  queue: string
  name: string
  payload: string
  status: string
  priority: number
  tenant_id: string | null
  idempotency_key: string | null
  schema_version: number | null
  max_retries: number
  attempt: number
  backoff: string
  backoff_base: number | null
  backoff_cap: number | null
  backoff_jitter: number | null
  timeout: number
  workflow_id: string | null
  step_id: string | null
  parent_job_id: string | null
  trace_id: string | null
  span_id: string | null
  run_at: string | null
  cron: string | null
  deadline: string | null
  result: string | null
  error: string | null
  meta: string
  completion_token: string | null
  created_at: string
  started_at: string | null
  completed_at: string | null
}

function serializeJob(job: Job): Record<string, unknown> {
  return {
    id: job.id,
    queue: job.queue,
    name: job.name,
    payload: JSON.stringify(job.payload),
    status: job.status,
    priority: job.priority,
    tenant_id: job.tenantId ?? null,
    idempotency_key: job.idempotencyKey ?? null,
    schema_version: job.schemaVersion ?? null,
    max_retries: job.maxRetries,
    attempt: job.attempt,
    backoff: typeof job.backoff === 'function' ? 'custom' : job.backoff,
    backoff_base: job.backoffBase ?? null,
    backoff_cap: job.backoffCap ?? null,
    backoff_jitter: job.backoffJitter == null ? null : (job.backoffJitter ? 1 : 0),
    timeout: job.timeout,
    workflow_id: job.workflowId ?? null,
    step_id: job.stepId ?? null,
    parent_job_id: job.parentJobId ?? null,
    trace_id: job.traceId ?? null,
    span_id: job.spanId ?? null,
    run_at: job.runAt ? job.runAt.toISOString() : null,
    cron: job.cron ?? null,
    deadline: job.deadline ? job.deadline.toISOString() : null,
    result: job.result != null ? JSON.stringify(job.result) : null,
    error: job.error != null ? JSON.stringify(job.error) : null,
    meta: JSON.stringify(job.meta ?? {}),
    completion_token: null,
    created_at: job.createdAt.toISOString(),
    started_at: job.startedAt ? job.startedAt.toISOString() : null,
    completed_at: job.completedAt ? job.completedAt.toISOString() : null,
  }
}

function deserializeJob(row: JobRow): Job {
  const backoff: BackoffStrategy = (row.backoff === 'fixed' || row.backoff === 'exponential' || row.backoff === 'linear')
    ? row.backoff
    : 'exponential'

  return {
    id: row.id,
    queue: row.queue,
    name: row.name,
    payload: JSON.parse(row.payload),
    status: row.status as Job['status'],
    priority: row.priority,
    tenantId: row.tenant_id ?? undefined,
    idempotencyKey: row.idempotency_key ?? undefined,
    schemaVersion: row.schema_version ?? undefined,
    maxRetries: row.max_retries,
    attempt: row.attempt,
    backoff,
    backoffBase: row.backoff_base ?? undefined,
    backoffCap: row.backoff_cap ?? undefined,
    backoffJitter: row.backoff_jitter == null ? undefined : (row.backoff_jitter === 1),
    timeout: row.timeout,
    workflowId: row.workflow_id ?? undefined,
    stepId: row.step_id ?? undefined,
    parentJobId: row.parent_job_id ?? undefined,
    traceId: row.trace_id ?? undefined,
    spanId: row.span_id ?? undefined,
    runAt: row.run_at ? new Date(row.run_at) : undefined,
    cron: row.cron ?? undefined,
    deadline: row.deadline ? new Date(row.deadline) : undefined,
    result: row.result ? JSON.parse(row.result) : undefined,
    error: row.error ? JSON.parse(row.error) as JobError : undefined,
    meta: JSON.parse(row.meta) as Record<string, unknown>,
    createdAt: new Date(row.created_at),
    startedAt: row.started_at ? new Date(row.started_at) : undefined,
    completedAt: row.completed_at ? new Date(row.completed_at) : undefined,
  }
}

function deserializeDequeuedJob(row: JobRow): DequeuedJob {
  const job = deserializeJob(row)
  return {
    ...job,
    completionToken: row.completion_token ?? '',
  }
}

export class SQLiteBackendAdapter implements BackendAdapter {
  readonly name = 'sqlite'
  readonly type = 'sqlite'

  private db: Database.Database | null = null
  private readonly opts: SQLiteAdapterOpts

  constructor(opts: SQLiteAdapterOpts) {
    this.opts = opts
  }

  async connect(): Promise<void> {
    this.db = new Database(this.opts.path)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    this.db.exec(SCHEMA_SQL)
  }

  async disconnect(): Promise<void> {
    if (this.db) {
      this.db.close()
      this.db = null
    }
  }

  async healthCheck(): Promise<boolean> {
    if (!this.db) return false
    try {
      const row = this.db.prepare('SELECT 1 as ok').get() as { ok: number } | undefined
      return row?.ok === 1
    } catch {
      return false
    }
  }

  async enqueue(job: Job): Promise<string> {
    const db = this.getDb()
    const params = serializeJob(job)
    db.prepare(INSERT_JOB).run(params)
    return job.id
  }

  async enqueueBulk(jobs: Job[]): Promise<string[]> {
    const db = this.getDb()
    const stmt = db.prepare(INSERT_JOB)
    const insertAll = db.transaction((jobsToInsert: Job[]) => {
      const ids: string[] = []
      for (const job of jobsToInsert) {
        const params = serializeJob(job)
        stmt.run(params)
        ids.push(job.id)
      }
      return ids
    })
    return insertAll(jobs)
  }

  async dequeue(queue: string, count: number): Promise<DequeuedJob[]> {
    const db = this.getDb()
    const now = new Date().toISOString()

    const dequeueTransaction = db.transaction((q: string, c: number) => {
      // Select candidate job ids
      const rows = db.prepare(SELECT_FOR_DEQUEUE).all(q, c) as Array<{ id: string }>
      if (rows.length === 0) return []

      const results: DequeuedJob[] = []
      const updateStmt = db.prepare(UPDATE_DEQUEUE)
      const selectStmt = db.prepare(SELECT_JOB_BY_ID)

      for (const row of rows) {
        const token = randomUUID()
        updateStmt.run(now, token, row.id)
        const updated = selectStmt.get(row.id) as JobRow
        results.push(deserializeDequeuedJob(updated))
      }

      return results
    })

    return dequeueTransaction(queue, count)
  }

  async ack(jobId: string, completionToken?: string): Promise<AckResult> {
    const db = this.getDb()
    const now = new Date().toISOString()

    if (completionToken) {
      const result = db.prepare(ACK_WITH_TOKEN).run(now, jobId, completionToken)
      if (result.changes === 0) {
        return { alreadyCompleted: true }
      }
      return { alreadyCompleted: false }
    }

    db.prepare(ACK_WITHOUT_TOKEN).run(now, jobId)
    return { alreadyCompleted: false }
  }

  async nack(jobId: string, opts?: NackOpts): Promise<void> {
    const db = this.getDb()

    if (opts?.deadLetter) {
      const errorJson = opts.reason ? JSON.stringify({ message: opts.reason, retryable: false }) : null
      db.prepare(NACK_DEAD).run(errorJson, jobId)
      return
    }

    if (opts?.requeue === false) {
      const errorJson = opts.reason ? JSON.stringify({ message: opts.reason, retryable: false }) : null
      db.prepare(NACK_FAILED).run(errorJson, jobId)
      return
    }

    // Default: requeue
    let runAt: string | null = null
    if (opts?.delay) {
      runAt = new Date(Date.now() + opts.delay).toISOString()
    }
    db.prepare(NACK_REQUEUE).run(runAt, jobId)
  }

  async getJob(jobId: string): Promise<Job | null> {
    const db = this.getDb()
    const row = db.prepare(SELECT_JOB_BY_ID).get(jobId) as JobRow | undefined
    if (!row) return null
    return deserializeJob(row)
  }

  async listJobs(filter: JobFilter): Promise<PaginatedResult<Job>> {
    const db = this.getDb()
    const query = buildListJobsQuery(filter)

    const rows = db.prepare(query.sql).all(...query.params) as JobRow[]
    const countRow = db.prepare(query.countSql).get(...query.countParams) as { total: number }

    const limit = filter.limit ?? 50
    const offset = filter.offset ?? 0
    const total = countRow.total

    return {
      data: rows.map(deserializeJob),
      total,
      limit,
      offset,
      hasMore: offset + limit < total,
    }
  }

  async scheduleAt(job: Job, runAt: Date): Promise<string> {
    const db = this.getDb()
    const scheduled = {
      ...job,
      status: 'scheduled' as const,
      runAt,
    }
    const params = serializeJob(scheduled)
    db.prepare(INSERT_JOB).run(params)
    return job.id
  }

  async pollScheduled(now: Date, limit: number): Promise<Job[]> {
    const db = this.getDb()
    const nowStr = now.toISOString()

    const pollTransaction = db.transaction((n: string, l: number) => {
      const rows = db.prepare(POLL_SCHEDULED).all(n, l) as Array<{ id: string }>
      if (rows.length === 0) return []

      const updateStmt = db.prepare(UPDATE_SCHEDULED_TO_PENDING)
      const selectStmt = db.prepare(SELECT_JOB_BY_ID)
      const results: Job[] = []

      for (const row of rows) {
        updateStmt.run(row.id)
        const updated = selectStmt.get(row.id) as JobRow
        results.push(deserializeJob(updated))
      }

      return results
    })

    return pollTransaction(nowStr, limit)
  }

  async acquireLock(key: string, ttlMs: number): Promise<boolean> {
    const db = this.getDb()
    const now = new Date().toISOString()
    const expiresAt = new Date(Date.now() + ttlMs).toISOString()

    // Delete expired lock first
    db.prepare(DELETE_EXPIRED_LOCK).run(key, now)

    // Try to insert new lock
    const result = db.prepare(ACQUIRE_LOCK).run(key, expiresAt)
    return result.changes > 0
  }

  async releaseLock(key: string): Promise<void> {
    const db = this.getDb()
    db.prepare(RELEASE_LOCK).run(key)
  }

  async atomic(ops: AtomicOp[]): Promise<void> {
    const db = this.getDb()

    const runAtomic = db.transaction((operations: AtomicOp[]) => {
      for (const op of operations) {
        switch (op.type) {
          case 'enqueue': {
            const params = serializeJob(op.job)
            db.prepare(INSERT_JOB).run(params)
            break
          }
          case 'ack': {
            const now = new Date().toISOString()
            db.prepare(ACK_WITHOUT_TOKEN).run(now, op.jobId)
            break
          }
          case 'nack': {
            if (op.opts?.deadLetter) {
              const errorJson = op.opts.reason ? JSON.stringify({ message: op.opts.reason, retryable: false }) : null
              db.prepare(NACK_DEAD).run(errorJson, op.jobId)
            } else if (op.opts?.requeue === false) {
              const errorJson = op.opts.reason ? JSON.stringify({ message: op.opts.reason, retryable: false }) : null
              db.prepare(NACK_FAILED).run(errorJson, op.jobId)
            } else {
              let runAt: string | null = null
              if (op.opts?.delay) {
                runAt = new Date(Date.now() + op.opts.delay).toISOString()
              }
              db.prepare(NACK_REQUEUE).run(runAt, op.jobId)
            }
            break
          }
          case 'update': {
            const sets: string[] = []
            const values: unknown[] = []
            const updates = op.updates

            if (updates.status !== undefined) { sets.push('status = ?'); values.push(updates.status) }
            if (updates.priority !== undefined) { sets.push('priority = ?'); values.push(updates.priority) }
            if (updates.attempt !== undefined) { sets.push('attempt = ?'); values.push(updates.attempt) }
            if (updates.result !== undefined) { sets.push('result = ?'); values.push(JSON.stringify(updates.result)) }
            if (updates.error !== undefined) { sets.push('error = ?'); values.push(JSON.stringify(updates.error)) }
            if (updates.meta !== undefined) { sets.push('meta = ?'); values.push(JSON.stringify(updates.meta)) }

            if (sets.length > 0) {
              values.push(op.jobId)
              db.prepare(`UPDATE jobs SET ${sets.join(', ')} WHERE id = ?`).run(...values)
            }
            break
          }
        }
      }
    })

    runAtomic(ops)
  }

  private getDb(): Database.Database {
    if (!this.db) {
      throw new Error('SQLite backend not connected. Call connect() first.')
    }
    return this.db
  }
}
