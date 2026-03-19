/**
 * SaaS Multi-Tenant Example
 *
 * Demonstrates:
 *   - Tenant isolation with rate limiting per tier
 *   - Fair scheduling across tenants
 *   - Tier configuration (free vs pro vs enterprise)
 */
import { PsyQueue } from 'psyqueue'
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
        rateLimit: { max: 10, window: 60_000 },
        maxConcurrency: 2,
        maxJobsPerMinute: 10,
        features: ['basic'],
      },
      pro: {
        weight: 5,
        rateLimit: { max: 100, window: 60_000 },
        maxConcurrency: 10,
        maxJobsPerMinute: 100,
        features: ['basic', 'priority', 'webhooks'],
      },
      enterprise: {
        weight: 10,
        rateLimit: { max: 1000, window: 60_000 },
        maxConcurrency: 50,
        maxJobsPerMinute: 1000,
        features: ['basic', 'priority', 'webhooks', 'dedicated'],
      },
    },
    resolveTier: async (tenantId: string) => {
      return tenantTiers[tenantId] ?? 'free'
    },
    scheduling: 'weighted-round-robin',
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

  // 6. Process
  await q.processNext('default')
  await q.processNext('default')
  await q.processNext('default')

  await q.stop()
  console.log('Done.')
}

main().catch(console.error)
