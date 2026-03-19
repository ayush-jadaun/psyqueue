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
  return {
    id: job.id,
    queue: job.queue,
    name: job.name,
    payload: JSON.stringify(job.payload),
    status: job.status,
    priority: String(job.priority),
    tenant_id: job.tenantId ?? '',
    idempotency_key: job.idempotencyKey ?? '',
    schema_version: job.schemaVersion != null ? String(job.schemaVersion) : '',
    max_retries: String(job.maxRetries),
    attempt: String(job.attempt),
    backoff: typeof job.backoff === 'function' ? 'custom' : job.backoff,
    backoff_base: job.backoffBase != null ? String(job.backoffBase) : '',
    backoff_cap: job.backoffCap != null ? String(job.backoffCap) : '',
    backoff_jitter: job.backoffJitter != null ? (job.backoffJitter ? '1' : '0') : '',
    timeout: String(job.timeout),
    workflow_id: job.workflowId ?? '',
    step_id: job.stepId ?? '',
    parent_job_id: job.parentJobId ?? '',
    trace_id: job.traceId ?? '',
    span_id: job.spanId ?? '',
    run_at: job.runAt ? job.runAt.toISOString() : '',
    cron: job.cron ?? '',
    deadline: job.deadline ? job.deadline.toISOString() : '',
    result: job.result != null ? JSON.stringify(job.result) : '',
    error: job.error != null ? JSON.stringify(job.error) : '',
    meta: JSON.stringify(job.meta ?? {}),
    completion_token: '',
    created_at: job.createdAt.toISOString(),
    started_at: job.startedAt ? job.startedAt.toISOString() : '',
    completed_at: job.completedAt ? job.completedAt.toISOString() : '',
  }
}

