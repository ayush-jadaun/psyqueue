// eslint-disable-next-line @typescript-eslint/no-require-imports
import RedisModule from 'ioredis'
// Handle ESM/CJS interop — ioredis exports differently depending on context
const Redis = (RedisModule as any).default ?? RedisModule
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

export interface RedisAdapterOpts {
  host?: string
  port?: number
  password?: string
  db?: number
  url?: string
  keyPrefix?: string
}

// Flat string map stored as Redis hash
type JobHash = Record<string, string>

export function serializeJobToHash(job: Job): JobHash {
  // Hot fields stay as individual hash fields for Lua script access
  const hash: JobHash = {
    id: job.id,
    queue: job.queue,
    name: job.name,
    payload: JSON.stringify(job.payload),
    status: job.status,
    priority: String(job.priority),
    attempt: String(job.attempt),
    max_retries: String(job.maxRetries),
    completion_token: '',
    created_at: job.createdAt.toISOString(),
    started_at: job.startedAt ? job.startedAt.toISOString() : '',
    completed_at: job.completedAt ? job.completedAt.toISOString() : '',
  }

  // Cold fields packed into a single _ext JSON blob
  const ext: Record<string, unknown> = {}
  if (job.tenantId != null) ext.tenant_id = job.tenantId
  if (job.idempotencyKey != null) ext.idempotency_key = job.idempotencyKey
  if (job.schemaVersion != null) ext.schema_version = job.schemaVersion
  ext.backoff = typeof job.backoff === 'function' ? 'custom' : job.backoff
  if (job.backoffBase != null) ext.backoff_base = job.backoffBase
  if (job.backoffCap != null) ext.backoff_cap = job.backoffCap
  if (job.backoffJitter != null) ext.backoff_jitter = job.backoffJitter
  ext.timeout = job.timeout
  if (job.workflowId != null) ext.workflow_id = job.workflowId
  if (job.stepId != null) ext.step_id = job.stepId
  if (job.parentJobId != null) ext.parent_job_id = job.parentJobId
  if (job.traceId != null) ext.trace_id = job.traceId
  if (job.spanId != null) ext.span_id = job.spanId
  if (job.runAt) ext.run_at = job.runAt.toISOString()
  if (job.cron != null) ext.cron = job.cron
  if (job.deadline) ext.deadline = job.deadline.toISOString()
  if (job.result != null) ext.result = job.result
  if (job.error != null) ext.error = job.error
  ext.meta = job.meta ?? {}

  hash['_ext'] = JSON.stringify(ext)
  return hash
}

