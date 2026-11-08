import type { PsyPlugin, Kernel, BackendAdapter } from '@psyqueue/core'
import { RateLimitError } from '@psyqueue/core'
import { TierManager, type TierConfig } from './tiers.js'
import { FairScheduler, type SchedulingMode } from './fair-scheduler.js'

export type { TierConfig } from './tiers.js'
export type { SchedulingMode } from './fair-scheduler.js'
export { TierManager } from './tiers.js'
export { FairScheduler } from './fair-scheduler.js'

export interface TenancyOpts {
  tiers: Record<string, TierConfig>
  /** Look up a tenant's tier (cached for `tierCacheTtl`). */
  resolveTier: (tenantId: string) => Promise<string>
  /**
   * How tenants share workers in `queues`. 'weighted-fair-queue' (default)
   * uses tier weights, 'round-robin' gives every tenant an equal share,
   * 'strict-priority' always prefers the higher-weight tier.
   */
  scheduling?: SchedulingMode
  /** Queues whose workers schedule fairly across tenants and enforce tier concurrency. */
  queues?: string[]
  /** Tier used when resolveTier fails or returns an unknown tier. Without it, such enqueues throw. */
  defaultTier?: string
  /** How long a resolved tier is cached, in ms. Default: 60000 */
  tierCacheTtl?: number
}

const WINDOW_MS: Record<TierConfig['rateLimit']['window'], number> = { '1s': 1_000, '1m': 60_000, '1h': 3_600_000 }

/**
 * Multi-tenancy: per-tenant rate limits on enqueue, plus fair scheduling and
 * per-tenant concurrency limits on dequeue for the configured `queues`.
 *
 * Both are enforced by the backend, so they hold across all processes:
 * rate limits are an atomic sliding-window log, and fair queues pick the next
 * job by weighted fair queuing over tenants inside the backend's dequeue.
 */
export function tenancy(opts: TenancyOpts): PsyPlugin {
  const tierManager = new TierManager(opts.tiers, opts.resolveTier, {
    defaultTier: opts.defaultTier,
    cacheTtlMs: opts.tierCacheTtl ?? 60_000,
  })
  const mode = opts.scheduling ?? 'weighted-fair-queue'
  const scheduler = new FairScheduler(mode, opts.tiers, tenant => tierManager.cachedTier(tenant))
  const effectiveWeight = weightMapper(mode, opts.tiers)
  /** Last policy written to the backend per tenant, to skip redundant writes */
  const syncedPolicy = new Map<string, string>()
  let kernelRef: Kernel | null = null

  const backend = (): BackendAdapter => kernelRef!.getBackend()

  async function syncPolicy(tenantId: string, cfg: TierConfig): Promise<void> {
    const policy = {
      weight: effectiveWeight(cfg.weight),
      maxActive: Number.isFinite(cfg.concurrency) && cfg.concurrency > 0 ? cfg.concurrency : undefined,
    }
    const key = `${policy.weight}|${policy.maxActive ?? ''}`
    if (syncedPolicy.get(tenantId) === key) return
    await backend().setTenantPolicies!({ [tenantId]: policy })
    syncedPolicy.set(tenantId, key)
  }

  async function refresh(tenantId: string): Promise<void> {
    syncedPolicy.delete(tenantId)
    if (kernelRef) await syncPolicy(tenantId, await tierManager.getTierConfig(tenantId))
  }

  return {
    name: 'tenancy',
    version: '0.1.0',
    provides: 'tenancy',
    depends: ['backend'],

    init(kernel: Kernel): void {
      kernelRef = kernel

      kernel.pipeline(
        'enqueue',
        async (ctx, next) => {
          const tenantId = ctx.job.tenantId
          if (!tenantId) return next()

          const tier = await tierManager.resolveTier(tenantId)
          const cfg = await tierManager.getTierConfig(tenantId)
          await syncPolicy(tenantId, cfg)

          // ponytail: the slot is consumed even if a later step rejects the job
          const { allowed, retryAfterMs } = await backend().consumeRateLimit!(
            `tenant:${tenantId}`, cfg.rateLimit.max, WINDOW_MS[cfg.rateLimit.window],
          )
          if (!allowed) {
            kernel.events.emit('tenancy:rate-limited', { tenantId, retryAfter: retryAfterMs })
            throw new RateLimitError(tenantId, retryAfterMs)
          }

          ctx.tenant = { id: tenantId, tier }
          await next()
        },
        { phase: 'guard' },
      )

      // Handlers and later middleware see the tenant while processing too
      kernel.pipeline(
        'process',
        async (ctx, next) => {
          const tenantId = ctx.job.tenantId
          if (tenantId) ctx.tenant = { id: tenantId, tier: await tierManager.resolveTier(tenantId) }
          await next()
        },
        { phase: 'guard' },
      )

      kernel.expose('tenancy', {
        /** Change a tenant's tier now (this process; re-resolved after the cache TTL). */
        setTier: async (tenantId: string, tier: string) => {
          tierManager.setTier(tenantId, tier)
          await refresh(tenantId)
        },
        override: async (tenantId: string, overrides: Record<string, unknown>) => {
          tierManager.override(tenantId, overrides as Parameters<TierManager['override']>[1])
          await refresh(tenantId)
        },
        removeOverride: async (tenantId: string) => {
          tierManager.removeOverride(tenantId)
          await refresh(tenantId)
        },
        list: () => tierManager.list(),
        /** Pick among tenants with pending work, by tier (helper for custom schedulers). */
        selectTenant: (pendingTenants: string[]) => scheduler.selectTenant(pendingTenants),
      })
    },

    async start(): Promise<void> {
      const b = backend()
      if (!b.consumeRateLimit || !b.setTenantPolicies || !b.enableFairQueue) {
        throw new Error(`The tenancy plugin needs a backend with multi-tenancy support; "${b.name}" has none`)
      }
      for (const queue of opts.queues ?? []) await b.enableFairQueue(queue)
    },
  }
}

/** Maps a tier weight to the weight the backend scheduler uses, per mode. */
function weightMapper(mode: SchedulingMode, tiers: Record<string, TierConfig>): (w: number) => number {
  if (mode === 'round-robin') return () => 1
  if (mode === 'strict-priority') {
    // Each higher weight tier counts 1000x more: effectively strict priority
    const ranks = [...new Set(Object.values(tiers).map(t => t.weight))].sort((a, b) => a - b)
    return w => 1000 ** Math.max(0, ranks.indexOf(w))
  }
  return w => (w > 0 ? w : 1)
}