export function deserializeJobFromHash(hash: JobHash): Job {
  const backoffRaw = hash['backoff'] ?? 'exponential'
  const backoff: BackoffStrategy = (backoffRaw === 'fixed' || backoffRaw === 'exponential' || backoffRaw === 'linear')
    ? backoffRaw
    : 'exponential'

  const backoffJitterRaw = hash['backoff_jitter']
  const backoffJitter = backoffJitterRaw === '1' ? true : backoffJitterRaw === '0' ? false : undefined

  return {
    id: hash['id'] ?? '',
    queue: hash['queue'] ?? '',
    name: hash['name'] ?? '',
    payload: JSON.parse(hash['payload'] ?? 'null'),
    status: (hash['status'] ?? 'pending') as Job['status'],
    priority: parseInt(hash['priority'] ?? '0', 10),
    tenantId: hash['tenant_id'] || undefined,
    idempotencyKey: hash['idempotency_key'] || undefined,
    schemaVersion: hash['schema_version'] ? parseInt(hash['schema_version'], 10) : undefined,
    maxRetries: parseInt(hash['max_retries'] ?? '3', 10),
    attempt: parseInt(hash['attempt'] ?? '1', 10),
    backoff,
    backoffBase: hash['backoff_base'] ? parseInt(hash['backoff_base'], 10) : undefined,
    backoffCap: hash['backoff_cap'] ? parseInt(hash['backoff_cap'], 10) : undefined,
    backoffJitter,
    timeout: parseInt(hash['timeout'] ?? '30000', 10),
    workflowId: hash['workflow_id'] || undefined,
    stepId: hash['step_id'] || undefined,
    parentJobId: hash['parent_job_id'] || undefined,
    traceId: hash['trace_id'] || undefined,
    spanId: hash['span_id'] || undefined,
    runAt: hash['run_at'] ? new Date(hash['run_at']) : undefined,
    cron: hash['cron'] || undefined,
    deadline: hash['deadline'] ? new Date(hash['deadline']) : undefined,
    result: hash['result'] ? JSON.parse(hash['result']) : undefined,
    error: hash['error'] ? JSON.parse(hash['error']) as JobError : undefined,
    meta: JSON.parse(hash['meta'] ?? '{}') as Record<string, unknown>,
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

// Lua script for atomic dequeue
// KEYS[1] = pending sorted set key
// KEYS[2] = active set key
// KEYS[3] = job hash key prefix (we pass just the prefix, script appends the id)
// ARGV[1] = count
// ARGV[2] = started_at ISO string
// Returns: array of [id, token, id, token, ...] pairs (flattened)
export const DEQUEUE_SCRIPT = `
local pending_key = KEYS[1]
local active_key = KEYS[2]
local hash_prefix = KEYS[3]
local count = tonumber(ARGV[1])
local started_at = ARGV[2]

local ids = redis.call('ZRANGE', pending_key, 0, count - 1)
if #ids == 0 then
  return {}
end

local results = {}
local time = redis.call('TIME')
for _, id in ipairs(ids) do
  local token = id .. ':' .. time[1] .. time[2]
  redis.call('ZREM', pending_key, id)
  redis.call('ZADD', active_key, time[1], id)
  local hash_key = hash_prefix .. id
  redis.call('HSET', hash_key, 'status', 'active', 'started_at', started_at, 'completion_token', token)
  -- Return full job data inline (avoids extra HGETALL round-trip)
  local data = redis.call('HGETALL', hash_key)
  table.insert(results, id)
  table.insert(results, token)
  table.insert(results, cjson.encode(data))
end
return results
`

// Lua script for atomic ack
// KEYS[1] = active set key
// KEYS[2] = completed set key
// KEYS[3] = job hash key
// ARGV[1] = completion token (or '' to skip check)
// ARGV[2] = completed_at ISO string
// Returns: 0 = already completed (token mismatch), 1 = success
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

redis.call('ZREM', prefix .. queue .. ':active', job_id)
redis.call('ZADD', prefix .. queue .. ':completed', redis.call('TIME')[1], job_id)
redis.call('HSET', hash_key, 'status', 'completed', 'completed_at', completed_at)
return 1
`

// Single Lua script for nack — handles requeue, dead-letter, fail in one call
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

redis.call('ZREM', prefix .. queue .. ':active', job_id)

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

local score
local run_at = ''
if delay_ms > 0 then
  score = now_ms + delay_ms
  run_at = tostring(score)
else
  score = -priority * 10000000000000 + now_ms
end

redis.call('HSET', hash_key, 'status', 'pending', 'attempt', tostring(new_attempt), 'run_at', run_at)
redis.call('ZADD', prefix .. queue .. ':pending', score, job_id)
return 1
`

// Lua script for pollScheduled
// KEYS[1] = scheduled sorted set key
// KEYS[2] = pending sorted set key
// KEYS[3] = hash prefix
// ARGV[1] = current timestamp (ms)
// ARGV[2] = limit
// Returns: array of job ids moved to pending
export const POLL_SCHEDULED_SCRIPT = `
local scheduled_key = KEYS[1]
local pending_key = KEYS[2]
local hash_prefix = KEYS[3]
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
  local created_at_str = redis.call('HGET', hash_key, 'created_at')
  -- Use current time as fallback score
  local score = (-priority * 10000000000000) + now_ms
  redis.call('ZADD', pending_key, score, id)
  redis.call('HSET', hash_key, 'status', 'pending')
end
return ids
`

export class RedisBackendAdapter implements BackendAdapter {
  readonly name = 'redis'
  readonly type = 'redis'

  private client: any = null
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

  private pendingKey(queue: string): string {
    return `${this.prefix}:${queue}:pending`
  }

  private activeKey(queue: string): string {
    return `${this.prefix}:${queue}:active`
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
    const score = computePendingScore(job.priority, job.createdAt)

    const pipeline = client.pipeline()
    pipeline.hset(this.jobKey(job.id), hash)
    pipeline.zadd(this.pendingKey(job.queue), score, job.id)
    await pipeline.exec()

    return job.id
  }

  async enqueueBulk(jobs: Job[]): Promise<string[]> {
    const client = this.getClient()
    const pipeline = client.pipeline()

    for (const job of jobs) {
      const hash = serializeJobToHash(job)
      const score = computePendingScore(job.priority, job.createdAt)
      pipeline.hset(this.jobKey(job.id), hash)
      pipeline.zadd(this.pendingKey(job.queue), score, job.id)
    }

    await pipeline.exec()
    return jobs.map(j => j.id)
  }

  async dequeue(queue: string, count: number): Promise<DequeuedJob[]> {
    const client = this.getClient()
    const startedAt = new Date().toISOString()

    const results = await client.eval(
      DEQUEUE_SCRIPT,
      3,
      this.pendingKey(queue),
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

    // Get due job IDs from the scheduled set
    const ids = await client.zrangebyscore(this.scheduledKey(), '-inf', now.getTime(), 'LIMIT', 0, limit)
    if (ids.length === 0) return []

    const results: Job[] = []
    for (const id of ids) {
      const hashData = await client.hgetall(this.jobKey(id))
      if (!hashData || Object.keys(hashData).length === 0) continue

      const job = deserializeJobFromHash(hashData)
      const score = computePendingScore(job.priority, job.createdAt)

      const pipeline = client.pipeline()
      pipeline.zrem(this.scheduledKey(), id)
      pipeline.zadd(this.pendingKey(job.queue), score, id)
      pipeline.hset(this.jobKey(id), 'status', 'pending')
      await pipeline.exec()

      results.push({ ...job, status: 'pending' })
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

  private getClient(): any {
    if (!this.client) {
      throw new Error('Redis backend not connected. Call connect() first.')
    }
    return this.client
  }
}
