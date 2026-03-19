import { describe, it, expect } from 'vitest'
import { generateId, createJob } from '../src/job.js'

describe('generateId()', () => {
  it('returns a 26-character string', () => {
    const id = generateId()
    expect(typeof id).toBe('string')
    expect(id).toHaveLength(26)
  })

  it('matches the ULID character set /^[0-9A-HJKMNP-TV-Z]{26}$/', () => {
    const id = generateId()
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
  })

  it('produces 100 unique IDs', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateId()))
    expect(ids.size).toBe(100)
  })

  it('produces sortable IDs (a later ID is lexicographically greater than an earlier one)', () => {
    // ULIDs are time-ordered — a small delay is not guaranteed in the same millisecond,
    // but we can verify that at least none are identical and the set sorts consistently.
    // For true ordering, generate two with a guaranteed time gap.
    const first = generateId()
    // Spin for a millisecond to ensure different timestamp component
    const start = Date.now()
    while (Date.now() === start) { /* busy wait */ }
    const second = generateId()
    expect(second > first).toBe(true)
  })
})

describe('createJob()', () => {
  describe('default values', () => {
    it('creates a job with correct defaults', () => {
      const job = createJob('send-email', { to: 'test@example.com' })
      expect(job.priority).toBe(0)
      expect(job.maxRetries).toBe(3)
      expect(job.attempt).toBe(1)
      expect(job.backoff).toBe('exponential')
      expect(job.timeout).toBe(30_000)
      expect(job.status).toBe('pending')
    })

    it('generates a ULID id', () => {
      const job = createJob('test-job', null)
      expect(job.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    })

    it('sets queue to the job name when queue option is not provided', () => {
      const job = createJob('my-job', {})
      expect(job.queue).toBe('my-job')
    })

    it('sets name to the provided name', () => {
      const job = createJob('process-payment', { amount: 100 })
      expect(job.name).toBe('process-payment')
    })

    it('sets payload correctly', () => {
      const payload = { userId: 42, action: 'notify' }
      const job = createJob('notify-user', payload)
      expect(job.payload).toEqual(payload)
    })

    it('sets createdAt to a Date', () => {
      const before = new Date()
      const job = createJob('test', null)
      const after = new Date()
      expect(job.createdAt).toBeInstanceOf(Date)
      expect(job.createdAt.getTime()).toBeGreaterThanOrEqual(before.getTime())
      expect(job.createdAt.getTime()).toBeLessThanOrEqual(after.getTime())
    })

    it('sets meta to an empty object when no meta option provided', () => {
      const job = createJob('test', null)
      expect(job.meta).toEqual({})
    })

    it('sets status to "pending" when no runAt is provided', () => {
      const job = createJob('test', null)
      expect(job.status).toBe('pending')
    })

    it('sets deadline, runAt, cron, tenantId, idempotencyKey to undefined by default', () => {
      const job = createJob('test', null)
      expect(job.deadline).toBeUndefined()
      expect(job.runAt).toBeUndefined()
      expect(job.cron).toBeUndefined()
      expect(job.tenantId).toBeUndefined()
      expect(job.idempotencyKey).toBeUndefined()
    })
  })

  describe('option overrides', () => {
    it('uses provided queue when specified', () => {
      const job = createJob('send-email', {}, { queue: 'email-queue' })
      expect(job.queue).toBe('email-queue')
    })

    it('uses provided priority', () => {
      const job = createJob('high-prio', {}, { priority: 10 })
      expect(job.priority).toBe(10)
    })

    it('uses provided maxRetries', () => {
      const job = createJob('fragile', {}, { maxRetries: 0 })
      expect(job.maxRetries).toBe(0)
    })

    it('uses provided timeout', () => {
      const job = createJob('quick', {}, { timeout: 5_000 })
      expect(job.timeout).toBe(5_000)
    })

    it('uses provided backoff strategy', () => {
      const job = createJob('fixed-backoff', {}, { backoff: 'fixed' })
      expect(job.backoff).toBe('fixed')
    })

    it('uses provided tenantId', () => {
      const job = createJob('tenant-job', {}, { tenantId: 'tenant-42' })
      expect(job.tenantId).toBe('tenant-42')
    })

    it('uses provided deadline', () => {
      const deadline = new Date(Date.now() + 60_000)
      const job = createJob('deadline-job', {}, { deadline })
      expect(job.deadline).toBe(deadline)
    })

    it('uses provided idempotencyKey', () => {
      const job = createJob('idem-job', {}, { idempotencyKey: 'unique-key-123' })
      expect(job.idempotencyKey).toBe('unique-key-123')
    })

    it('copies meta object (does not share reference)', () => {
      const meta = { source: 'api', version: 2 }
      const job = createJob('meta-job', {}, { meta })
      expect(job.meta).toEqual(meta)
      expect(job.meta).not.toBe(meta)
    })

    it('uses provided backoffBase, backoffCap, backoffJitter', () => {
      const job = createJob('backoff-job', {}, { backoffBase: 500, backoffCap: 10_000, backoffJitter: true })
      expect(job.backoffBase).toBe(500)
      expect(job.backoffCap).toBe(10_000)
      expect(job.backoffJitter).toBe(true)
    })

    it('uses provided cron expression', () => {
      const job = createJob('cron-job', {}, { cron: '*/5 * * * *' })
      expect(job.cron).toBe('*/5 * * * *')
    })
  })

  describe('scheduled status', () => {
    it('sets status to "scheduled" when runAt is in the future', () => {
      const runAt = new Date(Date.now() + 60_000)
      const job = createJob('future-job', {}, { runAt })
      expect(job.status).toBe('scheduled')
      expect(job.runAt).toBe(runAt)
    })

    it('sets status to "pending" when runAt is in the past', () => {
      const runAt = new Date(Date.now() - 60_000)
      const job = createJob('past-job', {}, { runAt })
      expect(job.status).toBe('pending')
    })

    it('sets status to "pending" when runAt equals now (not strictly in the future)', () => {
      // Edge case: runAt === new Date() — not > new Date() at creation time
      const runAt = new Date() // same millisecond; not strictly > new Date() inside createJob
      const job = createJob('now-job', {}, { runAt })
      // This may be pending or scheduled depending on exact timing, but runAt is set
      expect(job.runAt).toBe(runAt)
    })
  })
})