export function deserializeJobFromHash(hash: JobHash): Job {
  // Unpack _ext blob if present (new packed format), fall back to individual fields (legacy)
  const ext: Record<string, unknown> = hash['_ext'] ? JSON.parse(hash['_ext']) : null

  let backoff: BackoffStrategy
  let backoffJitter: boolean | undefined
  let backoffBase: number | undefined
  let backoffCap: number | undefined
  let timeout: number

  if (ext) {
    // New packed format
    const backoffRaw = (ext.backoff as string) ?? 'exponential'
    backoff = (backoffRaw === 'fixed' || backoffRaw === 'exponential' || backoffRaw === 'linear')
      ? backoffRaw : 'exponential'
    backoffJitter = ext.backoff_jitter != null ? Boolean(ext.backoff_jitter) : undefined
    backoffBase = ext.backoff_base != null ? Number(ext.backoff_base) : undefined
    backoffCap = ext.backoff_cap != null ? Number(ext.backoff_cap) : undefined
    timeout = Number(ext.timeout ?? 30000)
  } else {
    // Legacy individual fields
    const backoffRaw = hash['backoff'] ?? 'exponential'
    backoff = (backoffRaw === 'fixed' || backoffRaw === 'exponential' || backoffRaw === 'linear')
      ? backoffRaw : 'exponential'
    const backoffJitterRaw = hash['backoff_jitter']
    backoffJitter = backoffJitterRaw === '1' ? true : backoffJitterRaw === '0' ? false : undefined
    backoffBase = hash['backoff_base'] ? parseInt(hash['backoff_base'], 10) : undefined
    backoffCap = hash['backoff_cap'] ? parseInt(hash['backoff_cap'], 10) : undefined
    timeout = parseInt(hash['timeout'] ?? '30000', 10)
  }

  return {
    id: hash['id'] ?? '',
    queue: hash['queue'] ?? '',
    name: hash['name'] ?? '',
    payload: JSON.parse(hash['payload'] ?? 'null'),
    status: (hash['status'] ?? 'pending') as Job['status'],
    priority: parseInt(hash['priority'] ?? '0', 10),
    tenantId: ext ? (ext.tenant_id as string | undefined) : (hash['tenant_id'] || undefined),
    idempotencyKey: ext ? (ext.idempotency_key as string | undefined) : (hash['idempotency_key'] || undefined),
    schemaVersion: ext
      ? (ext.schema_version != null ? Number(ext.schema_version) : undefined)
      : (hash['schema_version'] ? parseInt(hash['schema_version'], 10) : undefined),
    maxRetries: parseInt(hash['max_retries'] ?? '3', 10),
    attempt: parseInt(hash['attempt'] ?? '1', 10),
    backoff,
    backoffBase,
    backoffCap,
    backoffJitter,
    timeout,
    workflowId: ext ? (ext.workflow_id as string | undefined) : (hash['workflow_id'] || undefined),
    stepId: ext ? (ext.step_id as string | undefined) : (hash['step_id'] || undefined),
    parentJobId: ext ? (ext.parent_job_id as string | undefined) : (hash['parent_job_id'] || undefined),
    traceId: ext ? (ext.trace_id as string | undefined) : (hash['trace_id'] || undefined),
    spanId: ext ? (ext.span_id as string | undefined) : (hash['span_id'] || undefined),
    runAt: ext
      ? (ext.run_at ? new Date(ext.run_at as string) : undefined)
      : (hash['run_at'] ? new Date(hash['run_at']) : undefined),
    cron: ext ? (ext.cron as string | undefined) : (hash['cron'] || undefined),
    deadline: ext
      ? (ext.deadline ? new Date(ext.deadline as string) : undefined)
      : (hash['deadline'] ? new Date(hash['deadline']) : undefined),
    result: ext
      ? (ext.result ?? undefined)
      : (hash['result'] ? JSON.parse(hash['result']) : undefined),
    error: ext
      ? (ext.error as JobError | undefined)
      : (hash['error'] ? JSON.parse(hash['error']) as JobError : undefined),
    meta: ext
      ? ((ext.meta ?? {}) as Record<string, unknown>)
      : (JSON.parse(hash['meta'] ?? '{}') as Record<string, unknown>),
    createdAt: new Date(hash['created_at'] ?? new Date().toISOString()),
    startedAt: hash['started_at'] ? new Date(hash['started_at']) : undefined,
    completedAt: hash['completed_at'] ? new Date(hash['completed_at']) : undefined,
  }
}

// Score for sorted set: lower score = higher priority (dequeue pops lowest score = highest priority)
// We negate priority and add timestamp offset so high-priority + oldest wins
export function computePendingScore(priority: number, createdAt: Date): number {
  // Use negative priority scaled large, add timestamp in seconds as tiebreaker
  // Score formula: (-priority * 1e13) + timestamp_ms
  // Lower score = dequeued first
  return (-priority * 1e13) + createdAt.getTime()
}

// ─── Lua Scripts ──────────────────────────────────────────────────────────────

// Dequeue Lua: RPOP N job IDs from the ready list, activate each one atomically
// KEYS[1] = ready list key
// KEYS[2] = active sorted set key
// KEYS[3] = job hash key prefix
// ARGV[1] = count
// ARGV[2] = started_at ISO string
// Returns: array of [id, token, jsonEncodedHashData, ...] triplets
export const DEQUEUE_SCRIPT = `
local ready_key = KEYS[1]
local active_key = KEYS[2]
local hash_prefix = KEYS[3]
local count = tonumber(ARGV[1])
local started_at = ARGV[2]

local results = {}
local time = redis.call('TIME')

for i = 1, count do
  local id = redis.call('RPOP', ready_key)
  if not id then break end

  local hash_key = hash_prefix .. id
  local exists = redis.call('EXISTS', hash_key)
  if exists == 1 then
    local token = id .. ':' .. time[1] .. time[2]
    redis.call('SADD', active_key, id)
    redis.call('HSET', hash_key, 'status', 'active', 'started_at', started_at, 'completion_token', token)
    local data = redis.call('HGETALL', hash_key)
    table.insert(results, id)
    table.insert(results, token)
    table.insert(results, cjson.encode(data))
  end
end
return results
`

