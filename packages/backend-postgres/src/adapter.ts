import { Pool, type PoolClient } from 'pg'
import { randomUUID } from 'node:crypto'
import { SCHEMA_SQL } from './schema.js'
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

export interface PostgresAdapterOpts {
  connectionString?: string
  host?: string
  port?: number
  database?: string
  user?: string
  password?: string
  ssl?: boolean
  max?: number // pool size
}

// Row shape returned by pg for our jobs table
interface JobRow {
  id: string
  queue: string
  name: string
  payload: unknown
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
  backoff_jitter: boolean | null
  timeout: number
  workflow_id: string | null
  step_id: string | null
  parent_job_id: string | null
  trace_id: string | null
  span_id: string | null
  run_at: Date | null
  cron: string | null
  deadline: Date | null
  result: unknown
  error: unknown
  meta: unknown
  completion_token: string | null
  created_at: Date
  started_at: Date | null
  completed_at: Date | null
}

export function deserializeJobRow(row: JobRow): Job {
  const backoffRaw = row.backoff
  const backoff: BackoffStrategy = (backoffRaw === 'fixed' || backoffRaw === 'exponential' || backoffRaw === 'linear')
    ? backoffRaw
    : 'exponential'

  return {
    id: row.id,
    queue: row.queue,
    name: row.name,
    payload: row.payload,
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
    backoffJitter: row.backoff_jitter ?? undefined,
    timeout: row.timeout,
    workflowId: row.workflow_id ?? undefined,
    stepId: row.step_id ?? undefined,
    parentJobId: row.parent_job_id ?? undefined,
    traceId: row.trace_id ?? undefined,
    spanId: row.span_id ?? undefined,
    runAt: row.run_at ?? undefined,
    cron: row.cron ?? undefined,
    deadline: row.deadline ?? undefined,
    result: row.result ?? undefined,
    error: row.error != null ? row.error as JobError : undefined,
    meta: (row.meta ?? {}) as Record<string, unknown>,
    createdAt: row.created_at,
    startedAt: row.started_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
  }
}

export function serializeJobParams(job: Job): unknown[] {
  return [
    job.id,                                                            // $1
    job.queue,                                                         // $2
    job.name,                                                          // $3
    JSON.stringify(job.payload),                                       // $4
    job.status,                                                        // $5
    job.priority,                                                      // $6
    job.tenantId ?? null,                                              // $7
    job.idempotencyKey ?? null,                                        // $8
    job.schemaVersion ?? null,                                         // $9
    job.maxRetries,                                                    // $10
    job.attempt,                                                       // $11
    typeof job.backoff === 'function' ? 'custom' : job.backoff,       // $12
    job.backoffBase ?? null,                                           // $13
    job.backoffCap ?? null,                                            // $14
    job.backoffJitter ?? null,                                         // $15
    job.timeout,                                                       // $16
    job.workflowId ?? null,                                            // $17
    job.stepId ?? null,                                                // $18
    job.parentJobId ?? null,                                           // $19
    job.traceId ?? null,                                               // $20
    job.spanId ?? null,                                                // $21
    job.runAt ?? null,                                                 // $22
    job.cron ?? null,                                                  // $23
    job.deadline ?? null,                                              // $24
    job.result != null ? JSON.stringify(job.result) : null,           // $25
    job.error != null ? JSON.stringify(job.error) : null,             // $26
    JSON.stringify(job.meta ?? {}),                                    // $27
    job.createdAt,                                                     // $28
    job.startedAt ?? null,                                             // $29
    job.completedAt ?? null,                                           // $30
  ]
}

const INSERT_JOB_SQL = `
INSERT INTO psyqueue_jobs (
  id, queue, name, payload, status, priority,
  tenant_id, idempotency_key, schema_version,
  max_retries, attempt, backoff, backoff_base, backoff_cap, backoff_jitter,
  timeout, workflow_id, step_id, parent_job_id,
  trace_id, span_id, run_at, cron, deadline,
  result, error, meta,
  created_at, started_at, completed_at
) VALUES (
  $1, $2, $3, $4::jsonb, $5, $6,
  $7, $8, $9,
  $10, $11, $12, $13, $14, $15,
  $16, $17, $18, $19,
  $20, $21, $22, $23, $24,
  $25::jsonb, $26::jsonb, $27::jsonb,
  $28, $29, $30
)
`

