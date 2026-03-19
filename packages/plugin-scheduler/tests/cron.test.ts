import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { PsyQueue } from 'psyqueue'
import { sqlite } from '../../backend-sqlite/src/index.js'
import { scheduler, computeNextRunAt } from '../src/index.js'
import type { BackendAdapter } from 'psyqueue'

// ------------------------------------------------------------------ //
// Unit tests for computeNextRunAt (no I/O)                           //
// ------------------------------------------------------------------ //
describe('computeNextRunAt', () => {
  it('returns a future Date for a valid cron expression', () => {
    const next = computeNextRunAt('* * * * *')
    expect(next).toBeInstanceOf(Date)
    expect(next!.getTime()).toBeGreaterThan(Date.now())
  })

  it('returns a Date after the given reference time', () => {
    const ref = new Date('2024-01-01T00:00:00Z')
    const next = computeNextRunAt('0 9 * * 1', ref) // every Monday at 09:00
    expect(next).toBeInstanceOf(Date)
    expect(next!.getTime()).toBeGreaterThan(ref.getTime())
  })

  it('returns null for an invalid cron expression', () => {
    const next = computeNextRunAt('not-a-cron')
    expect(next).toBeNull()
  })
})

// ------------------------------------------------------------------ //
// Integration tests: cron scheduling via the plugin                  //
// ------------------------------------------------------------------ //
describe('Cron Jobs', () => {
  let q: PsyQueue

  beforeEach(async () => {
    q = new PsyQueue()
    q.use(sqlite({ path: ':memory:' }))
    q.use(scheduler({ pollInterval: 50, cronLockTtl: 5000 }))
    q.handle('cleanup', async () => ({ cleaned: true }))
    q.handle('failing', async () => { throw new Error('always fails') })
    await q.start()
  })

  afterEach(async () => {
    await q.stop()
  })

  function getBackend(queue: PsyQueue): BackendAdapter {
    return queue.getExposed('backend') as BackendAdapter
  }

  // ------------------------------------------------------------------ //
  // 4. schedules next occurrence after job completes                    //
  // ------------------------------------------------------------------ //
  it('schedules next occurrence after job completes', async () => {
    // Enqueue a cron job with past runAt so it is immediately due
    const past = new Date(Date.now() - 500)
    await q.enqueue('cleanup', {}, { cron: '* * * * *', runAt: past })

    // Wait for poller to move it to pending
    await new Promise(r => setTimeout(r, 120))

    // Process the job
    const processed = await q.processNext('cleanup')
    expect(processed).toBe(true)

    // Wait for the async job:completed handler to schedule the next run
    await new Promise(r => setTimeout(r, 150))

    // There should now be a new scheduled job for 'cleanup'
    const backend = getBackend(q)
    const jobs = await backend.listJobs({ name: 'cleanup', status: 'scheduled' })
    expect(jobs.data.length).toBeGreaterThanOrEqual(1)
    expect(jobs.data[0]!.cron).toBe('* * * * *')
    expect(jobs.data[0]!.runAt).toBeInstanceOf(Date)
  })

  // ------------------------------------------------------------------ //
  // 5. Does not schedule next run if job was dead-lettered              //
  // ------------------------------------------------------------------ //
  it('does not schedule next run if job was dead-lettered', async () => {
    // maxRetries: 0 causes immediate dead-letter on failure (no job:completed emitted)
    const past = new Date(Date.now() - 500)
    await q.enqueue('failing', {}, { cron: '* * * * *', runAt: past, maxRetries: 0 })

    // Wait for poller to make it pending
    await new Promise(r => setTimeout(r, 120))

    // Process — handler will throw and job will be dead-lettered
    await q.processNext('failing')

    // Wait for event handlers
    await new Promise(r => setTimeout(r, 150))

    // job:completed is NOT emitted for dead-lettered jobs — no next cron run
    const backend = getBackend(q)
    const scheduled = await backend.listJobs({ name: 'failing', status: 'scheduled' })
    expect(scheduled.data.length).toBe(0)
  })

  // ------------------------------------------------------------------ //
  // 6. cron job without runAt: still processes and reschedules         //
  // ------------------------------------------------------------------ //
  it('reschedules a cron job enqueued without runAt', async () => {
    // No runAt → job is immediately pending
    await q.enqueue('cleanup', {}, { cron: '* * * * *' })
    const processed = await q.processNext('cleanup')
    expect(processed).toBe(true)

    // Wait for async handler
    await new Promise(r => setTimeout(r, 150))

    const backend = getBackend(q)
    const jobs = await backend.listJobs({ name: 'cleanup', status: 'scheduled' })
    expect(jobs.data.length).toBeGreaterThanOrEqual(1)
  })

  // ------------------------------------------------------------------ //
  // 7. Preserves original payload and cron expression in rescheduled   //
  // ------------------------------------------------------------------ //
  it('preserves original payload and cron field in rescheduled job', async () => {
    const past = new Date(Date.now() - 500)
    const payload = { task: 'purge-old-records', tenantId: 'acme' }
    await q.enqueue('cleanup', payload, { cron: '0 2 * * *', runAt: past })

    await new Promise(r => setTimeout(r, 120))
    await q.processNext('cleanup')
    await new Promise(r => setTimeout(r, 150))

    const backend = getBackend(q)
    const jobs = await backend.listJobs({ name: 'cleanup', status: 'scheduled' })
    expect(jobs.data.length).toBeGreaterThanOrEqual(1)
    const next = jobs.data[0]!
    expect(next.cron).toBe('0 2 * * *')
    expect(next.payload).toEqual(payload)
  })

  // ------------------------------------------------------------------ //
  // 8. Leader election: acquireLock is called during cron management   //
  // ------------------------------------------------------------------ //
  it('uses leader election — only processes cron when lock is held', async () => {
    const backend = getBackend(q)

    // Manually check that the lock was acquired by the cron manager
    // by verifying a job completes and gets rescheduled (which requires leader)
    await q.enqueue('cleanup', {}, { cron: '* * * * *' })
    await q.processNext('cleanup')
    await new Promise(r => setTimeout(r, 150))

    const jobs = await backend.listJobs({ name: 'cleanup', status: 'scheduled' })
    // If leader election failed entirely, no scheduled job would exist
    expect(jobs.data.length).toBeGreaterThanOrEqual(1)
  })
})