// Activate a single job after BRPOPLPUSH returns its ID
// KEYS[1] = active sorted set key
// KEYS[2] = job hash key
// ARGV[1] = completion token
// ARGV[2] = started_at ISO string
// ARGV[3] = job_id
// Returns: cjson-encoded HGETALL array, or nil if job hash is missing
export const ACTIVATE_SCRIPT = `
local active_key = KEYS[1]
local hash_key = KEYS[2]
local token = ARGV[1]
local started_at = ARGV[2]
local job_id = ARGV[3]

local exists = redis.call('EXISTS', hash_key)
if exists == 0 then return nil end

local t = redis.call('TIME')
redis.call('SADD', active_key, job_id)
redis.call('HSET', hash_key, 'status', 'active', 'started_at', started_at, 'completion_token', token)
return cjson.encode(redis.call('HGETALL', hash_key))
`

// Single-call ack script: reads queue from hash, verifies token, moves to completed
// KEYS[1] = hash key, KEYS[2] = key prefix (e.g. 'psyqueue:')
// ARGV[1] = token, ARGV[2] = completed_at, ARGV[3] = jobId
export const ACK_SCRIPT = `
local hash_key = KEYS[1]
local prefix = KEYS[2]
local token = ARGV[1]
local completed_at = ARGV[2]
local job_id = ARGV[3]

local current_token = redis.call('HGET', hash_key, 'completion_token')
if token ~= '' and current_token ~= token then
  return 0
end

local queue = redis.call('HGET', hash_key, 'queue')
if not queue then return 0 end

redis.call('SREM', prefix .. queue .. ':active', job_id)
redis.call('HSET', hash_key, 'status', 'completed', 'completed_at', completed_at)
return 1
`

// Ack + Fetch-next Lua: ack current job AND dequeue next in one call (3→2 calls/job)
// KEYS[1] = job hash key (current job being acked)
// KEYS[2] = key prefix (e.g. 'psyqueue:')
// KEYS[3] = ready list key (for fetching next)
// KEYS[4] = active set key
// KEYS[5] = job hash prefix
// ARGV[1] = completion token
// ARGV[2] = completed_at
// ARGV[3] = current job id
// Returns: [1, nextJobId, nextToken, nextJobDataJson] or [1] if no next job, or [0] if ack failed
export const ACK_AND_FETCH_SCRIPT = `
local hash_key = KEYS[1]
local prefix = KEYS[2]
local ready_key = KEYS[3]
local active_set = KEYS[4]
local hash_prefix = KEYS[5]
local token = ARGV[1]
local completed_at = ARGV[2]
local job_id = ARGV[3]

-- Step 1: Ack current job
local current_token = redis.call('HGET', hash_key, 'completion_token')
if token ~= '' and current_token ~= token then
  return {0}
end

local queue = redis.call('HGET', hash_key, 'queue')
if not queue then return {0} end

redis.call('SREM', active_set, job_id)
redis.call('HSET', hash_key, 'status', 'completed', 'completed_at', completed_at)

-- Step 2: Fetch next job from ready list
local next_id = redis.call('RPOP', ready_key)
if not next_id then
  return {1}
end

-- Step 3: Activate next job
local next_hash = hash_prefix .. next_id
local exists = redis.call('EXISTS', next_hash)
if exists == 0 then
  return {1}
end

local t = redis.call('TIME')
local next_token = next_id .. ':' .. t[1] .. t[2]
redis.call('SADD', active_set, next_id)
redis.call('HSET', next_hash, 'status', 'active', 'started_at', completed_at, 'completion_token', next_token)
local data = redis.call('HGETALL', next_hash)

return {1, next_id, next_token, cjson.encode(data)}
`

// Nack Lua: handles requeue, dead-letter, fail in one call
// For requeue: pushes job ID back to the ready list (RPUSH) or to pending sorted set if delayed
// KEYS[1] = hash key, KEYS[2] = key prefix
// ARGV[1] = jobId, ARGV[2] = mode (requeue|dead|fail), ARGV[3] = error json
// ARGV[4] = delay ms, ARGV[5] = now ms
export const NACK_SCRIPT = `
local hash_key = KEYS[1]
local prefix = KEYS[2]
local job_id = ARGV[1]
local mode = ARGV[2]
local error_json = ARGV[3]
local delay_ms = tonumber(ARGV[4])
local now_ms = tonumber(ARGV[5])

local queue = redis.call('HGET', hash_key, 'queue')
if not queue then return 0 end

redis.call('SREM', prefix .. queue .. ':active', job_id)

if mode == 'dead' then
  redis.call('HSET', hash_key, 'status', 'dead', 'error', error_json)
  redis.call('ZADD', prefix .. queue .. ':dead', now_ms, job_id)
  return 1
end

if mode == 'fail' then
  redis.call('HSET', hash_key, 'status', 'failed', 'error', error_json)
  return 1
end

-- requeue
local attempt = tonumber(redis.call('HGET', hash_key, 'attempt') or '1')
local new_attempt = attempt + 1
local priority = tonumber(redis.call('HGET', hash_key, 'priority') or '0')

if delay_ms > 0 then
  -- Delayed retry: push to the scheduled sorted set (score = future timestamp)
  local score = now_ms + delay_ms
  local run_at = tostring(score)
  redis.call('HSET', hash_key, 'status', 'pending', 'attempt', tostring(new_attempt), 'run_at', run_at)
  redis.call('ZADD', prefix .. 'scheduled', score, job_id)
  return 1
end

-- Immediate retry: push directly to the ready list
redis.call('HSET', hash_key, 'status', 'pending', 'attempt', tostring(new_attempt), 'run_at', '')
if priority > 0 then
  -- High-priority requeues go to the front of the ready list
  redis.call('LPUSH', prefix .. queue .. ':ready', job_id)
else
  redis.call('RPUSH', prefix .. queue .. ':ready', job_id)
end
return 1
`