export class PostgresBackendAdapter implements BackendAdapter {
  readonly name = 'postgres'
  readonly type = 'postgres'

  private pool: Pool | null = null
  private readonly opts: PostgresAdapterOpts

  constructor(opts: PostgresAdapterOpts = {}) {
    this.opts = opts
  }

  async connect(): Promise<void> {
    if (this.pool) return

    this.pool = new Pool({
      connectionString: this.opts.connectionString,
      host: this.opts.host,
      port: this.opts.port,
      database: this.opts.database,
      user: this.opts.user,
      password: this.opts.password,
      ssl: this.opts.ssl ? { rejectUnauthorized: false } : undefined,
      max: this.opts.max ?? 10,
    })

    // Run schema migrations
    await this.pool.query(SCHEMA_SQL)
  }

  async disconnect(): Promise<void> {
    if (this.pool) {
      await this.pool.end()
      this.pool = null
    }
  }

  async healthCheck(): Promise<boolean> {
    if (!this.pool) return false
    try {
      const result = await this.pool.query('SELECT 1 as ok')
      return result.rows[0]?.ok === 1
    } catch {
      return false
    }
  }

  async enqueue(job: Job): Promise<string> {
    const pool = this.getPool()
    const params = serializeJobParams(job)
    await pool.query(INSERT_JOB_SQL, params)
    return job.id
  }

