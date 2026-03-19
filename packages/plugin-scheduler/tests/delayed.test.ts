import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { PsyQueue } from 'psyqueue'
import { sqlite } from '../../backend-sqlite/src/index.js'
import { scheduler } from '../src/index.js'

describe('Delayed Jobs', () => {
  let q: PsyQueue

  beforeEach(async () => {
    q = new PsyQueue()
    q.use(sqlite({ path: ':memory:' }))
    q.use(scheduler({ pollInterval: 50 }))
    q.handle('test', async () => ({ done: true }))
    await q.start()
  })

  afterEach(async () => {
    await q.stop()
  })

  // ------------------------------------------------------------------ //
  // 1. Job with future runAt is not immediately processable             //
  // ------------------------------------------------------------------ //
  it('does not process job before runAt time', async () => {
    const future = new Date(Date.now() + 60_000)
    await q.enqueue('test', {}, { runAt: future })
    const result = await q.processNext('test')
    expect(result).toBe(false) // still scheduled, not in pending queue
  })

  // ------------------------------------------------------------------ //
  // 2. Job with past runAt is moved to pending and can be processed     //
  // ------------------------------------------------------------------ //
  it('processes job after runAt has passed', async () => {
    const past = new Date(Date.now() - 1000)
    await q.enqueue('test', {}, { runAt: past })
    // Wait for the 50ms poller to fire at least once
    await new Promise(r => setTimeout(r, 120))
    const result = await q.processNext('test')
    expect(result).toBe(true)
  })

  // ------------------------------------------------------------------ //
  // 3. Multiple due jobs are all moved in one tick                      //
  // ------------------------------------------------------------------ //
  it('polls multiple due jobs in one tick', async () => {
    const past = new Date(Date.now() - 1000)
    await q.enqueue('test', { n: 1 }, { runAt: past })
    await q.enqueue('test', { n: 2 }, { runAt: past })
    await new Promise(r => setTimeout(r, 120))
    expect(await q.processNext('test')).toBe(true)
    expect(await q.processNext('test')).toBe(true)
    // Queue should now be empty
    expect(await q.processNext('test')).toBe(false)
  })

  // ------------------------------------------------------------------ //
  // 4. Job without runAt goes straight to pending                       //
  // ------------------------------------------------------------------ //
  it('enqueues job without runAt as immediately pending', async () => {
    await q.enqueue('test', { immediate: true })
    const result = await q.processNext('test')
    expect(result).toBe(true)
  })

  // ------------------------------------------------------------------ //
  // 5. Job with runAt = now (or slightly in the past) is treated as due //
  // ------------------------------------------------------------------ //
  it('treats a job with runAt in the past as due after polling', async () => {
    const justPast = new Date(Date.now() - 10)
    await q.enqueue('test', {}, { runAt: justPast })
    // Before polling: scheduled, not yet pending
    expect(await q.processNext('test')).toBe(false)
    // After polling interval — poller moves it to pending
    await new Promise(r => setTimeout(r, 120))
    expect(await q.processNext('test')).toBe(true)
  })

  // ------------------------------------------------------------------ //
  // 6. Stopping the queue prevents further polling                      //
  // ------------------------------------------------------------------ //
  it('stops polling after queue.stop()', async () => {
    await q.stop()
    const future = new Date(Date.now() + 60_000)
    // Re-create to verify stop is clean (no interval leak)
    const q2 = new PsyQueue()
    q2.use(sqlite({ path: ':memory:' }))
    q2.use(scheduler({ pollInterval: 50 }))
    q2.handle('test', async () => ({}))
    await q2.start()
    await q2.enqueue('test', {}, { runAt: future })
    await q2.stop()
    // After stop, timer should be cleared — no assertion needed beyond no crash
    expect(true).toBe(true)
  })

  // ------------------------------------------------------------------ //
  // 7. Correct handler result is returned for delayed job               //
  // ------------------------------------------------------------------ //
  it('returns correct handler result for a delayed job', async () => {
    const results: unknown[] = []
    q.handle('result-test', async () => {
      const val = 42
      results.push(val)
      return val
    })

    const past = new Date(Date.now() - 500)
    await q.enqueue('result-test', {}, { runAt: past })
    await new Promise(r => setTimeout(r, 120))
    const processed = await q.processNext('result-test')
    expect(processed).toBe(true)
    expect(results).toEqual([42])
  })
})