// Promote Lua: pop items from the priority sorted set and LPUSH to the front of the ready list
// KEYS[1] = priority sorted set key
// KEYS[2] = ready list key
// ARGV[1] = count (how many to promote)
// Returns: number promoted
export const PROMOTE_SCRIPT = `
local priority_key = KEYS[1]
local ready_key = KEYS[2]
local count = tonumber(ARGV[1])

local ids = redis.call('ZPOPMIN', priority_key, count)
if #ids == 0 then return 0 end

local promoted = 0
for i = 1, #ids, 2 do
  local id = ids[i]
  -- LPUSH to front of list so priority jobs are dequeued before normal jobs
  redis.call('LPUSH', ready_key, id)
  promoted = promoted + 1
end
return promoted
`

// Enqueue with priority: ZADD to priority sorted set + immediately promote all to ready list
// KEYS[1] = priority sorted set key
// KEYS[2] = ready list key
// ARGV[1] = score
// ARGV[2] = job_id
// Returns: number promoted
export const ENQUEUE_PRIORITY_SCRIPT = `
local priority_key = KEYS[1]
local ready_key = KEYS[2]
local score = tonumber(ARGV[1])
local job_id = ARGV[2]

redis.call('ZADD', priority_key, score, job_id)

-- Promote all from priority set to front of ready list (maintains priority order)
local ids = redis.call('ZPOPMIN', priority_key, 100)
local promoted = 0
for i = 1, #ids, 2 do
  local id = ids[i]
  redis.call('LPUSH', ready_key, id)
  promoted = promoted + 1
end
return promoted
`

// Poll scheduled: move due jobs from scheduled set to the ready list
// KEYS[1] = scheduled sorted set key
// KEYS[2] = ready list key (for priority=0 jobs)
// KEYS[3] = hash prefix
// KEYS[4] = priority sorted set prefix (e.g. 'psyqueue:')
// ARGV[1] = current timestamp (ms)
// ARGV[2] = limit
// Returns: array of job ids moved
export const POLL_SCHEDULED_SCRIPT = `
local scheduled_key = KEYS[1]
local hash_prefix = KEYS[2]
local prefix = KEYS[3]
local now_ms = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])

local ids = redis.call('ZRANGEBYSCORE', scheduled_key, '-inf', now_ms, 'LIMIT', 0, limit)
if #ids == 0 then
  return {}
end

for _, id in ipairs(ids) do
  redis.call('ZREM', scheduled_key, id)
  local hash_key = hash_prefix .. id
  local priority = tonumber(redis.call('HGET', hash_key, 'priority')) or 0
  local queue = redis.call('HGET', hash_key, 'queue') or 'default'
  redis.call('HSET', hash_key, 'status', 'pending')

  local ready_key = prefix .. queue .. ':ready'
  if priority > 0 then
    -- Priority jobs: ZADD to priority sorted set, then promote to front of ready list
    local created_at_str = redis.call('HGET', hash_key, 'created_at')
    local score = (-priority * 10000000000000) + now_ms
    local pkey = prefix .. queue .. ':priority'
    redis.call('ZADD', pkey, score, id)
    -- Promote all from priority set
    local pids = redis.call('ZPOPMIN', pkey, 100)
    for pi = 1, #pids, 2 do
      redis.call('LPUSH', ready_key, pids[pi])
    end
  else
    redis.call('RPUSH', ready_key, id)
  end
end
return ids
`

