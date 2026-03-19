import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type http from 'node:http'
import type { BackendAdapter, Job, PaginatedResult, JobFilter, DequeuedJob, AckResult, NackOpts, AtomicOp } from 'psyqueue'
import { createDashboardServer } from '../src/server.js'

// In-memory mock backend
function createMockBackend(jobs: Job[]): BackendAdapter {
  return {
    name: 'mock',
    type: 'memory',
    async connect() {},
    async disconnect() {},
    async healthCheck() { return true },
    async enqueue(job: Job) { jobs.push(job); return job.id },
    async enqueueBulk(bulk: Job[]) { jobs.push(...bulk); return bulk.map(j => j.id) },
    async dequeue(_queue: string, _count: number): Promise<DequeuedJob[]> { return [] },
    async ack(_jobId: string): Promise<AckResult> { return { alreadyCompleted: false } },
    async nack(jobId: string, opts?: NackOpts) {
      const job = jobs.find(j => j.id === jobId)
      if (job && opts?.requeue) {
        job.status = 'pending'
      }
    },
    async getJob(jobId: string) { return jobs.find(j => j.id === jobId) ?? null },
    async listJobs(filter: JobFilter): Promise<PaginatedResult<Job>> {
      let filtered = [...jobs]
      if (filter.queue) filtered = filtered.filter(j => j.queue === filter.queue)
      if (filter.status) {
        const statuses = Array.isArray(filter.status) ? filter.status : [filter.status]
        filtered = filtered.filter(j => statuses.includes(j.status))
      }
      const limit = filter.limit ?? 100
      const offset = filter.offset ?? 0
      const sliced = filtered.slice(offset, offset + limit)
      return {
        data: sliced,
        total: filtered.length,
        limit,
        offset,
        hasMore: offset + limit < filtered.length,
      }
    },
    async scheduleAt(job: Job) { jobs.push(job); return job.id },
    async pollScheduled() { return [] },
    async acquireLock() { return true },
    async releaseLock() {},
    async atomic(_ops: AtomicOp[]) {},
  }
}

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: overrides.id ?? `job-${Math.random().toString(36).slice(2, 8)}`,
    queue: overrides.queue ?? 'default',
    name: overrides.name ?? 'test-job',
    payload: overrides.payload ?? {},
    priority: overrides.priority ?? 0,
    maxRetries: overrides.maxRetries ?? 3,
    attempt: overrides.attempt ?? 1,
    backoff: overrides.backoff ?? 'exponential',
    timeout: overrides.timeout ?? 30000,
    status: overrides.status ?? 'pending',
    createdAt: overrides.createdAt ?? new Date(),
    meta: overrides.meta ?? {},
  }
}

