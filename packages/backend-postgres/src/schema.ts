export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS psyqueue_jobs (
  id TEXT PRIMARY KEY,
  queue TEXT NOT NULL,
  name TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  priority INTEGER NOT NULL DEFAULT 0,
  tenant_id TEXT,
  idempotency_key TEXT,
  schema_version INTEGER,
  max_retries INTEGER NOT NULL DEFAULT 3,
  attempt INTEGER NOT NULL DEFAULT 1,
  backoff TEXT NOT NULL DEFAULT 'exponential',
  backoff_base INTEGER,
  backoff_cap INTEGER,
  backoff_jitter BOOLEAN,
  timeout INTEGER NOT NULL DEFAULT 30000,
  workflow_id TEXT,
  step_id TEXT,
  parent_job_id TEXT,
  trace_id TEXT,
  span_id TEXT,
  run_at TIMESTAMPTZ,
  cron TEXT,
  deadline TIMESTAMPTZ,
  result JSONB,
  error JSONB,
  meta JSONB NOT NULL DEFAULT '{}',
  completion_token TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_psyqueue_jobs_dequeue
  ON psyqueue_jobs (queue, status, priority DESC, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_psyqueue_jobs_scheduled
  ON psyqueue_jobs (run_at)
  WHERE status = 'scheduled';

CREATE INDEX IF NOT EXISTS idx_psyqueue_jobs_tenant
  ON psyqueue_jobs (tenant_id, queue, status);

CREATE INDEX IF NOT EXISTS idx_psyqueue_jobs_idempotency
  ON psyqueue_jobs (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_psyqueue_jobs_workflow
  ON psyqueue_jobs (workflow_id)
  WHERE workflow_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_psyqueue_jobs_status
  ON psyqueue_jobs (status);

-- Lease heartbeat (added after initial release; ADD COLUMN IF NOT EXISTS migrates old DBs)
ALTER TABLE psyqueue_jobs ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMPTZ;

-- Idempotency keys: one live job per (queue, name + key). Checked and claimed
-- in the same transaction as the job insert.
CREATE TABLE IF NOT EXISTS psyqueue_idempotency_keys (
  queue TEXT NOT NULL,
  name TEXT NOT NULL,
  key TEXT NOT NULL,
  job_id TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (queue, name, key)
);
CREATE INDEX IF NOT EXISTS idx_psyqueue_idempotency_expires ON psyqueue_idempotency_keys (expires_at);

-- Multi-tenancy: scheduling policy per tenant, and a sliding-window rate log
CREATE TABLE IF NOT EXISTS psyqueue_tenant_policies (
  tenant_id TEXT PRIMARY KEY,
  weight DOUBLE PRECISION NOT NULL DEFAULT 1,
  max_active INTEGER
);
CREATE TABLE IF NOT EXISTS psyqueue_rate_events (
  key TEXT NOT NULL,
  ts TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_psyqueue_rate_events ON psyqueue_rate_events (key, ts);

CREATE TABLE IF NOT EXISTS psyqueue_locks (
  key TEXT PRIMARY KEY,
  expires_at TIMESTAMPTZ NOT NULL,
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`