  async enqueueBulk(jobs: Job[]): Promise<string[]> {
    const pool = this.getPool()
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      for (const job of jobs) {
        const params = serializeJobParams(job)
        await client.query(INSERT_JOB_SQL, params)
      }
      await client.query('COMMIT')
      return jobs.map(j => j.id)
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  async dequeue(queue: string, count: number): Promise<DequeuedJob[]> {
    const pool = this.getPool()
    const client = await pool.connect()
    try {
      await client.query('BEGIN')

      const selectResult = await client.query<JobRow>(
        `SELECT * FROM psyqueue_jobs
         WHERE queue = $1
           AND status = 'pending'
           AND (run_at IS NULL OR run_at <= NOW())
         ORDER BY priority DESC, created_at ASC
         LIMIT $2
         FOR UPDATE SKIP LOCKED`,
        [queue, count],
      )

      if (selectResult.rows.length === 0) {
        await client.query('COMMIT')
        return []
      }

      const results: DequeuedJob[] = []
      const now = new Date()

      for (const row of selectResult.rows) {
        const token = randomUUID()
        await client.query(
          `UPDATE psyqueue_jobs
           SET status = 'active', started_at = $1, completion_token = $2
           WHERE id = $3`,
          [now, token, row.id],
        )
        const job = deserializeJobRow(row)
        results.push({
          ...job,
          status: 'active',
          startedAt: now,
          completionToken: token,
        })
      }

      await client.query('COMMIT')
      return results
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  async ack(jobId: string, completionToken?: string): Promise<AckResult> {
    const pool = this.getPool()
    const now = new Date()

    let result
    if (completionToken) {
      result = await pool.query(
        `UPDATE psyqueue_jobs
         SET status = 'completed', completed_at = $1
         WHERE id = $2 AND completion_token = $3`,
        [now, jobId, completionToken],
      )
      if (result.rowCount === 0) {
        return { alreadyCompleted: true }
      }
    } else {
      result = await pool.query(
        `UPDATE psyqueue_jobs
         SET status = 'completed', completed_at = $1
         WHERE id = $2`,
        [now, jobId],
      )
    }

    return { alreadyCompleted: false }
  }

  async nack(jobId: string, opts?: NackOpts): Promise<void> {
    const pool = this.getPool()

    if (opts?.deadLetter) {
      const errorJson = opts.reason
        ? JSON.stringify({ message: opts.reason, retryable: false })
        : null
      await pool.query(
        `UPDATE psyqueue_jobs SET status = 'dead', error = $1::jsonb WHERE id = $2`,
        [errorJson, jobId],
      )
      return
    }

    if (opts?.requeue === false) {
      const errorJson = opts.reason
        ? JSON.stringify({ message: opts.reason, retryable: false })
        : null
      await pool.query(
        `UPDATE psyqueue_jobs SET status = 'failed', error = $1::jsonb WHERE id = $2`,
        [errorJson, jobId],
      )
      return
    }

    // Default: requeue
    let runAt: Date | null = null
    if (opts?.delay) {
      runAt = new Date(Date.now() + opts.delay)
    }
    await pool.query(
      `UPDATE psyqueue_jobs
       SET status = 'pending', run_at = $1, attempt = attempt + 1
       WHERE id = $2`,
      [runAt, jobId],
    )
  }

  async getJob(jobId: string): Promise<Job | null> {
    const pool = this.getPool()
    const result = await pool.query<JobRow>(
      'SELECT * FROM psyqueue_jobs WHERE id = $1',
      [jobId],
    )
    if (result.rows.length === 0) return null
    return deserializeJobRow(result.rows[0]!)
  }

  async listJobs(filter: JobFilter): Promise<PaginatedResult<Job>> {
    const pool = this.getPool()
    const conditions: string[] = []
    const params: unknown[] = []
    let paramIndex = 1

    if (filter.queue) {
      conditions.push(`queue = $${paramIndex++}`)
      params.push(filter.queue)
    }

    if (filter.status) {
      if (Array.isArray(filter.status)) {
        const placeholders = filter.status.map(() => `$${paramIndex++}`).join(', ')
        conditions.push(`status IN (${placeholders})`)
        params.push(...filter.status)
      } else {
        conditions.push(`status = $${paramIndex++}`)
        params.push(filter.status)
      }
    }

    if (filter.tenantId) {
      conditions.push(`tenant_id = $${paramIndex++}`)
      params.push(filter.tenantId)
    }

    if (filter.name) {
      conditions.push(`name = $${paramIndex++}`)
      params.push(filter.name)
    }

    if (filter.from) {
      conditions.push(`created_at >= $${paramIndex++}`)
      params.push(filter.from)
    }

    if (filter.to) {
      conditions.push(`created_at <= $${paramIndex++}`)
      params.push(filter.to)
    }

    const whereClause = conditions.length > 0
      ? `WHERE ${conditions.join(' AND ')}`
      : ''

    const sortColumn = filter.sortBy === 'priority' ? 'priority'
      : filter.sortBy === 'runAt' ? 'run_at'
      : 'created_at'
    const sortOrder = filter.sortOrder === 'asc' ? 'ASC' : 'DESC'

    const limit = filter.limit ?? 50
    const offset = filter.offset ?? 0

    const countResult = await pool.query<{ total: string }>(
      `SELECT COUNT(*) as total FROM psyqueue_jobs ${whereClause}`,
      params,
    )
    const total = parseInt(countResult.rows[0]?.total ?? '0', 10)

    const dataResult = await pool.query<JobRow>(
      `SELECT * FROM psyqueue_jobs ${whereClause}
       ORDER BY ${sortColumn} ${sortOrder}
       LIMIT $${paramIndex++} OFFSET $${paramIndex++}`,
      [...params, limit, offset],
    )

    return {
      data: dataResult.rows.map(deserializeJobRow),
      total,
      limit,
      offset,
      hasMore: offset + limit < total,
    }
  }

  async scheduleAt(job: Job, runAt: Date): Promise<string> {
    const pool = this.getPool()
    const scheduled = {
      ...job,
      status: 'scheduled' as const,
      runAt,
    }
    const params = serializeJobParams(scheduled)
    await pool.query(INSERT_JOB_SQL, params)
    return job.id
  }

  async pollScheduled(now: Date, limit: number): Promise<Job[]> {
    const pool = this.getPool()
    const client = await pool.connect()
    try {
      await client.query('BEGIN')

      const selectResult = await client.query<JobRow>(
        `SELECT * FROM psyqueue_jobs
         WHERE status = 'scheduled' AND run_at <= $1
         ORDER BY run_at ASC
         LIMIT $2
         FOR UPDATE SKIP LOCKED`,
        [now, limit],
      )

      if (selectResult.rows.length === 0) {
        await client.query('COMMIT')
        return []
      }

      const results: Job[] = []
      for (const row of selectResult.rows) {
        await client.query(
          `UPDATE psyqueue_jobs SET status = 'pending' WHERE id = $1`,
          [row.id],
        )
        const job = deserializeJobRow(row)
        results.push({ ...job, status: 'pending' })
      }

      await client.query('COMMIT')
      return results
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  async acquireLock(key: string, ttlMs: number): Promise<boolean> {
    const pool = this.getPool()
    const now = new Date()
    const expiresAt = new Date(Date.now() + ttlMs)

    // Delete expired lock first
    await pool.query(
      `DELETE FROM psyqueue_locks WHERE key = $1 AND expires_at <= $2`,
      [key, now],
    )

    // Try to insert a new lock
    try {
      await pool.query(
        `INSERT INTO psyqueue_locks (key, expires_at) VALUES ($1, $2)`,
        [key, expiresAt],
      )
      return true
    } catch (err: unknown) {
      // Unique constraint violation = lock already held
      if (isUniqueConstraintError(err)) {
        return false
      }
      throw err
    }
  }

  async releaseLock(key: string): Promise<void> {
    const pool = this.getPool()
    await pool.query(`DELETE FROM psyqueue_locks WHERE key = $1`, [key])
  }

  async atomic(ops: AtomicOp[]): Promise<void> {
    const pool = this.getPool()
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await this._runOps(client, ops)
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  private async _runOps(client: PoolClient, ops: AtomicOp[]): Promise<void> {
    for (const op of ops) {
      switch (op.type) {
        case 'enqueue': {
          const params = serializeJobParams(op.job)
          await client.query(INSERT_JOB_SQL, params)
          break
        }
        case 'ack': {
          const now = new Date()
          await client.query(
            `UPDATE psyqueue_jobs SET status = 'completed', completed_at = $1 WHERE id = $2`,
            [now, op.jobId],
          )
          break
        }
        case 'nack': {
          if (op.opts?.deadLetter) {
            const errorJson = op.opts.reason
              ? JSON.stringify({ message: op.opts.reason, retryable: false })
              : null
            await client.query(
              `UPDATE psyqueue_jobs SET status = 'dead', error = $1::jsonb WHERE id = $2`,
              [errorJson, op.jobId],
            )
          } else if (op.opts?.requeue === false) {
            const errorJson = op.opts.reason
              ? JSON.stringify({ message: op.opts.reason, retryable: false })
              : null
            await client.query(
              `UPDATE psyqueue_jobs SET status = 'failed', error = $1::jsonb WHERE id = $2`,
              [errorJson, op.jobId],
            )
          } else {
            let runAt: Date | null = null
            if (op.opts?.delay) {
              runAt = new Date(Date.now() + op.opts.delay)
            }
            await client.query(
              `UPDATE psyqueue_jobs SET status = 'pending', run_at = $1, attempt = attempt + 1 WHERE id = $2`,
              [runAt, op.jobId],
            )
          }
          break
        }
        case 'update': {
          const sets: string[] = []
          const values: unknown[] = []
          let idx = 1
          const upd = op.updates

          if (upd.status !== undefined) { sets.push(`status = $${idx++}`); values.push(upd.status) }
          if (upd.priority !== undefined) { sets.push(`priority = $${idx++}`); values.push(upd.priority) }
          if (upd.attempt !== undefined) { sets.push(`attempt = $${idx++}`); values.push(upd.attempt) }
          if (upd.result !== undefined) { sets.push(`result = $${idx++}::jsonb`); values.push(JSON.stringify(upd.result)) }
          if (upd.error !== undefined) { sets.push(`error = $${idx++}::jsonb`); values.push(JSON.stringify(upd.error)) }
          if (upd.meta !== undefined) { sets.push(`meta = $${idx++}::jsonb`); values.push(JSON.stringify(upd.meta)) }

          if (sets.length > 0) {
            values.push(op.jobId)
            await client.query(
              `UPDATE psyqueue_jobs SET ${sets.join(', ')} WHERE id = $${idx}`,
              values,
            )
          }
          break
        }
      }
    }
  }

  private getPool(): Pool {
    if (!this.pool) {
      throw new Error('Postgres backend not connected. Call connect() first.')
    }
    return this.pool
  }
}

function isUniqueConstraintError(err: unknown): boolean {
  if (err && typeof err === 'object' && 'code' in err) {
    return (err as { code: string }).code === '23505'
  }
  return false
}
