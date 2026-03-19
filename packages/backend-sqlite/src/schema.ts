export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  queue TEXT NOT NULL,
  name TEXT NOT NULL,
  payload TEXT NOT NULL,
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
  backoff_jitter INTEGER,
  timeout INTEGER NOT NULL DEFAULT 30000,
  workflow_id TEXT,
  step_id TEXT,
  parent_job_id TEXT,
  trace_id TEXT,
  span_id TEXT,
  run_at TEXT,
  cron TEXT,
  deadline TEXT,
  result TEXT,
  error TEXT,
  meta TEXT DEFAULT '{}',
  completion_token TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_jobs_dequeue ON jobs (queue, status, priority DESC, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_jobs_scheduled ON jobs (run_at) WHERE status = 'scheduled';
CREATE INDEX IF NOT EXISTS idx_jobs_tenant ON jobs (tenant_id, queue, status);
CREATE INDEX IF NOT EXISTS idx_jobs_idempotency ON jobs (idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_jobs_workflow ON jobs (workflow_id) WHERE workflow_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs (status);

CREATE TABLE IF NOT EXISTS locks (
  key TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL
);
`
