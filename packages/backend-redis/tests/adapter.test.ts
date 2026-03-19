import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest'
import Redis from 'ioredis'
import { RedisBackendAdapter, serializeJobToHash, deserializeJobFromHash, computePendingScore } from '../src/adapter.js'
import type { Job, JobStatus } from 'psyqueue'

// ─── Availability check ───────────────────────────────────────────────────────

let redisAvailable = false

beforeAll(async () => {
  try {
    const client = new Redis({ lazyConnect: true, connectTimeout: 1000, host: 'localhost', port: 6379 })
    await client.connect()
    await client.ping()
    await client.quit()
    redisAvailable = true
  } catch {
    // Redis not available — real DB tests will be skipped
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

describe('RedisBackendAdapter – serialization (always runs)', () => {
  it('serializeJobToHash produces flat string map', () => {
    const job = makeJob({
      payload: { nested: { val: 42 } },
      tenantId: 'tenant-1',
      meta: { key: 'value' },
      backoffBase: 1000,
      backoffCap: 30000,
      backoffJitter: true,
    })
    const hash = serializeJobToHash(job)

    // Hot fields remain as individual hash fields
    expect(hash['id']).toBe(job.id)
    expect(hash['queue']).toBe('default')
    expect(hash['name']).toBe('test-job')
    expect(hash['payload']).toBe(JSON.stringify({ nested: { val: 42 } }))
    expect(hash['status']).toBe('pending')
    expect(hash['priority']).toBe('0')
    expect(hash['max_retries']).toBe('3')
    expect(hash['attempt']).toBe('1')
    expect(hash['completion_token']).toBe('')

    // Cold fields are packed into _ext JSON blob
    const ext = JSON.parse(hash['_ext']!)
    expect(ext.tenant_id).toBe('tenant-1')
    expect(ext.backoff).toBe('exponential')
    expect(ext.backoff_base).toBe(1000)
    expect(ext.backoff_cap).toBe(30000)
    expect(ext.backoff_jitter).toBe(true)
    expect(ext.meta).toEqual({ key: 'value' })
  })

  it('serializeJobToHash stores function backoff as "custom"', () => {
    const job = makeJob({ backoff: ((_attempt: number) => 1000) as unknown as Job['backoff'] })
    const hash = serializeJobToHash(job)
    const ext = JSON.parse(hash['_ext']!)
    expect(ext.backoff).toBe('custom')
  })

  it('serializeJobToHash stores optional dates as ISO strings', () => {
    const runAt = new Date('2025-01-01T00:00:00Z')
    const deadline = new Date('2025-06-01T00:00:00Z')
    const job = makeJob({ runAt, deadline })
    const hash = serializeJobToHash(job)
    const ext = JSON.parse(hash['_ext']!)
    expect(ext.run_at).toBe(runAt.toISOString())
    expect(ext.deadline).toBe(deadline.toISOString())
  })

  it('serializeJobToHash stores empty/absent for missing optional fields in _ext', () => {
    const job = makeJob()
    const hash = serializeJobToHash(job)
    const ext = JSON.parse(hash['_ext']!)
    // Optional fields with no value are omitted from _ext
    expect(ext.tenant_id).toBeUndefined()
    expect(ext.run_at).toBeUndefined()
    expect(ext.deadline).toBeUndefined()
    expect(ext.workflow_id).toBeUndefined()
    expect(ext.result).toBeUndefined()
    expect(ext.error).toBeUndefined()
  })

  it('deserializeJobFromHash restores Job from flat string map', () => {
    const original = makeJob({
      payload: { arr: [1, 2, 3] },
      tenantId: 'tenant-2',
      meta: { retryCount: 5 },
      backoffJitter: false,
      backoffBase: 500,
    })
    const hash = serializeJobToHash(original)
    const restored = deserializeJobFromHash(hash)

    expect(restored.id).toBe(original.id)
    expect(restored.queue).toBe(original.queue)
    expect(restored.name).toBe(original.name)
    expect(restored.payload).toEqual({ arr: [1, 2, 3] })
    expect(restored.status).toBe('pending')
    expect(restored.priority).toBe(0)
    expect(restored.tenantId).toBe('tenant-2')
    expect(restored.maxRetries).toBe(3)
    expect(restored.attempt).toBe(1)
    expect(restored.backoff).toBe('exponential')
    expect(restored.backoffBase).toBe(500)
    expect(restored.backoffJitter).toBe(false)
    expect(restored.meta).toEqual({ retryCount: 5 })
    expect(restored.createdAt).toBeInstanceOf(Date)
  })

  it('deserializeJobFromHash handles "custom" backoff as "exponential" fallback', () => {
    const job = makeJob({ backoff: ((_n: number) => 0) as unknown as Job['backoff'] })
    const hash = serializeJobToHash(job)
    const restored = deserializeJobFromHash(hash)
    expect(restored.backoff).toBe('exponential')
  })

  it('deserializeJobFromHash parses dates as Date objects', () => {
    const runAt = new Date('2025-03-01T12:00:00Z')
    const job = makeJob({ runAt })
    const hash = serializeJobToHash(job)
    const restored = deserializeJobFromHash(hash)
    expect(restored.runAt).toBeInstanceOf(Date)
    expect(restored.runAt!.toISOString()).toBe(runAt.toISOString())
  })

  it('deserializeJobFromHash leaves optional fields as undefined when empty', () => {
    const job = makeJob()
    const hash = serializeJobToHash(job)
    const restored = deserializeJobFromHash(hash)
    expect(restored.tenantId).toBeUndefined()
    expect(restored.workflowId).toBeUndefined()
    expect(restored.stepId).toBeUndefined()
    expect(restored.parentJobId).toBeUndefined()
    expect(restored.traceId).toBeUndefined()
    expect(restored.spanId).toBeUndefined()
    expect(restored.runAt).toBeUndefined()
    expect(restored.deadline).toBeUndefined()
    expect(restored.result).toBeUndefined()
    expect(restored.error).toBeUndefined()
    expect(restored.startedAt).toBeUndefined()
    expect(restored.completedAt).toBeUndefined()
  })

  it('deserializeJobFromHash parses error JSON', () => {
    const job = makeJob()
    const hash = serializeJobToHash(job)
    // Inject error into _ext blob (new packed format)
    const ext = JSON.parse(hash['_ext']!)
    ext.error = { message: 'boom', retryable: false }
    hash['_ext'] = JSON.stringify(ext)
    const restored = deserializeJobFromHash(hash)
    expect(restored.error).toEqual({ message: 'boom', retryable: false })
  })

  it('deserializeJobFromHash parses error JSON from legacy format (no _ext)', () => {
    // Legacy format: individual hash fields, no _ext
    const hash: Record<string, string> = {
      id: 'legacy-1',
      queue: 'default',
      name: 'test',
      payload: '{}',
      status: 'failed',
      priority: '0',
      max_retries: '3',
      attempt: '1',
      backoff: 'exponential',
      timeout: '30000',
      created_at: new Date().toISOString(),
      error: JSON.stringify({ message: 'boom', retryable: false }),
      meta: '{}',
    }
    const restored = deserializeJobFromHash(hash)
    expect(restored.error).toEqual({ message: 'boom', retryable: false })
  })

  it('computePendingScore: higher priority gets lower score (dequeued first)', () => {
    const now = new Date()
    const highPriority = computePendingScore(10, now)
    const lowPriority = computePendingScore(1, now)
    expect(highPriority).toBeLessThan(lowPriority)
  })

  it('computePendingScore: same priority, older job gets lower score (FIFO)', () => {
    const older = new Date('2024-01-01T00:00:00Z')
    const newer = new Date('2024-01-01T00:01:00Z')
    const scoreOlder = computePendingScore(0, older)
    const scoreNewer = computePendingScore(0, newer)
    expect(scoreOlder).toBeLessThan(scoreNewer)
  })
})

describe('RedisBackendAdapter – key naming (always runs)', () => {
  it('uses correct key patterns', () => {
    const adapter = new RedisBackendAdapter({ keyPrefix: 'test' })
    // Access private methods via cast for testing
    const a = adapter as unknown as Record<string, (s: string) => string>
    expect(a['jobKey']!('abc')).toBe('test:job:abc')
    expect(a['pendingKey']!('myqueue')).toBe('test:myqueue:pending')
    expect(a['activeKey']!('myqueue')).toBe('test:myqueue:active')
    // completedKey and deadKey patterns now computed inside Lua scripts using prefix + queue
    expect(a['keyPrefix']!()).toBe('test:')  // used by Lua for dynamic key construction
    expect(a['scheduledKey']!('')).toBe('test:scheduled')
    expect(a['lockKey']!('my-lock')).toBe('test:lock:my-lock')
  })

  it('uses default "psyqueue" prefix when none provided', () => {
    const adapter = new RedisBackendAdapter()
    const a = adapter as unknown as Record<string, (s: string) => string>
    expect(a['jobKey']!('xyz')).toBe('psyqueue:job:xyz')
    expect(a['pendingKey']!('q')).toBe('psyqueue:q:pending')
  })
})

describe('RedisBackendAdapter – getClient guard (always runs)', () => {
  it('throws if not connected', async () => {
    const adapter = new RedisBackendAdapter()
    await expect(adapter.enqueue(makeJob())).rejects.toThrow('not connected')
  })

  it('healthCheck returns false if not connected', async () => {
    const adapter = new RedisBackendAdapter()
    expect(await adapter.healthCheck()).toBe(false)
  })
})

// ─── Real Redis tests (skip if unavailable) ───────────────────────────────────

describe.skipIf(!redisAvailable)('RedisBackendAdapter – real Redis', () => {
  let adapter: RedisBackendAdapter
  const testPrefix = `psyqueue_test_${Date.now()}`

  beforeEach(async () => {
    adapter = new RedisBackendAdapter({ keyPrefix: testPrefix })
    await adapter.connect()
  })

  afterEach(async () => {
    // Clean up all test keys
    const client = (adapter as unknown as Record<string, unknown>)['client'] as Redis
    if (client) {
      let cursor = '0'
      do {
        const [next, keys] = await client.scan(cursor, 'MATCH', `${testPrefix}:*`, 'COUNT', 100)
        cursor = next
        if (keys.length > 0) {
          await client.del(...keys)
        }
      } while (cursor !== '0')
    }
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

  // 3. getJob returns null for nonexistent id
  it('getJob returns null for nonexistent id', async () => {
    const job = await adapter.getJob('nonexistent-id')
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

    // Dequeuing again should return nothing (job is now active)
    const dequeued2 = await adapter.dequeue('default', 1)
    expect(dequeued2).toHaveLength(0)
  })

  // 5. Priority ordering
  it('dequeues highest priority jobs first', async () => {
    const low = makeJob({ id: `low-${Date.now()}`, priority: 1 })
    const high = makeJob({ id: `high-${Date.now()}`, priority: 10 })
    const mid = makeJob({ id: `mid-${Date.now()}`, priority: 5 })

    await adapter.enqueue(low)
    await adapter.enqueue(high)
    await adapter.enqueue(mid)

    const dequeued = await adapter.dequeue('default', 3)
    expect(dequeued).toHaveLength(3)
    expect(dequeued[0]!.priority).toBe(10)
    expect(dequeued[1]!.priority).toBe(5)
    expect(dequeued[2]!.priority).toBe(1)
  })

  // 6. Ack with token
  it('acks a job successfully with token', async () => {
    const job = makeJob()
    await adapter.enqueue(job)

    const [dequeued] = await adapter.dequeue('default', 1)
    const result = await adapter.ack(dequeued!.id, dequeued!.completionToken)
    expect(result.alreadyCompleted).toBe(false)

    const updated = await adapter.getJob(job.id)
    expect(updated!.status).toBe('completed')
    expect(updated!.completedAt).toBeInstanceOf(Date)
  })

  // 7. Ack with wrong token
  it('ack with wrong token returns alreadyCompleted=true', async () => {
    const job = makeJob()
    await adapter.enqueue(job)

    const [dequeued] = await adapter.dequeue('default', 1)
    const result = await adapter.ack(dequeued!.id, 'wrong-token')
    expect(result.alreadyCompleted).toBe(true)

    // Job should still be active
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
  it('nack with requeue=true sets status to pending and increments attempt', async () => {
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

  // 13. Nack default (no opts)
  it('nack with no opts defaults to requeue', async () => {
    const job = makeJob()
    await adapter.enqueue(job)
    await adapter.dequeue('default', 1)

    await adapter.nack(job.id)

    const updated = await adapter.getJob(job.id)
    expect(updated!.status).toBe('pending')
  })

  // 14. enqueueBulk
  it('enqueueBulk inserts multiple jobs', async () => {
    const jobs = [
      makeJob({ id: `bulk-1-${Date.now()}` }),
      makeJob({ id: `bulk-2-${Date.now()}` }),
      makeJob({ id: `bulk-3-${Date.now()}` }),
    ]

    const ids = await adapter.enqueueBulk(jobs)
    expect(ids).toHaveLength(3)

    for (const id of ids) {
      const job = await adapter.getJob(id)
      expect(job).not.toBeNull()
    }
  })

  // 15. listJobs with filters
  it('listJobs filters by queue, status, tenantId, name', async () => {
    const uid = Date.now()
    await adapter.enqueue(makeJob({ id: `j1-${uid}`, queue: `q1-${uid}`, name: 'send-email', tenantId: `t1-${uid}` }))
    await adapter.enqueue(makeJob({ id: `j2-${uid}`, queue: `q2-${uid}`, name: 'send-sms', tenantId: `t2-${uid}` }))
    await adapter.enqueue(makeJob({ id: `j3-${uid}`, queue: `q1-${uid}`, name: 'send-email', tenantId: `t1-${uid}`, status: 'completed' as JobStatus }))

    const byQueue = await adapter.listJobs({ queue: `q1-${uid}` })
    expect(byQueue.total).toBe(2)

    const byStatus = await adapter.listJobs({ status: 'pending', queue: `q1-${uid}` })
    expect(byStatus.total).toBe(1)

    const byName = await adapter.listJobs({ name: 'send-email', queue: `q1-${uid}` })
    expect(byName.total).toBe(2)

    const byTenant = await adapter.listJobs({ tenantId: `t1-${uid}` })
    expect(byTenant.total).toBe(2)
  })

  // 16. listJobs with status array
  it('listJobs filters by array of statuses', async () => {
    const uid = Date.now()
    const q = `q-arr-${uid}`
    await adapter.enqueue(makeJob({ id: `p-${uid}`, queue: q, status: 'pending' }))
    await adapter.enqueue(makeJob({ id: `c-${uid}`, queue: q, status: 'completed' as JobStatus }))
    await adapter.enqueue(makeJob({ id: `f-${uid}`, queue: q, status: 'failed' as JobStatus }))

    const result = await adapter.listJobs({ queue: q, status: ['pending', 'failed'] })
    expect(result.total).toBe(2)
  })

  // 17. scheduleAt + pollScheduled
  it('scheduleAt schedules a job and pollScheduled moves due jobs to pending', async () => {
    const job = makeJob()
    const runAt = new Date(Date.now() - 10000) // in the past
    await adapter.scheduleAt(job, runAt)

    const stored = await adapter.getJob(job.id)
    expect(stored!.status).toBe('scheduled')

    const polled = await adapter.pollScheduled(new Date(), 10)
    expect(polled.length).toBeGreaterThanOrEqual(1)
    const polledJob = polled.find(j => j.id === job.id)
    expect(polledJob).toBeDefined()
    expect(polledJob!.status).toBe('pending')

    // Should not be polled again
    const polled2 = await adapter.pollScheduled(new Date(), 10)
    expect(polled2.find(j => j.id === job.id)).toBeUndefined()
  })

  it('pollScheduled does not move future jobs', async () => {
    const job = makeJob()
    const futureDate = new Date(Date.now() + 60000)
    await adapter.scheduleAt(job, futureDate)

    const polled = await adapter.pollScheduled(new Date(), 10)
    expect(polled.find(j => j.id === job.id)).toBeUndefined()

    const stored = await adapter.getJob(job.id)
    expect(stored!.status).toBe('scheduled')
  })

  // 18. acquireLock + releaseLock
  it('acquireLock succeeds first, fails second', async () => {
    const lockKey = `test-lock-${Date.now()}`
    const a1 = await adapter.acquireLock(lockKey, 5000)
    expect(a1).toBe(true)

    const a2 = await adapter.acquireLock(lockKey, 5000)
    expect(a2).toBe(false)
  })

  it('releaseLock allows re-acquisition', async () => {
    const lockKey = `test-lock-${Date.now()}`
    await adapter.acquireLock(lockKey, 5000)
    await adapter.releaseLock(lockKey)

    const acquired = await adapter.acquireLock(lockKey, 5000)
    expect(acquired).toBe(true)
  })

  it('different lock keys are independent', async () => {
    const uid = Date.now()
    const a = await adapter.acquireLock(`lock-a-${uid}`, 5000)
    const b = await adapter.acquireLock(`lock-b-${uid}`, 5000)
    expect(a).toBe(true)
    expect(b).toBe(true)

    expect(await adapter.acquireLock(`lock-a-${uid}`, 5000)).toBe(false)
    expect(await adapter.acquireLock(`lock-b-${uid}`, 5000)).toBe(false)
  })

  // 19. Empty queue
  it('dequeue on empty queue returns empty array', async () => {
    const dequeued = await adapter.dequeue(`nonexistent-queue-${Date.now()}`, 5)
    expect(dequeued).toEqual([])
  })

  // 20. Dequeue respects count
  it('dequeue respects count limit', async () => {
    for (let i = 0; i < 5; i++) {
      await adapter.enqueue(makeJob({ id: `limit-${i}-${Date.now()}` }))
    }

    const dequeued = await adapter.dequeue('default', 2)
    expect(dequeued).toHaveLength(2)
  })

  // 21. Dequeue from specific queue only
  it('dequeue only returns jobs from the specified queue', async () => {
    const uid = Date.now()
    const qa = `queue-a-${uid}`
    const qb = `queue-b-${uid}`
    await adapter.enqueue(makeJob({ id: `qa-job-${uid}`, queue: qa }))
    await adapter.enqueue(makeJob({ id: `qb-job-${uid}`, queue: qb }))

    const dequeued = await adapter.dequeue(qa, 10)
    expect(dequeued).toHaveLength(1)
    expect(dequeued[0]!.queue).toBe(qa)
  })

  // 22. FIFO for same priority
  it('dequeues in FIFO order for same priority', async () => {
    const uid = Date.now()
    const q = `fifo-queue-${uid}`
    const job1 = makeJob({ id: `fifo-1-${uid}`, queue: q, createdAt: new Date('2024-01-01T00:00:00Z') })
    const job2 = makeJob({ id: `fifo-2-${uid}`, queue: q, createdAt: new Date('2024-01-01T00:00:01Z') })
    const job3 = makeJob({ id: `fifo-3-${uid}`, queue: q, createdAt: new Date('2024-01-01T00:00:02Z') })

    await adapter.enqueue(job1)
    await adapter.enqueue(job2)
    await adapter.enqueue(job3)

    const dequeued = await adapter.dequeue(q, 3)
    expect(dequeued[0]!.id).toBe(job1.id)
    expect(dequeued[1]!.id).toBe(job2.id)
    expect(dequeued[2]!.id).toBe(job3.id)
  })

  // 23. Optional fields round-trip
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

  // 24. atomic
  it('atomic executes multiple operations', async () => {
    const job1 = makeJob({ id: `atomic-1-${Date.now()}` })
    const job2 = makeJob({ id: `atomic-2-${Date.now()}` })

    await adapter.enqueue(job1)
    await adapter.dequeue('default', 1)

    await adapter.atomic([
      { type: 'enqueue', job: job2 },
      { type: 'ack', jobId: job1.id },
    ])

    const stored1 = await adapter.getJob(job1.id)
    expect(stored1!.status).toBe('completed')

    const stored2 = await adapter.getJob(job2.id)
    expect(stored2).not.toBeNull()
    expect(stored2!.status).toBe('pending')
  })

  // 25. Backoff strategies
  it('serializes and deserializes backoff strategies correctly', async () => {
    const uid = Date.now()
    const fixedJob = makeJob({ id: `fixed-${uid}`, backoff: 'fixed', backoffBase: 2000, backoffCap: 10000, backoffJitter: false })
    const linearJob = makeJob({ id: `linear-${uid}`, backoff: 'linear' })
    const expJob = makeJob({ id: `exp-${uid}`, backoff: 'exponential', backoffJitter: true })

    await adapter.enqueueBulk([fixedJob, linearJob, expJob])

    const fixed = await adapter.getJob(fixedJob.id)
    expect(fixed!.backoff).toBe('fixed')
    expect(fixed!.backoffBase).toBe(2000)
    expect(fixed!.backoffCap).toBe(10000)
    expect(fixed!.backoffJitter).toBe(false)

    const linear = await adapter.getJob(linearJob.id)
    expect(linear!.backoff).toBe('linear')

    const exp = await adapter.getJob(expJob.id)
    expect(exp!.backoff).toBe('exponential')
    expect(exp!.backoffJitter).toBe(true)
  })
})
