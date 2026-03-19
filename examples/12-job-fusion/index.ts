/**
 * Example 12: Job Fusion (Auto-Batching)
 *
 * Demonstrates:
 *   - Defining a fusion rule that groups individual notification jobs into batches
 *   - Window-based flushing: batch is flushed after `window` ms of inactivity
 *   - Size-based flushing: batch is flushed immediately when it hits `maxBatch`
 *   - Grouping by tenant so each tenant gets its own batch
 *   - The fused job contains all original payloads merged into one array
 *   - job:fused event with originalJobIds and count
 *   - 100 individual jobs becoming 10 batches (10 per tenant)
 *
 * Run: npx tsx examples/12-job-fusion/index.ts
 */

import { PsyQueue } from '@psyqueue/core'
import { sqlite } from '@psyqueue/backend-sqlite'
import { jobFusion } from '@psyqueue/plugin-job-fusion'
import type { Job } from '@psyqueue/core'

async function main() {
  console.log('=== Job Fusion (Auto-Batching) ===\n')

  const q = new PsyQueue()
  q.use(sqlite({ path: ':memory:' }))

  // Define a fusion rule for 'notify-user' jobs.
  // Jobs are grouped by tenantId, batched up to 10 per flush, with a 500ms window.
  const fusionPlugin = jobFusion({
    rules: [
      {
        match: 'notify-user',           // Match jobs with this name
        groupBy: (job: Job) =>          // Group by tenantId so each tenant gets its own batch
          job.tenantId ?? 'default',
        window: 500,                    // Flush after 500ms of collecting
        maxBatch: 10,                   // Or immediately when 10 jobs accumulate
        fuse: (jobs: Job[]) => ({       // Merge individual payloads into one batch payload
          notifications: jobs.map(j => j.payload),
          count: jobs.length,
          batchedAt: new Date().toISOString(),
        }),
      },
    ],
  })
  q.use(fusionPlugin)

  // ── Handlers ───────────────────────────────────────────────────────────────

  // Handler for the FUSED job (processes all notifications in one call).
  q.handle('notify-user', async (ctx) => {
    const { notifications, count } = ctx.job.payload as {
      notifications: Array<{ userId: string; message: string }>
      count: number
      batchedAt: string
    }
    const fusionCount = ctx.job.meta['fusion.count'] as number | undefined
    const groupKey = ctx.job.meta['fusion.groupKey'] as string | undefined

    if (fusionCount !== undefined) {
      // This is a fused batch job
      console.log(`  [notify-user] BATCH tenant=${groupKey}  count=${count}`)
      for (const n of notifications) {
        console.log(`    → user=${n.userId}  msg="${n.message}"`)
      }
      return { delivered: count, tenant: groupKey }
    }

    // This is an individual (non-fused) job
    const single = ctx.job.payload as { userId: string; message: string }
    console.log(`  [notify-user] SINGLE user=${single.userId}  msg="${single.message}"`)
    return { delivered: 1 }
  })

  // ── Events ─────────────────────────────────────────────────────────────────

  let fuseEventCount = 0
  q.events.on('job:fused', (e) => {
    fuseEventCount++
    const d = e.data as { fusedJobId: string; originalJobIds: string[]; groupKey: string; count: number }
    console.log(`  [event] job:fused  tenant=${d.groupKey}  count=${d.count}  fusedId=${d.fusedJobId.slice(0, 12)}`)
  })

  q.events.on('job:completed', (e) => {
    const d = e.data as { name: string; result: unknown }
    const r = d.result as { delivered: number; tenant?: string } | null
    if (r) {
      console.log(`  [event] job:completed  delivered=${r.delivered}  tenant=${r.tenant ?? 'n/a'}`)
    }
  })

  await q.start()
  console.log('Queue started.\n')

  // ── Enqueue 100 individual notification jobs ───────────────────────────────
  // 10 tenants × 10 messages each = 100 total jobs.
  // Each tenant's 10 jobs will hit maxBatch=10 and be fused into 1 batch.
  // Result: 10 fused jobs (1 per tenant) instead of 100 individual jobs.

  const tenantCount = 10
  const jobsPerTenant = 10
  console.log(`-- Enqueueing ${tenantCount * jobsPerTenant} individual notification jobs --`)
  console.log(`   (${tenantCount} tenants × ${jobsPerTenant} notifications each)`)
  console.log(`   Expected: ${tenantCount} fused batches via maxBatch=${jobsPerTenant}\n`)

  for (let tenant = 1; tenant <= tenantCount; tenant++) {
    for (let msg = 1; msg <= jobsPerTenant; msg++) {
      await q.enqueue(
        'notify-user',
        {
          userId: `user-${tenant}-${msg}`,
          message: `Notification ${msg} from tenant ${tenant}`,
        },
        { tenantId: `tenant-${tenant}` },
      )
    }
  }

  // ── Wait briefly for fusion window to flush ───────────────────────────────

  console.log('\n-- Waiting 700ms for fusion window to flush remaining batches --')
  await new Promise(r => setTimeout(r, 700))

  // ── Process fused jobs ────────────────────────────────────────────────────

  console.log('\n-- Processing fused batch jobs --')
  let processed = true
  while (processed) {
    processed = await q.processNext('default')
  }

  // Alternative: use startWorker() for continuous processing (production pattern)
  // In production, replace the manual loop with:
  //
  // q.startWorker('default', { concurrency: 5, pollInterval: 50 })
  //
  // The fusion plugin batches jobs at enqueue time. By the time startWorker()
  // dequeues them, individual jobs have already been merged into batch jobs.

  // ── Summary ───────────────────────────────────────────────────────────────

  console.log(`\n-- Summary --`)
  console.log(`  Individual jobs enqueued: ${tenantCount * jobsPerTenant}`)
  console.log(`  Fused batch jobs created:  ${fuseEventCount}`)
  console.log(`  Reduction ratio: ${((1 - fuseEventCount / (tenantCount * jobsPerTenant)) * 100).toFixed(0)}%`)

  await q.stop()
  console.log('\nDone!')
}

main().catch(console.error)