// Batch activate script (used after BRPOPLPUSH + batch pop)
// KEYS[1] = active sorted set key
// KEYS[2..N] = job hash keys
// ARGV[1] = started_at ISO string
// ARGV[2..N] = completion tokens (one per job)
// Returns: array of [token, cjson(HGETALL)] pairs
export const BATCH_ACTIVATE_SCRIPT = `
local active_key = KEYS[1]
local started_at = ARGV[1]
local t = redis.call('TIME')
local results = {}

for i = 2, #KEYS do
  local hash_key = KEYS[i]
  local token = ARGV[i]
  local job_id = redis.call('HGET', hash_key, 'id')
  if job_id then
    redis.call('SADD', active_key, job_id)
    redis.call('HSET', hash_key, 'status', 'active', 'started_at', started_at, 'completion_token', token)
    table.insert(results, token)
    table.insert(results, cjson.encode(redis.call('HGETALL', hash_key)))
  end
end
return results
`

export class RedisBackendAdapter implements BackendAdapter {
  readonly name = 'redis'
  readonly type = 'redis'
  readonly supportsBlocking = true

  private client: any = null
  /** Single blocking client -- created once, reused for all BRPOPLPUSH calls */
  private blockingClient: any = null
  private readonly opts: RedisAdapterOpts
  private readonly prefix: string

  constructor(opts: RedisAdapterOpts = {}) {
    this.opts = opts
    this.prefix = opts.keyPrefix ?? 'psyqueue'
  }

  private keyPrefix(): string {
    return `${this.prefix}:`
  }

  private jobKey(id: string): string {
    return `${this.prefix}:job:${id}`
  }

  /** Ready list — main dequeue source (LIST) */
  private readyKey(queue: string): string {
    return `${this.prefix}:${queue}:ready`
  }

  /** Priority sorted set — only used for priority > 0 jobs before promotion to ready list */
  private priorityKey(queue: string): string {
    return `${this.prefix}:${queue}:priority`
  }

  /** @internal Kept for test key-naming assertions */
  // @ts-expect-error TS6133: pendingKey is accessed by tests via cast
  private pendingKey(queue: string): string {
    return `${this.prefix}:${queue}:pending`
  }

  private activeKey(queue: string): string {
    return `${this.prefix}:${queue}:active`
  }

  /** Processing list — BRPOPLPUSH destination for in-flight tracking */
  private processingKey(queue: string): string {
    return `${this.prefix}:${queue}:processing`
  }

  private scheduledKey(): string {
    return `${this.prefix}:scheduled`
  }

  private lockKey(key: string): string {
    return `${this.prefix}:lock:${key}`
  }

  private jobHashPrefix(): string {
    return `${this.prefix}:job:`
  }

  async connect(): Promise<void> {
    if (this.client) return

    if (this.opts.url) {
      this.client = new Redis(this.opts.url)
    } else {
      this.client = new Redis({
        host: this.opts.host ?? 'localhost',
        port: this.opts.port ?? 6379,
        password: this.opts.password,
        db: this.opts.db ?? 0,
      })
    }

    // Wait for ready
    await new Promise<void>((resolve, reject) => {
      const client = this.client!
      const onReady = () => { client.off('error', onError); resolve() }
      const onError = (err: Error) => { client.off('ready', onReady); reject(err) }
      client.once('ready', onReady)
      client.once('error', onError)
      if (client.status === 'ready') resolve()
    })
  }

  async disconnect(): Promise<void> {
    // Close the single blocking client first
    if (this.blockingClient) {
      await this.blockingClient.quit().catch(() => {})
      this.blockingClient = null
    }

    if (this.client) {
      await this.client.quit()
      this.client = null
    }
  }

  async healthCheck(): Promise<boolean> {
    if (!this.client) return false
    try {
      const result = await this.client.ping()
      return result === 'PONG'
    } catch {
      return false
    }
  }

  async enqueue(job: Job): Promise<string> {
    const client = this.getClient()
    const hash = serializeJobToHash(job)

    if (job.priority > 0) {
      // Priority path: HSET + ZADD to priority sorted set + promote to ready list
      const score = computePendingScore(job.priority, job.createdAt)
      const pipeline = client.pipeline()
      pipeline.hset(this.jobKey(job.id), hash)
      pipeline.eval(
        ENQUEUE_PRIORITY_SCRIPT,
        2,
        this.priorityKey(job.queue),
        this.readyKey(job.queue),
        String(score),
        job.id,
      )
      await pipeline.exec()
    } else {
      // Fast path (priority=0): HSET + RPUSH job ID to ready list
      const pipeline = client.pipeline()
      pipeline.hset(this.jobKey(job.id), hash)
      pipeline.rpush(this.readyKey(job.queue), job.id)
      await pipeline.exec()
    }

    return job.id
  }

