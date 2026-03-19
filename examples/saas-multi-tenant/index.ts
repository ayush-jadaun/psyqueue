/**
 * SaaS Multi-Tenant Example
 *
 * Demonstrates:
 *   - Tenant isolation with rate limiting per tier
 *   - Fair scheduling across tenants
 *   - Tier configuration (free vs pro vs enterprise)
 */
import { PsyQueue } from '@psyqueue/core'
import { sqlite } from '@psyqueue/backend-sqlite'
import { tenancy } from '@psyqueue/plugin-tenancy'

async function main() {
  const q = new PsyQueue()

  // 1. Register SQLite backend
  q.use(sqlite({ path: ':memory:' }))

  // 2. Register tenancy plugin with tier definitions
  const tenantTiers: Record<string, string> = {
    'tenant-free-1': 'free',
    'tenant-pro-1': 'pro',
    'tenant-ent-1': 'enterprise',
  }

  q.use(tenancy({
    tiers: {
      free: {
        weight: 1,
        rateLimit: { max: 10, window: '1m' },
        concurrency: 2,
      },
      pro: {
        weight: 5,
        rateLimit: { max: 100, window: '1m' },
        concurrency: 10,
      },
      enterprise: {
        weight: 10,
        rateLimit: { max: 1000, window: '1m' },
        concurrency: 50,
      },
    },
    resolveTier: async (tenantId: string) => {
      return tenantTiers[tenantId] ?? 'free'
    },
    scheduling: 'weighted-fair-queue',
  }))

  // 3. Register a handler
  q.handle('process-data', async (ctx) => {
    const tenantId = ctx.job.tenantId ?? 'unknown'
    console.log(`[${tenantId}] Processing: ${JSON.stringify(ctx.job.payload)}`)
    return { processed: true }
  })

  // 4. Start
  await q.start()

  // 5. Enqueue jobs for different tenants
  await q.enqueue('process-data', { action: 'analyze' }, { tenantId: 'tenant-free-1' })
  await q.enqueue('process-data', { action: 'export' }, { tenantId: 'tenant-pro-1' })
  await q.enqueue('process-data', { action: 'sync' }, { tenantId: 'tenant-ent-1' })

  console.log('Enqueued jobs for 3 tenants')

  // 6a. Process manually (one at a time)
  await q.processNext('default')
  await q.processNext('default')
  await q.processNext('default')

  // 6b. Alternative: use startWorker() for continuous processing (production pattern)
  // In production, replace the manual processNext loop with:
  //
  // q.startWorker('default', { concurrency: 10, pollInterval: 50 })
  // // ... wait for jobs to complete ...
  // await q.stopWorkers()
  //
  // startWorker() handles dequeue, dispatch, and concurrency automatically.

  await q.stop()
  console.log('Done.')
}

main().catch(console.error)
