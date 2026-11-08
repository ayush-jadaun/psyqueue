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
WHERE queue = ? AND status = 'pending' AND (run_at IS NULL OR run_at <= ?)
ORDER BY priority DESC, created_at ASC
LIMIT ?
`

export const UPDATE_DEQUEUE = `
UPDATE jobs
SET status = 'active', started_at = ?, completion_token = ?, heartbeat_at = ?
WHERE id = ?
`

export const ACK_WITH_TOKEN = `
UPDATE jobs SET status = 'completed', completed_at = ?, result = COALESCE(?, result)
WHERE id = ? AND completion_token = ? AND status = 'active'
`

export const ACK_WITHOUT_TOKEN = `
UPDATE jobs SET status = 'completed', completed_at = ?, result = COALESCE(?, result)
WHERE id = ?
`

export const NACK_DEAD = `
UPDATE jobs SET status = 'dead', error = @error
WHERE id = @id AND (@token IS NULL OR (status = 'active' AND completion_token = @token))
`

export const NACK_FAILED = `
UPDATE jobs SET status = 'failed', error = @error
WHERE id = @id AND (@token IS NULL OR (status = 'active' AND completion_token = @token))
`

export const NACK_REQUEUE = `
UPDATE jobs SET status = 'pending', run_at = @run_at, attempt = attempt + 1, completion_token = NULL
WHERE id = @id AND (@token IS NULL OR (status = 'active' AND completion_token = @token))
`

// Reclaim jobs whose worker stopped renewing its lease (crashed/hung).
export const RECOVER_STALE = `
UPDATE jobs SET status = 'pending', completion_token = NULL
WHERE queue = ? AND status = 'active' AND COALESCE(heartbeat_at, 0) < ?
RETURNING id
`

export const EXTEND_LEASE = `
UPDATE jobs SET heartbeat_at = ?
WHERE id = ? AND status = 'active' AND completion_token = ?
`

// Idempotency: free the key if it expired or its job failed/died/was removed,
// then try to claim it. A failed claim means a live duplicate exists.
export const IDEM_RELEASE = `
DELETE FROM idempotency_keys
WHERE queue = ? AND name = ? AND key = ? AND (
  expires_at <= ?
  OR NOT EXISTS (
    SELECT 1 FROM jobs WHERE jobs.id = idempotency_keys.job_id AND jobs.status NOT IN ('failed', 'dead')
  )
)
`
export const IDEM_CLAIM = `INSERT OR IGNORE INTO idempotency_keys (queue, name, key, job_id, expires_at) VALUES (?, ?, ?, ?, ?)`
export const IDEM_LOOKUP = `SELECT job_id FROM idempotency_keys WHERE queue = ? AND name = ? AND key = ?`
export const IDEM_PURGE_EXPIRED = `DELETE FROM idempotency_keys WHERE expires_at <= ?`

// Fair dequeue: rank each tenant's pending jobs (rn = 1, 2, ...) and order all
// candidates by (tenant's active jobs + rn) / weight, i.e. by when each job
// would get its turn under weighted fair queuing. Tenants at max_active are
// excluded. Jobs without a tenant form one more tenant, ''.
// ponytail: ranks every pending job of the queue per call; fine for backlogs
// of tens of thousands, add a per-tenant head index if it gets bigger.
export const SELECT_FAIR_DEQUEUE = `
WITH active AS (
  SELECT COALESCE(tenant_id, '') AS t, COUNT(*) AS c FROM jobs
  WHERE queue = @queue AND status = 'active' GROUP BY 1
),
ranked AS (
  SELECT id, COALESCE(tenant_id, '') AS t, priority, created_at,
    ROW_NUMBER() OVER (PARTITION BY COALESCE(tenant_id, '') ORDER BY priority DESC, created_at ASC) AS rn
  FROM jobs
  WHERE queue = @queue AND status = 'pending' AND (run_at IS NULL OR run_at <= @now)
)
SELECT r.id FROM ranked r
LEFT JOIN active a ON a.t = r.t
LEFT JOIN tenant_policies p ON p.tenant_id = r.t
WHERE p.max_active IS NULL OR COALESCE(a.c, 0) + r.rn <= p.max_active
ORDER BY (COALESCE(a.c, 0) + r.rn) * 1.0 / COALESCE(p.weight, 1) ASC, r.created_at ASC
LIMIT @limit
`

export const UPSERT_TENANT_POLICY = `
INSERT INTO tenant_policies (tenant_id, weight, max_active) VALUES (?, ?, ?)
ON CONFLICT (tenant_id) DO UPDATE SET weight = excluded.weight, max_active = excluded.max_active
`
export const RATE_PRUNE = `DELETE FROM rate_events WHERE key = ? AND ts <= ?`
export const RATE_STATS = `SELECT COUNT(*) AS n, MIN(ts) AS oldest FROM rate_events WHERE key = ?`
export const RATE_INSERT = `INSERT INTO rate_events (key, ts) VALUES (?, ?)`

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