  async enqueueBulk(jobs: Job[]): Promise<string[]> {
    const client = this.getClient()
    const pipeline = client.pipeline()

    // Group jobs by queue for batching RPUSH calls
    const readyPushes = new Map<string, string[]>()
    const priorityJobs: Job[] = []

    for (const job of jobs) {
      const hash = serializeJobToHash(job)
      pipeline.hset(this.jobKey(job.id), hash)

      if (job.priority > 0) {
        priorityJobs.push(job)
      } else {
        const key = this.readyKey(job.queue)
        if (!readyPushes.has(key)) readyPushes.set(key, [])
        readyPushes.get(key)!.push(job.id)
      }
    }

    // Batch RPUSH for all normal-priority jobs per queue
    for (const [key, ids] of readyPushes) {
      pipeline.rpush(key, ...ids)
    }

    // Priority jobs: ZADD + promote for each
    for (const job of priorityJobs) {
      const score = computePendingScore(job.priority, job.createdAt)
      pipeline.eval(
        ENQUEUE_PRIORITY_SCRIPT,
        2,
        this.priorityKey(job.queue),
        this.readyKey(job.queue),
        String(score),
        job.id,
      )
    }

    await pipeline.exec()
    return jobs.map(j => j.id)
  }

  async dequeue(queue: string, count: number): Promise<DequeuedJob[]> {
    const client = this.getClient()
    const startedAt = new Date().toISOString()

    // Single Lua call: RPOP N from ready list + activate each
    const results = await client.eval(
      DEQUEUE_SCRIPT,
      3,
      this.readyKey(queue),
      this.activeKey(queue),
      this.jobHashPrefix(),
      String(count),
      startedAt,
    ) as string[] | null

    if (!results || results.length === 0) return []

    const dequeued: DequeuedJob[] = []
    // Results come in triplets: [id, token, jsonEncodedHashData, id, token, ...]
    for (let i = 0; i < results.length; i += 3) {
      const id = results[i]
      const token = results[i + 1]
      const rawData = results[i + 2]
      if (!id || !token || !rawData) continue

      // Parse the HGETALL result returned inline from Lua (array of key,value pairs)
      const dataArray: string[] = JSON.parse(rawData)
      const hashData: Record<string, string> = {}
      for (let j = 0; j < dataArray.length; j += 2) {
        hashData[dataArray[j]!] = dataArray[j + 1]!
      }

      const job = deserializeJobFromHash(hashData)
      dequeued.push({ ...job, completionToken: token })
    }

    return dequeued
  }

  async ack(jobId: string, completionToken?: string): Promise<AckResult> {
    const client = this.getClient()
    const completedAt = new Date().toISOString()

    // Single Lua call — reads queue from hash, no extra round-trip
    const result = await client.eval(
      ACK_SCRIPT,
      2,
      this.jobKey(jobId),
      this.keyPrefix(),
      completionToken ?? '',
      completedAt,
      jobId,
    ) as number

    return { alreadyCompleted: result === 0 }
  }

  async ackAndFetch(jobId: string, completionToken: string | undefined, queue: string): Promise<{ ackResult: AckResult; nextJob: DequeuedJob | null }> {
    const client = this.getClient()
    const completedAt = new Date().toISOString()

    const result = await client.eval(
      ACK_AND_FETCH_SCRIPT,
      5,
      this.jobKey(jobId),
      this.keyPrefix(),
      this.readyKey(queue),
      this.activeKey(queue),
      this.jobHashPrefix(),
      completionToken ?? '',
      completedAt,
      jobId,
    ) as unknown[]

    if (!result || result[0] === 0) {
      return { ackResult: { alreadyCompleted: true }, nextJob: null }
    }

    // result[0] = 1 (ack success)
    // result[1] = nextJobId (optional)
    // result[2] = nextToken (optional)
    // result[3] = nextJobDataJson (optional)
    if (result.length < 4 || !result[1] || !result[2] || !result[3]) {
      return { ackResult: { alreadyCompleted: false }, nextJob: null }
    }

    const nextToken = result[2] as string
    const rawData = result[3] as string

    const dataArray: string[] = JSON.parse(rawData)
    const hashData: Record<string, string> = {}
    for (let j = 0; j < dataArray.length; j += 2) {
      hashData[dataArray[j]!] = dataArray[j + 1]!
    }

    const job = deserializeJobFromHash(hashData)
    return {
      ackResult: { alreadyCompleted: false },
      nextJob: { ...job, completionToken: nextToken },
    }
  }

