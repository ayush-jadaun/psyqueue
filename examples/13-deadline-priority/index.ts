/**
 * Example 13: Deadline-Aware Priority Boosting
 *
 * Demonstrates:
 *   - Jobs with deadlines that get their priority boosted as the deadline approaches
 *   - Urgency curves: 'linear', 'exponential', 'step', and a custom function
 *   - job:priority-boosted events fired periodically as deadlines close in
 *   - job:deadline-missed events when a job is not processed before its deadline
 *   - onDeadlineMiss: 'fail' moves overdue jobs directly to dead letter
 *   - computePriority() for calculating the current effective priority
 *
 * Run: npx tsx examples/13-deadline-priority/index.ts
 */

import { PsyQueue } from 'psyqueue'
import { sqlite } from '@psyqueue/backend-sqlite'
import { deadlinePriority } from '@psyqueue/plugin-deadline-priority'

async function main() {
  console.log('=== Deadline-Aware Priority Boosting ===\n')

  const q = new PsyQueue()
  q.use(sqlite({ path: ':memory:' }))

  // Use the 'exponential' urgency curve:
  // - Priority stays near the base until ~50% of time has elapsed (boostThreshold)
  // - Then it climbs exponentially toward maxBoost as the deadline approaches
  const dpPlugin = deadlinePriority({
    urgencyCurve: 'exponential',
    boostThreshold: 0.5,    // Start boosting when 50% of total time remains
    maxBoost: 95,           // Maximum priority value (out of 100)
    interval: 200,          // Recalculate priorities every 200ms (fast for demo)
    onDeadlineMiss: 'move-to-dead-letter',  // Dead-letter overdue jobs
  }) as ReturnType<typeof deadlinePriority> & {
    computePriority(job: { createdAt: Date; deadline?: Date; priority: number }): number
    getTrackedCount(): number
  }

  q.use(dpPlugin)

  // ── Handlers ───────────────────────────────────────────────────────────────

  q.handle('urgent-task', async (ctx) => {
    const { taskName } = ctx.job.payload as { taskName: string }
    const priority = ctx.job.priority
    console.log(`  [urgent-task] Processing "${taskName}"  priority=${priority}  deadline=${ctx.job.deadline?.toISOString()}`)
    return { done: true, taskName, processedAt: new Date().toISOString() }
  })

  q.handle('normal-task', async (ctx) => {
    const { taskName } = ctx.job.payload as { taskName: string }
    console.log(`  [normal-task] Processing "${taskName}"`)
    return { done: true, taskName }
  })

  // ── Events ─────────────────────────────────────────────────────────────────

  q.events.on('job:priority-boosted', (e) => {
    const d = e.data as {
      jobId: string
      oldPriority: number
      newPriority: number
      timeRemainingPct: number
    }
    console.log(
      `  [event] job:priority-boosted  id=${d.jobId.slice(0, 8)}` +
      `  ${d.oldPriority.toFixed(1)} → ${d.newPriority.toFixed(1)}` +
      `  timeLeft=${(d.timeRemainingPct * 100).toFixed(0)}%`,
    )
  })

  q.events.on('job:deadline-missed', (e) => {
    const d = e.data as { jobId: string; deadline: Date; action: string }
    console.log(`  [event] job:deadline-missed  id=${d.jobId.slice(0, 8)}  action=${d.action}`)
  })

  q.events.on('job:completed', (e) => {
    const d = e.data as { name: string; result: { taskName: string } }
    console.log(`  [event] job:completed  name=${d.name}  task=${d.result?.taskName}`)
  })

  q.events.on('job:dead', (e) => {
    const d = e.data as { name: string }
    console.log(`  [event] job:dead  name=${d.name}  (deadline missed — dead-lettered)`)
  })

  await q.start()
  console.log('Queue started.\n')

  // ── Enqueue jobs with different deadlines ─────────────────────────────────

  console.log('-- Enqueuing jobs with deadlines --\n')

  // Job A: 4-second deadline — should be processed in time
  const now = Date.now()
  const jobAId = await q.enqueue(
    'urgent-task',
    { taskName: 'Report Generation' },
    {
      priority: 10,
      deadline: new Date(now + 4_000),  // 4 seconds from now
    },
  )
  console.log(`  Job A (4s deadline): ${jobAId.slice(0, 8)}`)

  // Job B: 8-second deadline — lower urgency initially
  const jobBId = await q.enqueue(
    'urgent-task',
    { taskName: 'Data Export' },
    {
      priority: 10,
      deadline: new Date(now + 8_000),  // 8 seconds from now
    },
  )
  console.log(`  Job B (8s deadline): ${jobBId.slice(0, 8)}`)

  // Job C: no deadline — static priority
  await q.enqueue(
    'normal-task',
    { taskName: 'Background Sync' },
    { priority: 5 },
  )
  console.log(`  Job C (no deadline): static priority=5`)

  // Job D: already expired deadline — will be dead-lettered on processing
  const jobDId = await q.enqueue(
    'urgent-task',
    { taskName: 'Overdue Report' },
    {
      priority: 20,
      deadline: new Date(now - 1_000),  // 1 second in the PAST
    },
  )
  console.log(`  Job D (past deadline): ${jobDId.slice(0, 8)}`)

  // ── Show priority at different time snapshots ─────────────────────────────

  console.log('\n-- Priority snapshots over time --')
  const mockJobA = {
    createdAt: new Date(now),
    deadline: new Date(now + 4_000),
    priority: 10,
  }
  const mockJobB = {
    createdAt: new Date(now),
    deadline: new Date(now + 8_000),
    priority: 10,
  }
  console.log(`  t=0s   Job A priority: ${dpPlugin.computePriority(mockJobA).toFixed(1)}`)
  console.log(`         Job B priority: ${dpPlugin.computePriority(mockJobB).toFixed(1)}`)

  // Simulate 2s elapsed
  const twoSecondsLater = {
    ...mockJobA,
    createdAt: new Date(now - 2_000),
    deadline: new Date(now + 2_000),
  }
  console.log(`  t=2s   Job A (2s left) priority: ${dpPlugin.computePriority(twoSecondsLater).toFixed(1)}`)

  // ── Let priority boosts accumulate, then process ──────────────────────────

  console.log('\n-- Waiting 1.5s to observe priority boost events --')
  await new Promise(r => setTimeout(r, 1_500))

  console.log(`\n  Tracked jobs with deadlines: ${dpPlugin.getTrackedCount()}`)

  console.log('\n-- Processing all jobs --')
  for (let i = 0; i < 10; i++) {
    const processed = await q.processNext('default')
    if (!processed) break
  }

  // Alternative: use startWorker() for continuous processing (production pattern)
  // In production, replace the manual loop with:
  //
  // q.startWorker('default', { concurrency: 5, pollInterval: 50 })
  //
  // The deadline-priority plugin periodically recalculates priorities in the
  // background. startWorker() dequeues jobs in priority order, so deadline-
  // approaching jobs are automatically processed first.

  await q.stop()
  console.log('\nDone!')
}

main().catch(console.error)
