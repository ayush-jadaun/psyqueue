/**
 * Example 06: Multi-Tenant SaaS
 *
 * Demonstrates:
 *   - Three-tier tenancy: free / pro / enterprise with different rate limits
 *   - Per-tenant rate limiting via sliding window
 *   - Fair weighted-fair-queue scheduling across tenants
 *   - Overriding a tenant's tier at runtime
 *   - What happens when a tenant exceeds their rate limit (RateLimitError)
 *   - tenancy:rate-limited event
 *
 * Run: npx tsx examples/06-multi-tenant-saas/index.ts
 */

import { PsyQueue, RateLimitError } from 'psyqueue'
import { sqlite } from '@psyqueue/backend-sqlite'
import { tenancy } from '@psyqueue/plugin-tenancy'

async function main() {
  console.log('=== Multi-Tenant SaaS ===\n')

  // Tenant → tier mapping (in a real app this would come from a database).
  const tenantTierMap: Record<string, string> = {
    'tenant-free-1': 'free',
    'tenant-free-2': 'free',
    'tenant-pro-1': 'pro',
    'tenant-ent-1': 'enterprise',
  }

  const q = new PsyQueue()
  q.use(sqlite({ path: ':memory:' }))

  q.use(tenancy({
    // Tier definitions control rate limits, concurrency, and scheduling weight.
    tiers: {
      free: {
        weight: 1,               // Gets 1 "share" of scheduling
        rateLimit: { max: 3, window: '1m' },  // 3 enqueues per minute
        concurrency: 1,
      },
      pro: {
        weight: 5,               // Gets 5x more scheduling weight than free
        rateLimit: { max: 50, window: '1m' },
        concurrency: 10,
      },
      enterprise: {
        weight: 20,              // Highest scheduling priority
        rateLimit: { max: 500, window: '1m' },
        concurrency: 100,
      },
    },
    resolveTier: async (tenantId: string) => {
      return tenantTierMap[tenantId] ?? 'free'
    },
    scheduling: 'weighted-fair-queue',
  }))

  // ── Handlers ─────────────────────────────────────────────────────────────

  q.handle('process-data', async (ctx) => {
    const tenantId = ctx.job.tenantId ?? 'unknown'
    const action = (ctx.job.payload as { action: string }).action
    console.log(`  [process-data] tenantId=${tenantId}  action=${action}`)
    await new Promise(r => setTimeout(r, 10))
    return { processed: true, tenantId, action }
  })

  q.handle('export-report', async (ctx) => {
    const tenantId = ctx.job.tenantId ?? 'unknown'
    const format = (ctx.job.payload as { format: string }).format
    console.log(`  [export-report] tenantId=${tenantId}  format=${format}`)
    return { exported: true, tenantId }
  })

  // ── Events ────────────────────────────────────────────────────────────────

  q.events.on('job:enqueued', (e) => {
    const d = e.data as { name: string; queue: string }
    console.log(`  [event] job:enqueued   name=${d.name}`)
  })

  q.events.on('job:completed', (e) => {
    const d = e.data as { name: string; result: unknown }
    const r = d.result as { tenantId: string; action?: string }
    console.log(`  [event] job:completed  name=${d.name}  tenant=${r.tenantId}`)
  })

  q.events.on('tenancy:rate-limited', (e) => {
    const d = e.data as { tenantId: string; retryAfter: number }
    console.log(`  [event] tenancy:rate-limited  tenant=${d.tenantId}  retryAfter=${d.retryAfter}ms`)
  })

  await q.start()
  console.log('Queue started.\n')

  // ── Enqueue jobs for various tenants ─────────────────────────────────────

  console.log('-- Enqueuing jobs for enterprise and pro tenants --')
  await q.enqueue('export-report', { format: 'pdf' }, { tenantId: 'tenant-ent-1', priority: 10 })
  await q.enqueue('process-data', { action: 'sync-crm' }, { tenantId: 'tenant-pro-1', priority: 5 })
  await q.enqueue('process-data', { action: 'analyze' }, { tenantId: 'tenant-ent-1' })
  await q.enqueue('process-data', { action: 'import' }, { tenantId: 'tenant-pro-1' })

  console.log('\n-- Enqueuing jobs for free tenant (limit: 3 per minute) --')
  await q.enqueue('process-data', { action: 'task-1' }, { tenantId: 'tenant-free-1' })
  await q.enqueue('process-data', { action: 'task-2' }, { tenantId: 'tenant-free-1' })
  await q.enqueue('process-data', { action: 'task-3' }, { tenantId: 'tenant-free-1' })

  // This 4th enqueue for the free tenant should trigger rate limiting.
  console.log('\n-- Attempting 4th enqueue for free tenant (should be rate-limited) --')
  try {
    await q.enqueue('process-data', { action: 'task-4' }, { tenantId: 'tenant-free-1' })
    console.log('  (No rate limit — limit was not reached yet)')
  } catch (err) {
    if (err instanceof RateLimitError) {
      console.log(`  RateLimitError caught: tenant=${err.tenantId}  retryAfter=${err.retryAfter}ms`)
      console.log('  Tenant-free-1 must wait before enqueuing more jobs.')
    } else {
      throw err
    }
  }

  // ── Runtime tier upgrade ─────────────────────────────────────────────────

  console.log('\n-- Upgrading tenant-free-2 from free → pro at runtime --')
  const tenancyApi = q.getExposed('tenancy') as {
    setTier: (tenantId: string, tier: string) => void
    list: () => unknown[]
  }
  tenancyApi.setTier('tenant-free-2', 'pro')
  tenantTierMap['tenant-free-2'] = 'pro'
  console.log('  Upgrade applied. tenant-free-2 now has pro rate limits.')

  // Now the upgraded tenant can enqueue more freely.
  for (let i = 0; i < 5; i++) {
    await q.enqueue('process-data', { action: `upgraded-task-${i + 1}` }, { tenantId: 'tenant-free-2' })
  }
  console.log('  Enqueued 5 jobs for newly upgraded tenant-free-2.')

  // ── Process all jobs ─────────────────────────────────────────────────────

  console.log('\n-- Processing all jobs --')
  let processed = true
  while (processed) {
    processed = await q.processNext('default')
  }

  // Alternative: use startWorker() for continuous processing (production pattern)
  // In production, replace the manual processNext loop with:
  //
  // q.startWorker('default', { concurrency: 10, pollInterval: 50 })
  //
  // The tenancy plugin's rate limiting and fair scheduling apply identically
  // whether processing happens via processNext() or startWorker().

  await q.stop()
  console.log('\nDone!')
}

main().catch(console.error)
