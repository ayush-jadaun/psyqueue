/**
 * Example 02: Delayed Jobs and Cron Scheduling
 *
 * Demonstrates:
 *   - Scheduling a job to run at a future time with `runAt`
 *   - Recurring jobs via cron expressions using `cron`
 *   - The scheduler plugin polling for due jobs
 *   - Observing job:enqueued events for both delayed and cron jobs
 *
 * Run: npx tsx examples/02-delayed-and-cron/index.ts
 */

import { PsyQueue } from 'psyqueue'
import { sqlite } from '@psyqueue/backend-sqlite'
import { scheduler } from '@psyqueue/plugin-scheduler'

async function main() {
  console.log('=== Delayed Jobs and Cron Scheduling ===\n')

  const q = new PsyQueue()
  q.use(sqlite({ path: ':memory:' }))

  // The scheduler plugin handles two things:
  //  1. Delayed jobs: routes runAt jobs through backend.scheduleAt(),
  //     then polls periodically to move them to "pending" when due.
  //  2. Cron jobs: after a cron job completes, automatically schedules
  //     the next occurrence.
  q.use(scheduler({
    pollInterval: 500,     // Check for due scheduled jobs every 500 ms
    cronLockTtl: 60_000,   // Distributed lock TTL for cron leader election
  }))

  // --- Register handlers ---

  q.handle('generate-report', async (ctx) => {
    const { reportType } = ctx.job.payload as { reportType: string }
    console.log(`  [generate-report] Generating ${reportType} report at ${new Date().toISOString()}`)
    return { reportType, generatedAt: new Date().toISOString() }
  })

  q.handle('cleanup-temp-files', async (ctx) => {
    console.log(`  [cleanup-temp-files] Running scheduled cleanup at ${new Date().toISOString()}`)
    // In production this would delete old files, expired sessions, etc.
    return { cleaned: true }
  })

  q.handle('heartbeat', async (ctx) => {
    console.log(`  [heartbeat] Ping! attempt=${ctx.job.attempt} at ${new Date().toISOString()}`)
    return { alive: true }
  })

  // --- Event subscriptions ---

  q.events.on('job:enqueued', (e) => {
    const d = e.data as { jobId: string; name: string }
    console.log(`  [event] job:enqueued  name=${d.name}`)
  })

  q.events.on('job:completed', (e) => {
    const d = e.data as { jobId: string; name: string }
    console.log(`  [event] job:completed name=${d.name}`)
  })

  await q.start()
  console.log('Queue started.\n')

  // --- Delayed job: run 2 seconds in the future ---
  console.log('-- Scheduling delayed job (runAt: +2s) --')
  const delayedId = await q.enqueue(
    'generate-report',
    { reportType: 'monthly-sales' },
    {
      runAt: new Date(Date.now() + 2_000),  // 2 seconds from now
      priority: 5,
    },
  )
  console.log(`  Scheduled report job: ${delayedId}`)

  // --- Another delayed job: run 4 seconds from now ---
  console.log('\n-- Scheduling delayed job (runAt: +4s) --')
  const delayedId2 = await q.enqueue(
    'generate-report',
    { reportType: 'weekly-metrics' },
    { runAt: new Date(Date.now() + 4_000) },
  )
  console.log(`  Scheduled metrics report job: ${delayedId2}`)

  // --- Cron job: runs every minute (for demo we show the concept) ---
  // The cron expression '0 * * * *' means "at minute 0 of every hour".
  // For demo purposes we use '* * * * *' (every minute). After each completion,
  // the scheduler automatically enqueues the next occurrence.
  console.log('\n-- Registering cron job (every minute) --')
  const cronId = await q.enqueue(
    'cleanup-temp-files',
    {},
    { cron: '* * * * *' },  // Standard cron: every minute
  )
  console.log(`  Registered cron job: ${cronId}`)

  // A faster heartbeat cron is impractical via cron syntax (min resolution = 1 min),
  // but you can use runAt in a loop to simulate sub-minute intervals.
  console.log('\n-- Scheduling heartbeat every 1.5s (via runAt loop) --')
  for (let i = 0; i < 3; i++) {
    await q.enqueue(
      'heartbeat',
      { sequence: i + 1 },
      { runAt: new Date(Date.now() + (i + 1) * 1_500) },
    )
  }

  // --- Poll and process while waiting for scheduled jobs to become due ---
  console.log('\nWaiting for scheduled jobs to become due...')
  const deadline = Date.now() + 6_000  // Wait up to 6 seconds
  while (Date.now() < deadline) {
    await q.processNext('default')
    await new Promise(r => setTimeout(r, 300))
  }

  await q.stop()
  console.log('\nDone!')
}

main().catch(console.error)
