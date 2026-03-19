import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { SyncEngine } from '../src/sync-engine.js'
import { offlineSync } from '../src/index.js'
import { PsyQueue } from 'psyqueue'
import { sqlite } from '../../backend-sqlite/src/index.js'
import type { Job, BackendAdapter } from 'psyqueue'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

function createTestJob(overrides: Partial<Job> = {}): Job {
  const id = `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  return {
    id,
    queue: 'default',
    name: 'test-job',
    payload: { data: 'hello' },
    priority: 0,
    maxRetries: 3,
    attempt: 0,
    backoff: 'exponential' as const,
    timeout: 30000,
    status: 'pending' as const,
    createdAt: new Date(),
    meta: {},
    ...overrides,
  }
}

function getTmpDbPath(): string {
  return path.join(os.tmpdir(), `psyqueue-offline-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`)
}

describe('SyncEngine', () => {
  let localPath: string
  let mockBackend: BackendAdapter
  let enqueuedJobs: Job[]

  beforeEach(() => {
    localPath = getTmpDbPath()
    enqueuedJobs = []
    mockBackend = {
      name: 'mock',
      type: 'mock',
      connect: async () => {},
      disconnect: async () => {},
      healthCheck: async () => true,
      enqueue: async (job: Job) => {
        enqueuedJobs.push(job)
        return job.id
      },
      enqueueBulk: async (jobs: Job[]) => {
        enqueuedJobs.push(...jobs)
        return jobs.map(j => j.id)
      },
      dequeue: async () => [],
      ack: async () => ({ alreadyCompleted: false }),
      nack: async () => {},
      getJob: async () => null,
      listJobs: async () => ({ data: [], total: 0, limit: 0, offset: 0, hasMore: false }),
      scheduleAt: async (job: Job) => job.id,
      pollScheduled: async () => [],
      acquireLock: async () => true,
      releaseLock: async () => {},
      atomic: async () => {},
    }
  })

  afterEach(() => {
    try { fs.unlinkSync(localPath) } catch (_e) { /* ignore */ }
    try { fs.unlinkSync(localPath + '-wal') } catch (_e) { /* ignore */ }
    try { fs.unlinkSync(localPath + '-shm') } catch (_e) { /* ignore */ }
  })

  it('buffers a job locally', async () => {
    const engine = new SyncEngine({ localPath, remote: mockBackend })
    const job = createTestJob()

    const id = await engine.enqueueLocal(job)
    expect(id).toBe(job.id)
    expect(engine.unsyncedCount()).toBe(1)

    const local = engine.listLocal()
    expect(local).toHaveLength(1)
    expect(local[0]!.id).toBe(job.id)
    expect(local[0]!.synced).toBe(false)

    engine.close()
  })

  it('syncs buffered jobs to remote via push()', async () => {
    const engine = new SyncEngine({ localPath, remote: mockBackend })

    const job1 = createTestJob({ id: 'job-1' })
    const job2 = createTestJob({ id: 'job-2' })

    await engine.enqueueLocal(job1)
    await engine.enqueueLocal(job2)
    expect(engine.unsyncedCount()).toBe(2)

    const synced = await engine.push()
    expect(synced).toBe(2)
    expect(engine.unsyncedCount()).toBe(0)
    expect(enqueuedJobs).toHaveLength(2)
    expect(enqueuedJobs[0]!.id).toBe('job-1')
    expect(enqueuedJobs[1]!.id).toBe('job-2')

    engine.close()
  })

  it('deduplicates by idempotency key', async () => {
    const engine = new SyncEngine({ localPath, remote: mockBackend })

    const job1 = createTestJob({ id: 'job-1', idempotencyKey: 'unique-key' })
    const job2 = createTestJob({ id: 'job-2', idempotencyKey: 'unique-key' })

    const id1 = await engine.enqueueLocal(job1)
    const id2 = await engine.enqueueLocal(job2)

    expect(id1).toBe('job-1')
    expect(id2).toBe('job-1') // Returns existing ID
    expect(engine.unsyncedCount()).toBe(1) // Only one job buffered

    engine.close()
  })

  it('respects maxLocalJobs buffer limit', async () => {
    const engine = new SyncEngine({ localPath, remote: mockBackend, maxLocalJobs: 2 })

    await engine.enqueueLocal(createTestJob({ id: 'j1' }))
    await engine.enqueueLocal(createTestJob({ id: 'j2' }))

    await expect(
      engine.enqueueLocal(createTestJob({ id: 'j3' })),
    ).rejects.toThrow(/buffer full/i)

    expect(engine.unsyncedCount()).toBe(2)

    engine.close()
  })

  it('stops syncing if remote fails mid-push', async () => {
    let callCount = 0
    const failingBackend: BackendAdapter = {
      ...mockBackend,
      enqueue: async (job: Job) => {
        callCount++
        if (callCount >= 2) {
          throw new Error('Remote unavailable')
        }
        enqueuedJobs.push(job)
        return job.id
      },
    }

    const engine = new SyncEngine({ localPath, remote: failingBackend })

    await engine.enqueueLocal(createTestJob({ id: 'j1' }))
    await engine.enqueueLocal(createTestJob({ id: 'j2' }))
    await engine.enqueueLocal(createTestJob({ id: 'j3' }))

    const synced = await engine.push()
    expect(synced).toBe(1) // Only first job synced
    expect(engine.unsyncedCount()).toBe(2)

    engine.close()
  })
})

describe('Offline Sync Plugin Integration', () => {
  let q: PsyQueue
  let localPath: string

  beforeEach(() => {
    localPath = getTmpDbPath()
    q = new PsyQueue()
  })

  afterEach(async () => {
    try { await q.stop() } catch (_e) { /* ignore */ }
    try { fs.unlinkSync(localPath) } catch (_e) { /* ignore */ }
    try { fs.unlinkSync(localPath + '-wal') } catch (_e) { /* ignore */ }
    try { fs.unlinkSync(localPath + '-shm') } catch (_e) { /* ignore */ }
  })

  it('exposes sync engine API', async () => {
    q.use(sqlite({ path: ':memory:' }))
    q.use(offlineSync({ localPath, maxLocalJobs: 100 }))
    await q.start()

    const api = q.getExposed('offline-sync') as { unsyncedCount: () => number; listLocal: () => unknown[] }
    expect(api).toBeDefined()
    expect(api.unsyncedCount()).toBe(0)
    expect(api.listLocal()).toHaveLength(0)
  })

  it('processes jobs normally when remote is available', async () => {
    q.use(sqlite({ path: ':memory:' }))
    q.use(offlineSync({ localPath }))

    let processed = false
    q.handle('task', async () => {
      processed = true
      return 'done'
    })

    await q.start()
    await q.enqueue('task', { data: 1 }, { queue: 'default' })
    await q.processNext('default')

    expect(processed).toBe(true)
  })
})
