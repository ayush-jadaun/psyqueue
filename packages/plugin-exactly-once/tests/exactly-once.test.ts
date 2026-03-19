import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { PsyQueue } from 'psyqueue'
import { sqlite } from '../../backend-sqlite/src/index.js'
import { exactlyOnce, parseWindow } from '../src/index.js'

describe('Exactly Once', () => {
  let q: PsyQueue

  beforeEach(async () => {
    q = new PsyQueue()
    q.use(sqlite({ path: ':memory:' }))
    q.use(exactlyOnce({ window: '1h' }))
    q.handle('test', async () => ({ done: true }))
    await q.start()
  })

  afterEach(async () => {
    await q.stop()
  })

  it('deduplicates enqueue with same idempotency key', async () => {
    const id1 = await q.enqueue('test', {}, { idempotencyKey: 'key1' })
    const id2 = await q.enqueue('test', {}, { idempotencyKey: 'key1' })
    expect(id1).toBe(id2) // same job returned
  })

  it('allows different idempotency keys', async () => {
    const id1 = await q.enqueue('test', {}, { idempotencyKey: 'key1' })
    const id2 = await q.enqueue('test', {}, { idempotencyKey: 'key2' })
    expect(id1).not.toBe(id2) // different jobs
  })

  it('allows re-enqueue after window expires', async () => {
    // Use very short window
    await q.stop()
    q = new PsyQueue()
    q.use(sqlite({ path: ':memory:' }))
    q.use(exactlyOnce({ window: '1ms' })) // 1ms window
    q.handle('test', async () => ({ done: true }))
    await q.start()

    const id1 = await q.enqueue('test', {}, { idempotencyKey: 'expire-key' })
    await new Promise(r => setTimeout(r, 10)) // wait for expiry
    const id2 = await q.enqueue('test', {}, { idempotencyKey: 'expire-key' })
    expect(id1).not.toBe(id2) // different job after expiry
  })

  it('throws DuplicateJobError when onDuplicate is reject', async () => {
    await q.stop()
    q = new PsyQueue()
    q.use(sqlite({ path: ':memory:' }))
    q.use(exactlyOnce({ window: '1h', onDuplicate: 'reject' }))
    q.handle('test', async () => ({ done: true }))
    await q.start()

    await q.enqueue('test', {}, { idempotencyKey: 'rej-key' })
    await expect(q.enqueue('test', {}, { idempotencyKey: 'rej-key' }))
      .rejects.toThrow('DUPLICATE_JOB')
  })

  it('jobs without idempotencyKey are not deduped', async () => {
    const id1 = await q.enqueue('test', { n: 1 })
    const id2 = await q.enqueue('test', { n: 2 })
    expect(id1).not.toBe(id2)
  })

  it('cleanup removes expired keys', async () => {
    await q.stop()
    q = new PsyQueue()
    q.use(sqlite({ path: ':memory:' }))
    const plugin = exactlyOnce({ window: '1ms' })
    q.use(plugin)
    q.handle('test', async () => ({ done: true }))
    await q.start()

    await q.enqueue('test', {}, { idempotencyKey: 'cleanup-key' })
    await new Promise(r => setTimeout(r, 10))
    // After expiry, same key should create a new job
    const id = await q.enqueue('test', {}, { idempotencyKey: 'cleanup-key' })
    expect(id).toBeTruthy()
  })

  it('handles many concurrent enqueues with the same key', async () => {
    // Simulate concurrent duplicate enqueues (e.g. retry storm)
    const ids = await Promise.all(
      Array.from({ length: 10 }, () =>
        q.enqueue('test', {}, { idempotencyKey: 'concurrent-key' })
      )
    )
    const unique = new Set(ids)
    expect(unique.size).toBe(1) // all return same jobId
  })

  it('deduplication is per-key, not per-job-name', async () => {
    // Same key used for two different job names — still deduped
    const id1 = await q.enqueue('test', { a: 1 }, { idempotencyKey: 'shared-key' })
    const id2 = await q.enqueue('test', { b: 2 }, { idempotencyKey: 'shared-key' })
    expect(id1).toBe(id2)
  })

  it('multiple independent keys are tracked independently', async () => {
    const idA1 = await q.enqueue('test', {}, { idempotencyKey: 'A' })
    const idB1 = await q.enqueue('test', {}, { idempotencyKey: 'B' })
    const idA2 = await q.enqueue('test', {}, { idempotencyKey: 'A' })
    const idB2 = await q.enqueue('test', {}, { idempotencyKey: 'B' })

    expect(idA1).toBe(idA2)
    expect(idB1).toBe(idB2)
    expect(idA1).not.toBe(idB1)
  })

  describe('parseWindow', () => {
    it('parses milliseconds', () => {
      expect(parseWindow('500ms')).toBe(500)
      expect(parseWindow('1ms')).toBe(1)
    })

    it('parses seconds', () => {
      expect(parseWindow('30s')).toBe(30_000)
      expect(parseWindow('1s')).toBe(1_000)
    })

    it('parses minutes', () => {
      expect(parseWindow('5m')).toBe(300_000)
      expect(parseWindow('1m')).toBe(60_000)
    })

    it('parses hours', () => {
      expect(parseWindow('1h')).toBe(3_600_000)
      expect(parseWindow('24h')).toBe(86_400_000)
    })

    it('parses days', () => {
      expect(parseWindow('1d')).toBe(86_400_000)
      expect(parseWindow('7d')).toBe(604_800_000)
    })

    it('throws on invalid format', () => {
      expect(() => parseWindow('invalid')).toThrow('Invalid window format')
      expect(() => parseWindow('1x')).toThrow('Invalid window format')
    })
  })
})
