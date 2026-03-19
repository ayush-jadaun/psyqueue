import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest'
import { Pool } from 'pg'
import { PostgresBackendAdapter, serializeJobParams, deserializeJobRow } from '../src/adapter.js'
import type { Job, JobStatus } from 'psyqueue'

// ─── Availability check ───────────────────────────────────────────────────────

let pgAvailable = false

beforeAll(async () => {
  try {
    const pool = new Pool({
      connectionString: 'postgres://psyqueue:psyqueue@localhost:5432/psyqueue_test',
      connectionTimeoutMillis: 1000,
    })
    const client = await pool.connect()
    client.release()
    await pool.end()
    pgAvailable = true
  } catch {
    // Postgres not available — real DB tests will be skipped
  }
})

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeJob(overrides: Partial<Job> = {}): Job {
  const id = `job_${Math.random().toString(36).slice(2, 10)}`
  return {
    id,
    queue: 'default',
    name: 'test-job',
    payload: { foo: 'bar' },
    status: 'pending',
    priority: 0,
    maxRetries: 3,
    attempt: 1,
    backoff: 'exponential',
    timeout: 30000,
    createdAt: new Date(),
    meta: {},
    ...overrides,
  }
}

// ─── Mock-based tests (always run) ───────────────────────────────────────────