  async nack(jobId: string, opts?: NackOpts): Promise<void> {
    const client = this.getClient()

    // Single Lua call handles all nack variants: requeue, dead-letter, or fail
    const mode = opts?.deadLetter ? 'dead' : (opts?.requeue === false ? 'fail' : 'requeue')
    const error = opts?.reason ? JSON.stringify({ message: opts.reason, retryable: false }) : ''
    const delay = opts?.delay ?? 0

    await client.eval(
      NACK_SCRIPT,
      2,
      this.jobKey(jobId),
      this.keyPrefix(),
      jobId,
      mode,
      error,
      String(delay),
      String(Date.now()),
    )
  }

  async getJob(jobId: string): Promise<Job | null> {
    const client = this.getClient()
    const hashData = await client.hgetall(this.jobKey(jobId))
    if (!hashData || Object.keys(hashData).length === 0) return null
    return deserializeJobFromHash(hashData)
  }

  async listJobs(filter: JobFilter): Promise<PaginatedResult<Job>> {
    const client = this.getClient()
    const limit = filter.limit ?? 50
    const offset = filter.offset ?? 0

    // SCAN all job keys and filter in memory
    const allJobs: Job[] = []
    let cursor = '0'

    do {
      const [nextCursor, keys] = await client.scan(cursor, 'MATCH', `${this.prefix}:job:*`, 'COUNT', 100)
      cursor = nextCursor

      for (const key of keys) {
        const hashData = await client.hgetall(key)
        if (!hashData || Object.keys(hashData).length === 0) continue

        const job = deserializeJobFromHash(hashData)

        // Apply filters
        if (filter.queue && job.queue !== filter.queue) continue
        if (filter.tenantId && job.tenantId !== filter.tenantId) continue
        if (filter.name && job.name !== filter.name) continue
        if (filter.status) {
          if (Array.isArray(filter.status)) {
            if (!filter.status.includes(job.status)) continue
          } else {
            if (job.status !== filter.status) continue
          }
        }
        if (filter.from && job.createdAt < filter.from) continue
        if (filter.to && job.createdAt > filter.to) continue

        allJobs.push(job)
      }
    } while (cursor !== '0')

    // Sort
    const sortBy = filter.sortBy ?? 'createdAt'
    const sortOrder = filter.sortOrder ?? 'desc'

    allJobs.sort((a, b) => {
      let aVal: number
      let bVal: number

      if (sortBy === 'priority') {
        aVal = a.priority
        bVal = b.priority
      } else if (sortBy === 'runAt') {
        aVal = a.runAt?.getTime() ?? 0
        bVal = b.runAt?.getTime() ?? 0
      } else {
        aVal = a.createdAt.getTime()
        bVal = b.createdAt.getTime()
      }

      return sortOrder === 'asc' ? aVal - bVal : bVal - aVal
    })

    const total = allJobs.length
    const data = allJobs.slice(offset, offset + limit)

    return {
      data,
      total,
      limit,
      offset,
      hasMore: offset + limit < total,
    }
  }

  async scheduleAt(job: Job, runAt: Date): Promise<string> {
    const client = this.getClient()
    const scheduled = {
      ...job,
      status: 'scheduled' as const,
      runAt,
    }

    const hash = serializeJobToHash(scheduled)
    const pipeline = client.pipeline()
    pipeline.hset(this.jobKey(job.id), hash)
    pipeline.zadd(this.scheduledKey(), runAt.getTime(), job.id)
    await pipeline.exec()

    return job.id
  }

  async pollScheduled(now: Date, limit: number): Promise<Job[]> {
    return this._pollScheduledImpl(now, limit)
  }

  private async _pollScheduledImpl(now: Date, limit: number): Promise<Job[]> {
    const client = this.getClient()

    // Single Lua call: move due jobs from scheduled set → ready list
    const ids = await client.eval(
      POLL_SCHEDULED_SCRIPT,
      3,
      this.scheduledKey(),
      this.jobHashPrefix(),
      this.keyPrefix(),
      String(now.getTime()),
      String(limit),
    ) as string[]

    if (!ids || ids.length === 0) return []

    // Fetch the updated job data for the return value
    const results: Job[] = []
    for (const id of ids) {
      const hashData = await client.hgetall(this.jobKey(id))
      if (!hashData || Object.keys(hashData).length === 0) continue
      results.push(deserializeJobFromHash(hashData))
    }

    return results
  }

  async acquireLock(key: string, ttlMs: number): Promise<boolean> {
    const client = this.getClient()
    const result = await client.set(this.lockKey(key), '1', 'NX', 'PX', ttlMs)
    return result === 'OK'
  }

  async releaseLock(key: string): Promise<void> {
    const client = this.getClient()
    await client.del(this.lockKey(key))
  }

