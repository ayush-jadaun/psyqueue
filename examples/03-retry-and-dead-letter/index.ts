/**
 * Example 03: Retry Behaviour and Dead Letter Queue
 *
 * Demonstrates:
 *   - Configuring max retries and backoff strategies (exponential, fixed, linear)
 *   - Jobs moving through the retry cycle on failure
 *   - A job that exhausts retries landing in the dead letter queue
 *   - Listing dead letter jobs, replaying a single job, and replayAll
 *   - Purging dead letter entries
 *
 * Run: npx tsx examples/03-retry-and-dead-letter/index.ts
 */

import { PsyQueue } from 'psyqueue'
import { sqlite } from '@psyqueue/backend-sqlite'

// Track call counts to simulate transient failures.
const callCounts: Record<string, number> = {}

async function main() {
  console.log('=== Retry Behaviour and Dead Letter Queue ===\n')

  const q = new PsyQueue()
  q.use(sqlite({ path: ':memory:' }))

  // ── Handlers ────────────────────────────────────────────────────────────────

  // This job fails the first two times, then succeeds on attempt 3.
  q.handle('flaky-api-call', async (ctx) => {
    const jobId = ctx.job.id.slice(0, 8)
    callCounts[jobId] = (callCounts[jobId] ?? 0) + 1
    const attempt = callCounts[jobId]!

    console.log(`  [flaky-api-call] attempt ${attempt}/${ctx.job.maxRetries + 1}`)

    if (attempt < 3) {
      throw new Error(`Transient network timeout (attempt ${attempt})`)
    }

    console.log(`  [flaky-api-call] Succeeded on attempt ${attempt}!`)
    return { ok: true, attempt }
  })

  // This job always fails — it will exhaust retries and land in the dead letter queue.
  q.handle('always-fails', async (ctx) => {
    console.log(`  [always-fails] attempt ${ctx.job.attempt + 1}/${ctx.job.maxRetries + 1} — throwing`)
    throw new Error('Fatal: upstream service permanently unavailable')
  })

  // ── Events ──────────────────────────────────────────────────────────────────

  q.events.on('job:retry', (e) => {
    const d = e.data as { jobId: string; name: string; attempt: number; delay: number; error: string }
    console.log(`  [event] job:retry   name=${d.name}  attempt=${d.attempt}  delay=${d.delay}ms  error="${d.error}"`)
  })

  q.events.on('job:dead', (e) => {
    const d = e.data as { jobId: string; name: string }
    console.log(`  [event] job:dead    name=${d.name}  id=${d.jobId.slice(0, 8)}`)
  })

  q.events.on('job:completed', (e) => {
    const d = e.data as { jobId: string; name: string; result: unknown }
    console.log(`  [event] job:completed name=${d.name}  result=${JSON.stringify(d.result)}`)
  })

  q.events.on('job:replayed', (e) => {
    const d = e.data as { jobId: string; name: string }
    console.log(`  [event] job:replayed  name=${d.name}  id=${d.jobId.slice(0, 8)}`)
  })

  await q.start()
  console.log('Queue started.\n')

  // ── Enqueue jobs ─────────────────────────────────────────────────────────────

  // Job 1: will eventually succeed after 2 failures
  // Uses exponential backoff: delay doubles each retry (1s → 2s → 4s …)
  console.log('-- Enqueue flaky job (will succeed on attempt 3) --')
  await q.enqueue('flaky-api-call', { endpoint: '/api/orders' }, {
    maxRetries: 4,
    backoff: 'exponential',
    backoffBase: 100,    // Start at 100ms (scaled for demo)
    backoffCap: 5_000,   // Cap at 5 seconds
    backoffJitter: false, // Disable jitter for predictable output
  })

  // Job 2: always fails — uses fixed backoff
  console.log('-- Enqueue always-failing job (2 retries → dead letter) --')
  const failingId = await q.enqueue('always-fails', { service: 'payments' }, {
    maxRetries: 2,
    backoff: 'fixed',
    backoffBase: 50,
  })
  console.log(`  Enqueued: ${failingId.slice(0, 8)}\n`)

  // ── Process until queues are empty ──────────────────────────────────────────

  console.log('-- Processing (retries happen inline via re-enqueue) --')
  // Each processNext picks up one job. Retried jobs are re-enqueued with a delay,
  // so we loop until there's nothing left.
  for (let i = 0; i < 30; i++) {
    const didWork = await q.processNext('default')
    if (!didWork) break
  }

  // Alternative: use startWorker() for continuous processing (production pattern)
  // In production, replace the manual loop above with:
  //
  // q.startWorker('default', { concurrency: 5, pollInterval: 50 })
  //
  // startWorker() automatically retries failed jobs according to backoff settings.
  // Retried jobs go through the same handler — the retry count is tracked per-job.

  // ── Inspect the dead letter queue ───────────────────────────────────────────

  console.log('\n-- Dead letter queue --')
  const deadResult = await q.deadLetter.list()
  console.log(`  Total dead jobs: ${deadResult.total}`)
  for (const job of deadResult.data) {
    console.log(`    id=${job.id.slice(0, 8)}  name=${job.name}  error="${job.error?.message}"`)
  }

  // ── Replay a dead job ───────────────────────────────────────────────────────

  if (deadResult.data.length > 0) {
    const deadJobId = deadResult.data[0]!.id
    console.log(`\n-- Replaying dead job ${deadJobId.slice(0, 8)} --`)
    await q.deadLetter.replay(deadJobId)
    // The replayed job re-enters the queue; process it once more
    await q.processNext('default')
  }

  // ── Replay all dead jobs ─────────────────────────────────────────────────────

  // Re-enqueue another always-fails job to demonstrate replayAll
  await q.enqueue('always-fails', { service: 'inventory' }, { maxRetries: 0 })
  await q.processNext('default') // Let it fail and die

  console.log('\n-- Replay all dead jobs --')
  const replayCount = await q.deadLetter.replayAll()
  console.log(`  Replayed ${replayCount} dead jobs`)

  // ── Purge dead letter ────────────────────────────────────────────────────────

  // Let them fail again and then purge
  for (let i = 0; i < 10; i++) await q.processNext('default')
  console.log('\n-- Purging dead letter queue --')
  const purged = await q.deadLetter.purge()
  console.log(`  Purged ${purged} dead jobs`)

  const afterPurge = await q.deadLetter.list()
  console.log(`  Dead jobs remaining: ${afterPurge.total}`)

  await q.stop()
  console.log('\nDone!')
}

main().catch(console.error)