describe('PostgresBackendAdapter – serialization (always runs)', () => {
  it('serializeJobParams returns array with correct length (30 elements)', () => {
    const job = makeJob()
    const params = serializeJobParams(job)
    expect(params).toHaveLength(30)
  })

  it('serializeJobParams serializes id, queue, name correctly', () => {
    const job = makeJob({ id: 'test-id', queue: 'myqueue', name: 'my-job' })
    const params = serializeJobParams(job)
    expect(params[0]).toBe('test-id')
    expect(params[1]).toBe('myqueue')
    expect(params[2]).toBe('my-job')
  })

  it('serializeJobParams serializes payload as JSON string', () => {
    const payload = { nested: { arr: [1, 2, 3] } }
    const job = makeJob({ payload })
    const params = serializeJobParams(job)
    expect(params[3]).toBe(JSON.stringify(payload))
  })

  it('serializeJobParams stores function backoff as "custom"', () => {
    const job = makeJob({ backoff: ((_n: number) => 1000) as unknown as Job['backoff'] })
    const params = serializeJobParams(job)
    expect(params[11]).toBe('custom')
  })

  it('serializeJobParams stores null for missing optional fields', () => {
    const job = makeJob()
    const params = serializeJobParams(job)
    expect(params[6]).toBeNull()   // tenant_id
    expect(params[7]).toBeNull()   // idempotency_key
    expect(params[8]).toBeNull()   // schema_version
    expect(params[21]).toBeNull()  // run_at
    expect(params[23]).toBeNull()  // deadline
  })

  it('serializeJobParams serializes dates correctly', () => {
    const runAt = new Date('2025-01-01T00:00:00Z')
    const deadline = new Date('2025-06-01T00:00:00Z')
    const job = makeJob({ runAt, deadline })
    const params = serializeJobParams(job)
    expect(params[21]).toEqual(runAt)
    expect(params[23]).toEqual(deadline)
  })

  it('serializeJobParams serializes meta as JSON string', () => {
    const meta = { retryCount: 5, tags: ['urgent'] }
    const job = makeJob({ meta })
    const params = serializeJobParams(job)
    expect(params[26]).toBe(JSON.stringify(meta))
  })

  it('deserializeJobRow converts pg row to Job', () => {
    const now = new Date()
    const row = {
      id: 'row-1',
      queue: 'q1',
      name: 'n1',
      payload: { x: 1 },          // pg returns JSONB as parsed object
      status: 'pending',
      priority: 5,
      tenant_id: 'tenant-x',
      idempotency_key: null,
      schema_version: null,
      max_retries: 3,
      attempt: 1,
      backoff: 'fixed',
      backoff_base: 1000,
      backoff_cap: null,
      backoff_jitter: true,
      timeout: 30000,
      workflow_id: null,
      step_id: null,
      parent_job_id: null,
      trace_id: null,
      span_id: null,
      run_at: null,
      cron: null,
      deadline: null,
      result: null,
      error: null,
      meta: { key: 'val' },       // pg returns JSONB as parsed object
      completion_token: null,
      created_at: now,
      started_at: null,
      completed_at: null,
    }

    const job = deserializeJobRow(row)
    expect(job.id).toBe('row-1')
    expect(job.queue).toBe('q1')
    expect(job.payload).toEqual({ x: 1 })
    expect(job.status).toBe('pending')
    expect(job.priority).toBe(5)
    expect(job.tenantId).toBe('tenant-x')
    expect(job.backoff).toBe('fixed')
    expect(job.backoffBase).toBe(1000)
    expect(job.backoffJitter).toBe(true)
    expect(job.meta).toEqual({ key: 'val' })
    expect(job.createdAt).toBe(now)
    expect(job.idempotencyKey).toBeUndefined()
    expect(job.runAt).toBeUndefined()
    expect(job.error).toBeUndefined()
  })

  it('deserializeJobRow handles "custom" backoff as "exponential" fallback', () => {
    const row = {
      id: 'x',
      queue: 'q',
      name: 'n',
      payload: {},
      status: 'pending',
      priority: 0,
      tenant_id: null,
      idempotency_key: null,
      schema_version: null,
      max_retries: 3,
      attempt: 1,
      backoff: 'custom',
      backoff_base: null,
      backoff_cap: null,
      backoff_jitter: null,
      timeout: 30000,
      workflow_id: null,
      step_id: null,
      parent_job_id: null,
      trace_id: null,
      span_id: null,
      run_at: null,
      cron: null,
      deadline: null,
      result: null,
      error: null,
      meta: {},
      completion_token: null,
      created_at: new Date(),
      started_at: null,
      completed_at: null,
    }
    const job = deserializeJobRow(row)
    expect(job.backoff).toBe('exponential')
  })

  it('deserializeJobRow parses error JSONB as JobError', () => {
    const errorObj = { message: 'something broke', retryable: false }
    const row = {
      id: 'y',
      queue: 'q',
      name: 'n',
      payload: {},
      status: 'failed',
      priority: 0,
      tenant_id: null,
      idempotency_key: null,
      schema_version: null,
      max_retries: 3,
      attempt: 3,
      backoff: 'exponential',
      backoff_base: null,
      backoff_cap: null,
      backoff_jitter: null,
      timeout: 30000,
      workflow_id: null,
      step_id: null,
      parent_job_id: null,
      trace_id: null,
      span_id: null,
      run_at: null,
      cron: null,
      deadline: null,
      result: null,
      error: errorObj,  // pg returns JSONB as parsed object
      meta: {},
      completion_token: null,
      created_at: new Date(),
      started_at: null,
      completed_at: null,
    }
    const job = deserializeJobRow(row)
    expect(job.error).toEqual(errorObj)
  })

  it('deserializeJobRow leaves optional fields undefined when null in row', () => {
    const row = {
      id: 'z',
      queue: 'q',
      name: 'n',
      payload: {},
      status: 'pending',
      priority: 0,
      tenant_id: null,
      idempotency_key: null,
      schema_version: null,
      max_retries: 3,
      attempt: 1,
      backoff: 'exponential',
      backoff_base: null,
      backoff_cap: null,
      backoff_jitter: null,
      timeout: 30000,
      workflow_id: null,
      step_id: null,
      parent_job_id: null,
      trace_id: null,
      span_id: null,
      run_at: null,
      cron: null,
      deadline: null,
      result: null,
      error: null,
      meta: {},
      completion_token: null,
      created_at: new Date(),
      started_at: null,
      completed_at: null,
    }
    const job = deserializeJobRow(row)
    expect(job.tenantId).toBeUndefined()
    expect(job.workflowId).toBeUndefined()
    expect(job.stepId).toBeUndefined()
    expect(job.parentJobId).toBeUndefined()
    expect(job.traceId).toBeUndefined()
    expect(job.spanId).toBeUndefined()
    expect(job.runAt).toBeUndefined()
    expect(job.deadline).toBeUndefined()
    expect(job.result).toBeUndefined()
    expect(job.error).toBeUndefined()
    expect(job.startedAt).toBeUndefined()
    expect(job.completedAt).toBeUndefined()
    expect(job.cron).toBeUndefined()
    expect(job.idempotencyKey).toBeUndefined()
    expect(job.schemaVersion).toBeUndefined()
  })
})

