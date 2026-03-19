import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { SQLiteBackendAdapter } from '../src/adapter.js'
import type { Job, DequeuedJob, JobStatus } from '@psyqueue/core'

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

describe('SQLiteBackendAdapter', () => {
  let adapter: SQLiteBackendAdapter

  beforeEach(async () => {
    adapter = new SQLiteBackendAdapter({ path: ':memory:' })
    await adapter.connect()
  })

  afterEach(async () => {
    await adapter.disconnect()
  })

  // 1. Connection: connects and passes healthCheck
  it('connects and passes healthCheck', async () => {
    const healthy = await adapter.healthCheck()
    expect(healthy).toBe(true)
  })

  // healthCheck returns false when disconnected
  it('healthCheck returns false when disconnected', async () => {
    await adapter.disconnect()
    const healthy = await adapter.healthCheck()
    expect(healthy).toBe(false)
  })

  // 2. Enqueue/Get: enqueues a job and retrieves it with correct deserialization
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

  // 3. Dequeue: dequeues atomically with completion token
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

  // 4. Priority: dequeue returns highest priority first
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

  // 5. Ack: acks a job (status -> completed)
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

  // 6. Ack with wrong token: returns alreadyCompleted=true
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

  // 7. Ack without token: still works
  it('ack without token still completes the job', async () => {
    const job = makeJob()
    await adapter.enqueue(job)

    const [dequeued] = await adapter.dequeue('default', 1)
    const result = await adapter.ack(dequeued!.id)
    expect(result.alreadyCompleted).toBe(false)

    const updated = await adapter.getJob(job.id)
    expect(updated!.status).toBe('completed')
  })

  // 8. Nack requeue: nacks with requeue=true -> status back to pending
  it('nack with requeue=true sets status to pending', async () => {
    const job = makeJob()
    await adapter.enqueue(job)
    await adapter.dequeue('default', 1)

    await adapter.nack(job.id, { requeue: true })

    const updated = await adapter.getJob(job.id)
    expect(updated!.status).toBe('pending')
    expect(updated!.attempt).toBe(2) // attempt incremented
  })

  // 9. Nack dead letter: nacks with deadLetter=true -> status = dead
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

  // 10. Nack fail: nacks with requeue=false -> status = failed
  it('nack with requeue=false sets status to failed', async () => {
    const job = makeJob()
    await adapter.enqueue(job)
    await adapter.dequeue('default', 1)

    await adapter.nack(job.id, { requeue: false, reason: 'validation error' })

    const updated = await adapter.getJob(job.id)
    expect(updated!.status).toBe('failed')
    expect(updated!.error).toBeDefined()
    expect(updated!.error!.message).toBe('validation error')
  })

  // 11. Nack with delay: nacks with delay -> run_at set in future
  it('nack with delay sets run_at in the future', async () => {
    const job = makeJob()
    await adapter.enqueue(job)
    await adapter.dequeue('default', 1)

    const before = Date.now()
    await adapter.nack(job.id, { requeue: true, delay: 5000 })

    const updated = await adapter.getJob(job.id)
    expect(updated!.status).toBe('pending')
    expect(updated!.runAt).toBeInstanceOf(Date)
    expect(updated!.runAt!.getTime()).toBeGreaterThanOrEqual(before + 4000) // allow some margin
  })

  // 12. enqueueBulk: inserts multiple atomically
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

  // 13. enqueueBulk rollback: if one job invalid (duplicate id), none inserted
  it('enqueueBulk rolls back on failure', async () => {
    const existing = makeJob({ id: 'existing-job' })
    await adapter.enqueue(existing)

    const jobs = [
      makeJob({ id: 'new-1' }),
      makeJob({ id: 'existing-job' }), // Duplicate — will cause failure
      makeJob({ id: 'new-2' }),
    ]

    await expect(adapter.enqueueBulk(jobs)).rejects.toThrow()

    // None should have been inserted
    const job1 = await adapter.getJob('new-1')
    const job2 = await adapter.getJob('new-2')
    expect(job1).toBeNull()
    expect(job2).toBeNull()
  })

  // 14. listJobs: filter by status, queue, tenantId, name
  it('listJobs filters by status, queue, tenantId, name', async () => {
    await adapter.enqueue(makeJob({ id: 'j1', queue: 'q1', name: 'send-email', tenantId: 't1' }))
    await adapter.enqueue(makeJob({ id: 'j2', queue: 'q2', name: 'send-sms', tenantId: 't2' }))
    await adapter.enqueue(makeJob({ id: 'j3', queue: 'q1', name: 'send-email', tenantId: 't1', status: 'completed' as JobStatus }))

    // Filter by queue
    const byQueue = await adapter.listJobs({ queue: 'q1' })
    expect(byQueue.data).toHaveLength(2)
    expect(byQueue.total).toBe(2)

    // Filter by status
    const byStatus = await adapter.listJobs({ status: 'pending' })
    expect(byStatus.data).toHaveLength(2)

    // Filter by name
    const byName = await adapter.listJobs({ name: 'send-email' })
    expect(byName.data).toHaveLength(2)

    // Filter by tenantId
    const byTenant = await adapter.listJobs({ tenantId: 't1' })
    expect(byTenant.data).toHaveLength(2)

    // Combined filter
    const combined = await adapter.listJobs({ queue: 'q1', status: 'pending', tenantId: 't1' })
    expect(combined.data).toHaveLength(1)
    expect(combined.data[0]!.id).toBe('j1')
  })

  // 15. listJobs pagination: limit + offset work correctly
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

  // 16. scheduleAt: schedules job for future
  it('scheduleAt schedules a job for the future', async () => {
    const job = makeJob()
    const runAt = new Date(Date.now() + 60000)

    const id = await adapter.scheduleAt(job, runAt)
    expect(id).toBe(job.id)

    const stored = await adapter.getJob(job.id)
    expect(stored!.status).toBe('scheduled')
    expect(stored!.runAt).toBeInstanceOf(Date)
    expect(stored!.runAt!.getTime()).toBeCloseTo(runAt.getTime(), -2)
  })

  // 17. pollScheduled: moves due jobs from scheduled to pending
  it('pollScheduled moves due jobs to pending', async () => {
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

  // 18. pollScheduled not early: doesn't move jobs scheduled for future
  it('pollScheduled does not move future jobs', async () => {
    const futureJob = makeJob({ id: 'future-job' })
    const futureDate = new Date(Date.now() + 60000)
    await adapter.scheduleAt(futureJob, futureDate)

    const polled = await adapter.pollScheduled(new Date(), 10)
    expect(polled).toHaveLength(0)

    const stored = await adapter.getJob('future-job')
    expect(stored!.status).toBe('scheduled')
  })

  // 19. acquireLock: first call succeeds, second fails
  it('acquireLock succeeds first, fails second', async () => {
    const acquired1 = await adapter.acquireLock('my-lock', 5000)
    expect(acquired1).toBe(true)

    const acquired2 = await adapter.acquireLock('my-lock', 5000)
    expect(acquired2).toBe(false)
  })

  // 20. releaseLock: after release, can acquire again
  it('releaseLock allows re-acquisition', async () => {
    await adapter.acquireLock('my-lock', 5000)
    await adapter.releaseLock('my-lock')

    const acquired = await adapter.acquireLock('my-lock', 5000)
    expect(acquired).toBe(true)
  })

  // 21. Lock expiry: expired locks can be re-acquired
  it('expired locks can be re-acquired', async () => {
    // Acquire with 0ms TTL (immediately expired)
    await adapter.acquireLock('expire-lock', 0)

    // Small delay to ensure expiry comparison works
    await new Promise(resolve => setTimeout(resolve, 10))

    const acquired = await adapter.acquireLock('expire-lock', 5000)
    expect(acquired).toBe(true)
  })

  // 22. atomic: multiple ops in one transaction
  it('atomic executes multiple operations in one transaction', async () => {
    const job1 = makeJob({ id: 'atomic-1' })
    const job2 = makeJob({ id: 'atomic-2' })

    await adapter.enqueue(job1)
    await adapter.dequeue('default', 1) // marks job1 as active

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

  // 23. Deserialization: dates come back as Date objects, payload as parsed JSON
  it('deserializes dates as Date objects and payload as parsed JSON', async () => {
    const now = new Date()
    const job = makeJob({
      payload: { nested: { array: [1, 2, 3], bool: true } },
      createdAt: now,
      deadline: new Date(Date.now() + 60000),
      meta: { retryCount: 5, tags: ['urgent', 'high'] },
    })

    await adapter.enqueue(job)
    const retrieved = await adapter.getJob(job.id)

    expect(retrieved).not.toBeNull()
    // Dates
    expect(retrieved!.createdAt).toBeInstanceOf(Date)
    expect(retrieved!.createdAt.getTime()).toBeCloseTo(now.getTime(), -2)
    expect(retrieved!.deadline).toBeInstanceOf(Date)

    // Payload
    expect(retrieved!.payload).toEqual({ nested: { array: [1, 2, 3], bool: true } })
    expect(typeof retrieved!.payload).toBe('object')

    // Meta
    expect(retrieved!.meta).toEqual({ retryCount: 5, tags: ['urgent', 'high'] })
  })

  // 24. Empty queue: dequeue returns empty array
  it('dequeue on empty queue returns empty array', async () => {
    const dequeued = await adapter.dequeue('nonexistent', 5)
    expect(dequeued).toEqual([])
  })

  // 25. getJob returns null for nonexistent id
  it('getJob returns null for nonexistent id', async () => {
    const job = await adapter.getJob('nonexistent')
    expect(job).toBeNull()
  })

  // 26. Dequeue respects count limit
  it('dequeue respects count limit', async () => {
    for (let i = 0; i < 5; i++) {
      await adapter.enqueue(makeJob({ id: `limit-${i}` }))
    }

    const dequeued = await adapter.dequeue('default', 2)
    expect(dequeued).toHaveLength(2)

    // Remaining should still be pending
    const remaining = await adapter.dequeue('default', 10)
    expect(remaining).toHaveLength(3)
  })

  // 27. Dequeue from specific queue only
  it('dequeue only returns jobs from the specified queue', async () => {
    await adapter.enqueue(makeJob({ id: 'q1-job', queue: 'queue-a' }))
    await adapter.enqueue(makeJob({ id: 'q2-job', queue: 'queue-b' }))

    const dequeued = await adapter.dequeue('queue-a', 10)
    expect(dequeued).toHaveLength(1)
    expect(dequeued[0]!.id).toBe('q1-job')
  })

  // 28. listJobs with status array filter
  it('listJobs filters by array of statuses', async () => {
    await adapter.enqueue(makeJob({ id: 'pending-job', status: 'pending' }))
    await adapter.enqueue(makeJob({ id: 'completed-job', status: 'completed' as JobStatus }))
    await adapter.enqueue(makeJob({ id: 'failed-job', status: 'failed' as JobStatus }))

    const result = await adapter.listJobs({ status: ['pending', 'failed'] })
    expect(result.data).toHaveLength(2)
    const ids = result.data.map(j => j.id).sort()
    expect(ids).toEqual(['failed-job', 'pending-job'])
  })

  // 29. Backoff strategy serialization
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

  // 30. Function backoff stored as 'custom'
  it('stores function backoff as custom string', async () => {
    const job = makeJob({
      id: 'custom-backoff',
      backoff: ((_attempt: number) => 1000) as unknown as Job['backoff'],
    })

    await adapter.enqueue(job)
    const retrieved = await adapter.getJob('custom-backoff')
    // Function backoff gets stored as 'custom', deserialized as 'exponential' (fallback)
    expect(retrieved!.backoff).toBe('exponential')
  })

  // 31. Nack default behavior (no opts) = requeue
  it('nack with no opts defaults to requeue', async () => {
    const job = makeJob()
    await adapter.enqueue(job)
    await adapter.dequeue('default', 1)

    await adapter.nack(job.id)

    const updated = await adapter.getJob(job.id)
    expect(updated!.status).toBe('pending')
  })

  // 32. FIFO ordering for same priority
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

  // 33. atomic with nack operations
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

  // 34. listJobs returns correct hasMore
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

  // 35. Multiple locks independent
  it('different lock keys are independent', async () => {
    const a = await adapter.acquireLock('lock-a', 5000)
    const b = await adapter.acquireLock('lock-b', 5000)
    expect(a).toBe(true)
    expect(b).toBe(true)

    const a2 = await adapter.acquireLock('lock-a', 5000)
    expect(a2).toBe(false) // lock-a still held

    const b2 = await adapter.acquireLock('lock-b', 5000)
    expect(b2).toBe(false) // lock-b still held
  })

  // 36. pollScheduled respects limit
  it('pollScheduled respects limit parameter', async () => {
    for (let i = 0; i < 5; i++) {
      const job = makeJob({ id: `sched-${i}` })
      await adapter.scheduleAt(job, new Date(Date.now() - 10000))
    }

    const polled = await adapter.pollScheduled(new Date(), 2)
    expect(polled).toHaveLength(2)

    // The rest are still scheduled
    const polled2 = await adapter.pollScheduled(new Date(), 10)
    expect(polled2).toHaveLength(3)
  })

  // 37. Optional fields (workflow, trace, etc.) round-trip as undefined
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

  // 38. Job without optional fields has undefined for them
  it('jobs without optional fields have undefined values', async () => {
    const job = makeJob()
    await adapter.enqueue(job)
    const retrieved = await adapter.getJob(job.id)

    expect(retrieved!.workflowId).toBeUndefined()
    expect(retrieved!.stepId).toBeUndefined()
    expect(retrieved!.parentJobId).toBeUndefined()
    expect(retrieved!.traceId).toBeUndefined()
    expect(retrieved!.spanId).toBeUndefined()
    expect(retrieved!.schemaVersion).toBeUndefined()
    expect(retrieved!.idempotencyKey).toBeUndefined()
    expect(retrieved!.cron).toBeUndefined()
    expect(retrieved!.runAt).toBeUndefined()
    expect(retrieved!.deadline).toBeUndefined()
    expect(retrieved!.result).toBeUndefined()
    expect(retrieved!.error).toBeUndefined()
    expect(retrieved!.startedAt).toBeUndefined()
    expect(retrieved!.completedAt).toBeUndefined()
  })

  // 39. listJobs sort order
  it('listJobs sorts by specified column and order', async () => {
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

  // 40. Ack already completed job without token
  it('ack without token on already completed job still returns alreadyCompleted=false', async () => {
    const job = makeJob()
    await adapter.enqueue(job)
    await adapter.dequeue('default', 1)

    // First ack
    await adapter.ack(job.id)
    // Second ack without token (still updates, returns false because there are changes)
    const result = await adapter.ack(job.id)
    // The UPDATE will match the row (no token check) so changes > 0
    expect(result.alreadyCompleted).toBe(false)
  })
})
