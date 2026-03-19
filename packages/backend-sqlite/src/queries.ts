import type { JobFilter } from '@psyqueue/core'

export const INSERT_JOB = `
INSERT INTO jobs (
  id, queue, name, payload, status, priority,
  tenant_id, idempotency_key, schema_version,
  max_retries, attempt, backoff, backoff_base, backoff_cap, backoff_jitter,
  timeout, workflow_id, step_id, parent_job_id,
  trace_id, span_id, run_at, cron, deadline,
  result, error, meta, completion_token,
  created_at, started_at, completed_at
) VALUES (
  @id, @queue, @name, @payload, @status, @priority,
  @tenant_id, @idempotency_key, @schema_version,
  @max_retries, @attempt, @backoff, @backoff_base, @backoff_cap, @backoff_jitter,
  @timeout, @workflow_id, @step_id, @parent_job_id,
  @trace_id, @span_id, @run_at, @cron, @deadline,
  @result, @error, @meta, @completion_token,
  @created_at, @started_at, @completed_at
)
`

export const SELECT_JOB_BY_ID = `SELECT * FROM jobs WHERE id = ?`

export const SELECT_FOR_DEQUEUE = `
SELECT id FROM jobs
WHERE queue = ? AND status = 'pending'
ORDER BY priority DESC, created_at ASC
LIMIT ?
`

export const UPDATE_DEQUEUE = `
UPDATE jobs
SET status = 'active', started_at = ?, completion_token = ?
WHERE id = ?
`

export const ACK_WITH_TOKEN = `
UPDATE jobs SET status = 'completed', completed_at = ?
WHERE id = ? AND completion_token = ?
`

export const ACK_WITHOUT_TOKEN = `
UPDATE jobs SET status = 'completed', completed_at = ?
WHERE id = ?
`

export const NACK_DEAD = `
UPDATE jobs SET status = 'dead', error = ?
WHERE id = ?
`

export const NACK_FAILED = `
UPDATE jobs SET status = 'failed', error = ?
WHERE id = ?
`

export const NACK_REQUEUE = `
UPDATE jobs SET status = 'pending', run_at = ?, attempt = attempt + 1
WHERE id = ?
`

export const POLL_SCHEDULED = `
SELECT id FROM jobs
WHERE status = 'scheduled' AND run_at <= ?
ORDER BY run_at ASC
LIMIT ?
`

export const UPDATE_SCHEDULED_TO_PENDING = `
UPDATE jobs SET status = 'pending'
WHERE id = ?
`

export const ACQUIRE_LOCK = `INSERT OR IGNORE INTO locks (key, expires_at) VALUES (?, ?)`

export const DELETE_EXPIRED_LOCK = `DELETE FROM locks WHERE key = ? AND expires_at <= ?`

export const RELEASE_LOCK = `DELETE FROM locks WHERE key = ?`

export interface ListJobsQuery {
  sql: string
  countSql: string
  params: unknown[]
  countParams: unknown[]
}

export function buildListJobsQuery(filter: JobFilter): ListJobsQuery {
  const conditions: string[] = []
  const params: unknown[] = []

  if (filter.queue) {
    conditions.push('queue = ?')
    params.push(filter.queue)
  }

  if (filter.status) {
    if (Array.isArray(filter.status)) {
      const placeholders = filter.status.map(() => '?').join(', ')
      conditions.push(`status IN (${placeholders})`)
      params.push(...filter.status)
    } else {
      conditions.push('status = ?')
      params.push(filter.status)
    }
  }

  if (filter.tenantId) {
    conditions.push('tenant_id = ?')
    params.push(filter.tenantId)
  }

  if (filter.name) {
    conditions.push('name = ?')
    params.push(filter.name)
  }

  if (filter.from) {
    conditions.push('created_at >= ?')
    params.push(filter.from.toISOString())
  }

  if (filter.to) {
    conditions.push('created_at <= ?')
    params.push(filter.to.toISOString())
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

  const sql = `SELECT * FROM jobs ${whereClause} ORDER BY ${sortColumn} ${sortOrder} LIMIT ? OFFSET ?`
  const countSql = `SELECT COUNT(*) as total FROM jobs ${whereClause}`

  return {
    sql,
    countSql,
    params: [...params, limit, offset],
    countParams: [...params],
  }
}