describe('PostgresBackendAdapter – getPool guard (always runs)', () => {
  it('throws if not connected', async () => {
    const adapter = new PostgresBackendAdapter()
    await expect(adapter.enqueue(makeJob())).rejects.toThrow('not connected')
  })

  it('healthCheck returns false if not connected', async () => {
    const adapter = new PostgresBackendAdapter()
    expect(await adapter.healthCheck()).toBe(false)
  })
})

// ─── Real Postgres tests (skip if unavailable) ────────────────────────────────

describe.skipIf(!pgAvailable)('PostgresBackendAdapter – real Postgres', () => {
  let adapter: PostgresBackendAdapter

  beforeEach(async () => {
    adapter = new PostgresBackendAdapter({
      connectionString: 'postgres://psyqueue:psyqueue@localhost:5432/psyqueue_test',
    })
    await adapter.connect()

    // Clean up tables before each test
    const pool = (adapter as unknown as Record<string, unknown>)['pool'] as Pool
    await pool.query('TRUNCATE psyqueue_jobs, psyqueue_locks RESTART IDENTITY CASCADE')
  })

  afterEach(async () => {
    await adapter.disconnect()
  })

  // 1. healthCheck
  it('connects and passes healthCheck', async () => {
    expect(await adapter.healthCheck()).toBe(true)
  })

  it('healthCheck returns false when disconnected', async () => {
    await adapter.disconnect()
    expect(await adapter.healthCheck()).toBe(false)
  })

  // 2. enqueue + getJob
  it('enqueues a job and retrieves it with correct fields', async () => {
    const job = makeJob({
      payload: { message: 'hello', count: 42 },
      tenantId: 'tenant-1',
      meta: { source: 'test' },
    })

    const id = await adapter.enqueue(job)
    expect(id).toBe(job.id)

    const retrieved = await adapter.getJob(job.id)
    expect(retrieved).not.toBeNull()
    expect(retrieved!.id).toBe(job.id)
    expect(retrieved!.queue).toBe('default')
    expect(retrieved!.name).toBe('test-job')
    expect(retrieved!.payload).toEqual({ message: 'hello', count: 42 })
    expect(retrieved!.status).toBe('pending')
    expect(retrieved!.priority).toBe(0)
    expect(retrieved!.tenantId).toBe('tenant-1')
    expect(retrieved!.maxRetries).toBe(3)
    expect(retrieved!.attempt).toBe(1)
    expect(retrieved!.backoff).toBe('exponential')
    expect(retrieved!.timeout).toBe(30000)
    expect(retrieved!.meta).toEqual({ source: 'test' })
  })

  // 3. getJob null
  it('getJob returns null for nonexistent id', async () => {
    const job = await adapter.getJob('nonexistent')
    expect(job).toBeNull()
  })

  // 4. dequeue with completion token
  it('dequeues a job atomically with completion token', async () => {
    const job = makeJob()
    await adapter.enqueue(job)

    const dequeued = await adapter.dequeue('default', 1)
    expect(dequeued).toHaveLength(1)
    expect(dequeued[0]!.id).toBe(job.id)
    expect(dequeued[0]!.status).toBe('active')
    expect(dequeued[0]!.completionToken).toBeTruthy()
    expect(typeof dequeued[0]!.completionToken).toBe('string')
    expect(dequeued[0]!.startedAt).toBeInstanceOf(Date)

    // Dequeuing again should return nothing
    const dequeued2 = await adapter.dequeue('default', 1)
    expect(dequeued2).toHaveLength(0)
  })

  // 5. Priority
  it('dequeues highest priority jobs first', async () => {
    const low = makeJob({ id: 'low', priority: 1 })
    const high = makeJob({ id: 'high', priority: 10 })
    const mid = makeJob({ id: 'mid', priority: 5 })

    await adapter.enqueue(low)
    await adapter.enqueue(high)
    await adapter.enqueue(mid)

    const dequeued = await adapter.dequeue('default', 3)
    expect(dequeued).toHaveLength(3)
    expect(dequeued[0]!.id).toBe('high')
    expect(dequeued[1]!.id).toBe('mid')
    expect(dequeued[2]!.id).toBe('low')
  })

  // 6. Ack with token
  it('acks a job successfully', async () => {
    const job = makeJob()
    await adapter.enqueue(job)

    const [dequeued] = await adapter.dequeue('default', 1)
    const result = await adapter.ack(dequeued!.id, dequeued!.completionToken)
    expect(result.alreadyCompleted).toBe(false)

    const updated = await adapter.getJob(job.id)
    expect(updated!.status).toBe('completed')
    expect(updated!.completedAt).toBeInstanceOf(Date)
  })

  // 7. Ack wrong token
  it('ack with wrong token returns alreadyCompleted=true', async () => {
    const job = makeJob()
    await adapter.enqueue(job)

    const [dequeued] = await adapter.dequeue('default', 1)
    const result = await adapter.ack(dequeued!.id, 'wrong-token')
    expect(result.alreadyCompleted).toBe(true)

    const updated = await adapter.getJob(job.id)
    expect(updated!.status).toBe('active')
  })

  // 8. Ack without token
  it('ack without token still completes the job', async () => {
    const job = makeJob()
    await adapter.enqueue(job)

    const [dequeued] = await adapter.dequeue('default', 1)
    const result = await adapter.ack(dequeued!.id)
    expect(result.alreadyCompleted).toBe(false)

    const updated = await adapter.getJob(job.id)
    expect(updated!.status).toBe('completed')
  })

  // 9. Nack requeue
  it('nack with requeue=true sets status to pending', async () => {
    const job = makeJob()
    await adapter.enqueue(job)
    await adapter.dequeue('default', 1)

    await adapter.nack(job.id, { requeue: true })

    const updated = await adapter.getJob(job.id)
    expect(updated!.status).toBe('pending')
    expect(updated!.attempt).toBe(2)
  })

  // 10. Nack dead letter
  it('nack with deadLetter=true sets status to dead', async () => {
    const job = makeJob()
    await adapter.enqueue(job)
    await adapter.dequeue('default', 1)

    await adapter.nack(job.id, { deadLetter: true, reason: 'too many retries' })

    const updated = await adapter.getJob(job.id)
    expect(updated!.status).toBe('dead')
    expect(updated!.error).toBeDefined()
    expect(updated!.error!.message).toBe('too many retries')
  })

  // 11. Nack fail
  it('nack with requeue=false sets status to failed', async () => {
    const job = makeJob()
    await adapter.enqueue(job)
    await adapter.dequeue('default', 1)

    await adapter.nack(job.id, { requeue: false, reason: 'validation error' })

    const updated = await adapter.getJob(job.id)
    expect(updated!.status).toBe('failed')
    expect(updated!.error!.message).toBe('validation error')
  })

  // 12. Nack with delay
  it('nack with delay sets run_at in the future', async () => {
    const job = makeJob()
    await adapter.enqueue(job)
    await adapter.dequeue('default', 1)

    const before = Date.now()
    await adapter.nack(job.id, { requeue: true, delay: 5000 })

    const updated = await adapter.getJob(job.id)
    expect(updated!.status).toBe('pending')
    expect(updated!.runAt).toBeInstanceOf(Date)
    expect(updated!.runAt!.getTime()).toBeGreaterThanOrEqual(before + 4000)
  })

  // 13. Nack default
  it('nack with no opts defaults to requeue', async () => {
    const job = makeJob()
    await adapter.enqueue(job)
    await adapter.dequeue('default', 1)

    await adapter.nack(job.id)

    const updated = await adapter.getJob(job.id)
    expect(updated!.status).toBe('pending')
  })

  // 14. enqueueBulk
  it('enqueueBulk inserts multiple jobs atomically', async () => {
    const jobs = [
      makeJob({ id: 'bulk-1' }),
      makeJob({ id: 'bulk-2' }),
      makeJob({ id: 'bulk-3' }),
    ]

    const ids = await adapter.enqueueBulk(jobs)
    expect(ids).toEqual(['bulk-1', 'bulk-2', 'bulk-3'])

    for (const id of ids) {
      const job = await adapter.getJob(id)
      expect(job).not.toBeNull()
    }
  })

  // 15. enqueueBulk rollback
  it('enqueueBulk rolls back on failure', async () => {
    const existing = makeJob({ id: 'existing-job' })
    await adapter.enqueue(existing)

    const jobs = [
      makeJob({ id: 'new-1' }),
      makeJob({ id: 'existing-job' }), // duplicate
      makeJob({ id: 'new-2' }),
    ]

    await expect(adapter.enqueueBulk(jobs)).rejects.toThrow()

    expect(await adapter.getJob('new-1')).toBeNull()
    expect(await adapter.getJob('new-2')).toBeNull()
  })

  // 16. listJobs
  it('listJobs filters by status, queue, tenantId, name', async () => {
    await adapter.enqueue(makeJob({ id: 'j1', queue: 'q1', name: 'send-email', tenantId: 't1' }))
    await adapter.enqueue(makeJob({ id: 'j2', queue: 'q2', name: 'send-sms', tenantId: 't2' }))
    await adapter.enqueue(makeJob({ id: 'j3', queue: 'q1', name: 'send-email', tenantId: 't1', status: 'completed' as JobStatus }))

    const byQueue = await adapter.listJobs({ queue: 'q1' })
    expect(byQueue.data).toHaveLength(2)
    expect(byQueue.total).toBe(2)

    const byStatus = await adapter.listJobs({ status: 'pending' })
    expect(byStatus.data).toHaveLength(2)

    const byName = await adapter.listJobs({ name: 'send-email' })
    expect(byName.data).toHaveLength(2)

    const byTenant = await adapter.listJobs({ tenantId: 't1' })
    expect(byTenant.data).toHaveLength(2)

    const combined = await adapter.listJobs({ queue: 'q1', status: 'pending', tenantId: 't1' })
    expect(combined.data).toHaveLength(1)
    expect(combined.data[0]!.id).toBe('j1')
  })

  // 17. listJobs pagination
  it('listJobs pagination works correctly', async () => {
    for (let i = 0; i < 10; i++) {
      await adapter.enqueue(makeJob({ id: `page-${i}` }))
    }

    const page1 = await adapter.listJobs({ limit: 3, offset: 0 })
    expect(page1.data).toHaveLength(3)
    expect(page1.total).toBe(10)
    expect(page1.limit).toBe(3)
    expect(page1.offset).toBe(0)
    expect(page1.hasMore).toBe(true)

    const page2 = await adapter.listJobs({ limit: 3, offset: 3 })
    expect(page2.data).toHaveLength(3)
    expect(page2.offset).toBe(3)
    expect(page2.hasMore).toBe(true)

    const lastPage = await adapter.listJobs({ limit: 3, offset: 9 })
    expect(lastPage.data).toHaveLength(1)
    expect(lastPage.hasMore).toBe(false)
  })

  // 18. listJobs with status array
  it('listJobs filters by array of statuses', async () => {
    await adapter.enqueue(makeJob({ id: 'pending-job', status: 'pending' }))
    await adapter.enqueue(makeJob({ id: 'completed-job', status: 'completed' as JobStatus }))
    await adapter.enqueue(makeJob({ id: 'failed-job', status: 'failed' as JobStatus }))

    const result = await adapter.listJobs({ status: ['pending', 'failed'] })
    expect(result.data).toHaveLength(2)
    const ids = result.data.map(j => j.id).sort()
    expect(ids).toEqual(['failed-job', 'pending-job'])
  })

  // 19. listJobs sort
  it('listJobs sorts by priority desc and createdAt asc', async () => {
    await adapter.enqueue(makeJob({ id: 'sort-1', priority: 5, createdAt: new Date('2024-01-01') }))
    await adapter.enqueue(makeJob({ id: 'sort-2', priority: 10, createdAt: new Date('2024-01-02') }))
    await adapter.enqueue(makeJob({ id: 'sort-3', priority: 1, createdAt: new Date('2024-01-03') }))

    const byPriorityDesc = await adapter.listJobs({ sortBy: 'priority', sortOrder: 'desc' })
    expect(byPriorityDesc.data[0]!.id).toBe('sort-2')
    expect(byPriorityDesc.data[1]!.id).toBe('sort-1')
    expect(byPriorityDesc.data[2]!.id).toBe('sort-3')

    const byCreatedAsc = await adapter.listJobs({ sortBy: 'createdAt', sortOrder: 'asc' })
    expect(byCreatedAsc.data[0]!.id).toBe('sort-1')
    expect(byCreatedAsc.data[1]!.id).toBe('sort-2')
    expect(byCreatedAsc.data[2]!.id).toBe('sort-3')
  })

  // 20. scheduleAt + pollScheduled
  it('scheduleAt schedules and pollScheduled moves due jobs to pending', async () => {
    const pastJob = makeJob({ id: 'past-job' })
    const pastDate = new Date(Date.now() - 10000)
    await adapter.scheduleAt(pastJob, pastDate)

    const polled = await adapter.pollScheduled(new Date(), 10)
    expect(polled).toHaveLength(1)
    expect(polled[0]!.id).toBe('past-job')
    expect(polled[0]!.status).toBe('pending')

    // Should not be polled again
    const polled2 = await adapter.pollScheduled(new Date(), 10)
    expect(polled2).toHaveLength(0)
  })

  // 21. pollScheduled future
  it('pollScheduled does not move future jobs', async () => {
    const futureJob = makeJob({ id: 'future-job' })
    const futureDate = new Date(Date.now() + 60000)
    await adapter.scheduleAt(futureJob, futureDate)

    const polled = await adapter.pollScheduled(new Date(), 10)
    expect(polled).toHaveLength(0)

    const stored = await adapter.getJob('future-job')
    expect(stored!.status).toBe('scheduled')
  })

  // 22. pollScheduled limit
  it('pollScheduled respects limit parameter', async () => {
    for (let i = 0; i < 5; i++) {
      const job = makeJob({ id: `sched-${i}` })
      await adapter.scheduleAt(job, new Date(Date.now() - 10000))
    }

    const polled = await adapter.pollScheduled(new Date(), 2)
    expect(polled).toHaveLength(2)

    const polled2 = await adapter.pollScheduled(new Date(), 10)
    expect(polled2).toHaveLength(3)
  })

  // 23. acquireLock + releaseLock
  it('acquireLock succeeds first, fails second', async () => {
    const acquired1 = await adapter.acquireLock('my-lock', 5000)
    expect(acquired1).toBe(true)

    const acquired2 = await adapter.acquireLock('my-lock', 5000)
    expect(acquired2).toBe(false)
  })

  it('releaseLock allows re-acquisition', async () => {
    await adapter.acquireLock('my-lock', 5000)
    await adapter.releaseLock('my-lock')

    const acquired = await adapter.acquireLock('my-lock', 5000)
    expect(acquired).toBe(true)
  })

  it('expired locks can be re-acquired', async () => {
    await adapter.acquireLock('expire-lock', 0)
    await new Promise(resolve => setTimeout(resolve, 10))

    const acquired = await adapter.acquireLock('expire-lock', 5000)
    expect(acquired).toBe(true)
  })

  it('different lock keys are independent', async () => {
    const a = await adapter.acquireLock('lock-a', 5000)
    const b = await adapter.acquireLock('lock-b', 5000)
    expect(a).toBe(true)
    expect(b).toBe(true)

    expect(await adapter.acquireLock('lock-a', 5000)).toBe(false)
    expect(await adapter.acquireLock('lock-b', 5000)).toBe(false)
  })

  // 24. Empty queue
  it('dequeue on empty queue returns empty array', async () => {
    const dequeued = await adapter.dequeue('nonexistent', 5)
    expect(dequeued).toEqual([])
  })

  // 25. dequeue count limit
  it('dequeue respects count limit', async () => {
    for (let i = 0; i < 5; i++) {
      await adapter.enqueue(makeJob({ id: `limit-${i}` }))
    }

    const dequeued = await adapter.dequeue('default', 2)
    expect(dequeued).toHaveLength(2)

    const remaining = await adapter.dequeue('default', 10)
    expect(remaining).toHaveLength(3)
  })

  // 26. dequeue queue isolation
  it('dequeue only returns jobs from the specified queue', async () => {
    await adapter.enqueue(makeJob({ id: 'q1-job', queue: 'queue-a' }))
    await adapter.enqueue(makeJob({ id: 'q2-job', queue: 'queue-b' }))

    const dequeued = await adapter.dequeue('queue-a', 10)
    expect(dequeued).toHaveLength(1)
    expect(dequeued[0]!.id).toBe('q1-job')
  })

  // 27. FIFO ordering
  it('dequeues in FIFO order for same priority', async () => {
    const job1 = makeJob({ id: 'fifo-1', createdAt: new Date('2024-01-01T00:00:00Z') })
    const job2 = makeJob({ id: 'fifo-2', createdAt: new Date('2024-01-01T00:00:01Z') })
    const job3 = makeJob({ id: 'fifo-3', createdAt: new Date('2024-01-01T00:00:02Z') })

    await adapter.enqueue(job1)
    await adapter.enqueue(job2)
    await adapter.enqueue(job3)

    const dequeued = await adapter.dequeue('default', 3)
    expect(dequeued[0]!.id).toBe('fifo-1')
    expect(dequeued[1]!.id).toBe('fifo-2')
    expect(dequeued[2]!.id).toBe('fifo-3')
  })

  // 28. atomic
  it('atomic executes multiple operations in one transaction', async () => {
    const job1 = makeJob({ id: 'atomic-1' })
    const job2 = makeJob({ id: 'atomic-2' })

    await adapter.enqueue(job1)
    await adapter.dequeue('default', 1)

    await adapter.atomic([
      { type: 'enqueue', job: job2 },
      { type: 'ack', jobId: 'atomic-1' },
    ])

    const stored1 = await adapter.getJob('atomic-1')
    expect(stored1!.status).toBe('completed')

    const stored2 = await adapter.getJob('atomic-2')
    expect(stored2).not.toBeNull()
    expect(stored2!.status).toBe('pending')
  })

  // 29. atomic nack
  it('atomic supports nack operations', async () => {
    const job = makeJob({ id: 'atomic-nack' })
    await adapter.enqueue(job)
    await adapter.dequeue('default', 1)

    await adapter.atomic([
      { type: 'nack', jobId: 'atomic-nack', opts: { deadLetter: true, reason: 'atomic dead' } },
    ])

    const updated = await adapter.getJob('atomic-nack')
    expect(updated!.status).toBe('dead')
  })

  // 30. Optional fields round-trip
  it('optional fields round-trip correctly', async () => {
    const job = makeJob({
      workflowId: 'wf-1',
      stepId: 'step-1',
      parentJobId: 'parent-1',
      traceId: 'trace-1',
      spanId: 'span-1',
      schemaVersion: 2,
      idempotencyKey: 'idem-key-1',
      cron: '*/5 * * * *',
    })

    await adapter.enqueue(job)
    const retrieved = await adapter.getJob(job.id)

    expect(retrieved!.workflowId).toBe('wf-1')
    expect(retrieved!.stepId).toBe('step-1')
    expect(retrieved!.parentJobId).toBe('parent-1')
    expect(retrieved!.traceId).toBe('trace-1')
    expect(retrieved!.spanId).toBe('span-1')
    expect(retrieved!.schemaVersion).toBe(2)
    expect(retrieved!.idempotencyKey).toBe('idem-key-1')
    expect(retrieved!.cron).toBe('*/5 * * * *')
  })

  // 31. Deserialization: dates as Date objects
  it('deserializes dates as Date objects and payload as parsed JSONB', async () => {
    const now = new Date()
    const job = makeJob({
      payload: { nested: { array: [1, 2, 3], bool: true } },
      createdAt: now,
      deadline: new Date(Date.now() + 60000),
      meta: { retryCount: 5, tags: ['urgent', 'high'] },
    })

    await adapter.enqueue(job)
    const retrieved = await adapter.getJob(job.id)

    expect(retrieved!.createdAt).toBeInstanceOf(Date)
    expect(retrieved!.deadline).toBeInstanceOf(Date)
    expect(retrieved!.payload).toEqual({ nested: { array: [1, 2, 3], bool: true } })
    expect(retrieved!.meta).toEqual({ retryCount: 5, tags: ['urgent', 'high'] })
  })

  // 32. Backoff strategies
  it('serializes and deserializes backoff strategies correctly', async () => {
    const fixedJob = makeJob({ id: 'fixed', backoff: 'fixed', backoffBase: 2000, backoffCap: 10000, backoffJitter: false })
    const linearJob = makeJob({ id: 'linear', backoff: 'linear' })
    const expJob = makeJob({ id: 'exp', backoff: 'exponential', backoffJitter: true })

    await adapter.enqueueBulk([fixedJob, linearJob, expJob])

    const fixed = await adapter.getJob('fixed')
    expect(fixed!.backoff).toBe('fixed')
    expect(fixed!.backoffBase).toBe(2000)
    expect(fixed!.backoffCap).toBe(10000)
    expect(fixed!.backoffJitter).toBe(false)

    const linear = await adapter.getJob('linear')
    expect(linear!.backoff).toBe('linear')

    const exp = await adapter.getJob('exp')
    expect(exp!.backoff).toBe('exponential')
    expect(exp!.backoffJitter).toBe(true)
  })

  // 33. listJobs hasMore
  it('listJobs returns correct hasMore flag', async () => {
    for (let i = 0; i < 5; i++) {
      await adapter.enqueue(makeJob({ id: `has-more-${i}` }))
    }

    const result1 = await adapter.listJobs({ limit: 3, offset: 0 })
    expect(result1.hasMore).toBe(true)

    const result2 = await adapter.listJobs({ limit: 3, offset: 3 })
    expect(result2.hasMore).toBe(false)

    const result3 = await adapter.listJobs({ limit: 5, offset: 0 })
    expect(result3.hasMore).toBe(false)
  })
})