describe('Dashboard API', () => {
  let server: http.Server
  let port: number
  const jobs: Job[] = []
  let stopFn: () => Promise<void>

  beforeAll(async () => {
    // Seed jobs
    jobs.push(
      makeJob({ id: 'j1', status: 'pending', queue: 'emails' }),
      makeJob({ id: 'j2', status: 'active', queue: 'emails' }),
      makeJob({ id: 'j3', status: 'completed', queue: 'emails' }),
      makeJob({ id: 'j4', status: 'failed', queue: 'payments' }),
      makeJob({ id: 'j5', status: 'dead', queue: 'payments' }),
    )

    const backend = createMockBackend(jobs)
    const dashboard = createDashboardServer({
      port: 0,
      getBackend: () => backend,
    })
    server = await dashboard.start()
    stopFn = dashboard.stop
    const addr = server.address()
    port = typeof addr === 'object' && addr ? addr.port : 9999
  })

  afterAll(async () => {
    await stopFn()
  })

  it('GET /api/health returns ok', async () => {
    const res = await fetch(`http://localhost:${port}/api/health`)
    expect(res.status).toBe(200)
    const data = await res.json() as Record<string, unknown>
    expect(data['status']).toBe('ok')
    expect(data['timestamp']).toBeDefined()
  })

  it('GET /api/overview returns aggregated counts', async () => {
    const res = await fetch(`http://localhost:${port}/api/overview`)
    expect(res.status).toBe(200)
    const data = await res.json() as Record<string, unknown>
    expect(data['totalPending']).toBe(1)
    expect(data['totalActive']).toBe(1)
    expect(data['totalCompleted']).toBe(1)
    // failed + dead
    expect(data['totalFailed']).toBe(2)
  })

  it('GET /api/queues lists queues with counts', async () => {
    const res = await fetch(`http://localhost:${port}/api/queues`)
    expect(res.status).toBe(200)
    const data = await res.json() as { queues: Array<{ name: string; pending: number }> }
    expect(data.queues.length).toBeGreaterThanOrEqual(2)
    const emails = data.queues.find(q => q.name === 'emails')
    expect(emails).toBeDefined()
  })

  it('GET /api/jobs filters by queue and status', async () => {
    const res = await fetch(`http://localhost:${port}/api/jobs?queue=emails&status=pending`)
    expect(res.status).toBe(200)
    const data = await res.json() as { data: Job[]; total: number }
    expect(data.total).toBe(1)
    expect(data.data[0]!.queue).toBe('emails')
  })

  it('GET /api/jobs/:id returns a specific job', async () => {
    const res = await fetch(`http://localhost:${port}/api/jobs/j1`)
    expect(res.status).toBe(200)
    const data = await res.json() as Job
    expect(data.id).toBe('j1')
  })

  it('GET /api/jobs/:id returns 404 for unknown job', async () => {
    const res = await fetch(`http://localhost:${port}/api/jobs/nonexistent`)
    expect(res.status).toBe(404)
  })

  it('POST /api/jobs/:id/retry requeues a dead job', async () => {
    const res = await fetch(`http://localhost:${port}/api/jobs/j5/retry`, { method: 'POST' })
    expect(res.status).toBe(200)
    const data = await res.json() as { success: boolean; jobId: string }
    expect(data.success).toBe(true)
    expect(data.jobId).toBe('j5')
    // Verify the job was requeued
    const job = jobs.find(j => j.id === 'j5')
    expect(job?.status).toBe('pending')
  })

  it('POST /api/jobs/:id/retry returns 400 for non-dead/failed job', async () => {
    const res = await fetch(`http://localhost:${port}/api/jobs/j1/retry`, { method: 'POST' })
    expect(res.status).toBe(400)
  })
})

describe('Dashboard API Auth', () => {
  it('rejects requests without bearer token', async () => {
    const jobs: Job[] = []
    const backend = createMockBackend(jobs)
    const dashboard = createDashboardServer({
      port: 0,
      auth: { type: 'bearer', credentials: 'secret-token' },
      getBackend: () => backend,
    })
    const srv = await dashboard.start()
    const addr = srv.address()
    const p = typeof addr === 'object' && addr ? addr.port : 9999

    const res = await fetch(`http://localhost:${p}/api/health`)
    expect(res.status).toBe(401)

    const res2 = await fetch(`http://localhost:${p}/api/health`, {
      headers: { Authorization: 'Bearer secret-token' },
    })
    expect(res2.status).toBe(200)

    await dashboard.stop()
  })

  it('rejects requests with wrong basic auth', async () => {
    const jobs: Job[] = []
    const backend = createMockBackend(jobs)
    const dashboard = createDashboardServer({
      port: 0,
      auth: { type: 'basic', credentials: 'admin:pass123' },
      getBackend: () => backend,
    })
    const srv = await dashboard.start()
    const addr = srv.address()
    const p = typeof addr === 'object' && addr ? addr.port : 9999

    const res = await fetch(`http://localhost:${p}/api/health`)
    expect(res.status).toBe(401)

    const encoded = Buffer.from('admin:pass123').toString('base64')
    const res2 = await fetch(`http://localhost:${p}/api/health`, {
      headers: { Authorization: `Basic ${encoded}` },
    })
    expect(res2.status).toBe(200)

    await dashboard.stop()
  })
})