  async atomic(ops: AtomicOp[]): Promise<void> {
    // Process ops sequentially — Redis pipelines don't support conditional logic
    // For true atomicity across complex ops, Lua scripts would be needed per use case
    for (const op of ops) {
      switch (op.type) {
        case 'enqueue':
          await this.enqueue(op.job)
          break
        case 'ack':
          await this.ack(op.jobId)
          break
        case 'nack':
          await this.nack(op.jobId, op.opts)
          break
        case 'update': {
          const client = this.getClient()
          const updates: string[] = []
          const { updates: upd } = op

          if (upd.status !== undefined) updates.push('status', upd.status)
          if (upd.priority !== undefined) updates.push('priority', String(upd.priority))
          if (upd.attempt !== undefined) updates.push('attempt', String(upd.attempt))
          if (upd.result !== undefined) updates.push('result', JSON.stringify(upd.result))
          if (upd.error !== undefined) updates.push('error', JSON.stringify(upd.error))
          if (upd.meta !== undefined) updates.push('meta', JSON.stringify(upd.meta))

          if (updates.length > 0) {
            await client.hset(this.jobKey(op.jobId), ...updates)
          }
          break
        }
      }
    }
  }

  async blockingDequeue(queue: string, timeoutMs: number): Promise<DequeuedJob[]> {
    // Create ONE blocking client on first call, then reuse it forever
    if (!this.blockingClient) {
      this.blockingClient = await this.createBlockingClient()
    }
    const blockingClient = this.blockingClient
    const commandClient = this.getClient()

    const timeoutSec = Math.max(1, Math.ceil(timeoutMs / 1000))

    let jobId: string | null = null
    try {
      // BRPOPLPUSH: pop from ready list, push to processing list
      // Returns the job ID string (the value that was in the list), or null on timeout
      jobId = await blockingClient.brpoplpush(
        this.readyKey(queue),
        this.processingKey(queue),
        timeoutSec,
      )
    } catch {
      return []
    }

    // null on timeout
    if (!jobId) return []

    const token = `${jobId}:${Date.now()}`
    const startedAt = new Date().toISOString()

    // Activate the job using the command client (non-blocking) — 1 Lua call
    const rawData = await commandClient.eval(
      ACTIVATE_SCRIPT,
      2,
      this.activeKey(queue),
      this.jobKey(jobId),
      token,
      startedAt,
      jobId,
    ) as string | null

    if (!rawData) return []

    // Clean up from processing list
    commandClient.lrem(this.processingKey(queue), 1, jobId).catch(() => {})

    const dataArray: string[] = JSON.parse(rawData)
    const hashData: Record<string, string> = {}
    for (let j = 0; j < dataArray.length; j += 2) {
      hashData[dataArray[j]!] = dataArray[j + 1]!
    }

    const job = deserializeJobFromHash(hashData)
    return [{ ...job, completionToken: token }]
  }

  async batchDequeue(queue: string, count: number): Promise<DequeuedJob[]> {
    // Non-blocking batch dequeue: just use the existing dequeue (single Lua RPOP N)
    return this.dequeue(queue, count)
  }

  async ackBatch(items: Array<{ jobId: string; completionToken?: string }>): Promise<AckResult[]> {
    const client = this.getClient()
    const pipeline = client.pipeline()

    for (const item of items) {
      pipeline.eval(
        ACK_SCRIPT,
        2,
        this.jobKey(item.jobId),
        this.keyPrefix(),
        item.completionToken ?? '',
        new Date().toISOString(),
        item.jobId,
      )
    }

    const results = await pipeline.exec()
    return results!.map(([err, val]: [Error | null, unknown]) => ({
      alreadyCompleted: err != null || val === 0,
    }))
  }

  private async createBlockingClient(): Promise<any> {
    let client: any
    if (this.opts.url) {
      client = new Redis(this.opts.url)
    } else {
      client = new Redis({
        host: this.opts.host ?? 'localhost',
        port: this.opts.port ?? 6379,
        password: this.opts.password,
        db: this.opts.db ?? 0,
      })
    }

    // Wait for ready
    await new Promise<void>((resolve, reject) => {
      const onReady = () => { client.off('error', onError); resolve() }
      const onError = (err: Error) => { client.off('ready', onReady); reject(err) }
      client.once('ready', onReady)
      client.once('error', onError)
      if (client.status === 'ready') resolve()
    })

    return client
  }

  private getClient(): any {
    if (!this.client) {
      throw new Error('Redis backend not connected. Call connect() first.')
    }
    return this.client
  }
}
