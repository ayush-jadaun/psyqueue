import type { PsyPlugin, Kernel } from '@psyqueue/core'
import { RateLimitError } from '@psyqueue/core'
import { TierManager, type TierConfig } from './tiers.js'
import { SlidingWindowRateLimiter } from './rate-limiter.js'
import { FairScheduler, type SchedulingMode } from './fair-scheduler.js'

export type { TierConfig } from './tiers.js'
export type { SchedulingMode } from './fair-scheduler.js'
export { TierManager } from './tiers.js'
export { SlidingWindowRateLimiter } from './rate-limiter.js'
export { FairScheduler } from './fair-scheduler.js'

export interface TenancyOpts {
  tiers: Record<string, TierConfig>
  resolveTier: (tenantId: string) => Promise<string>
  scheduling: SchedulingMode
}

export function tenancy(opts: TenancyOpts): PsyPlugin {
  const tierManager = new TierManager(opts.tiers, opts.resolveTier)
  const rateLimiter = new SlidingWindowRateLimiter()

  // Pre-configure rate limiter for all known tiers (keyed by tenant, lazily)
  // We'll configure per-tenant on first encounter.
  const configuredTenants = new Set<string>()

  // Build scheduler with tier weights
  const tierWeights: Record<string, { weight: number }> = {}
  for (const [name, cfg] of Object.entries(opts.tiers)) {
    tierWeights[name] = { weight: cfg.weight }
  }
  const scheduler = new FairScheduler(opts.scheduling, tierWeights)

  return {
    name: 'tenancy',
    version: '0.1.0',
    provides: 'tenancy',
    depends: ['backend'],

    init(kernel: Kernel): void {
      // Enqueue guard: check rate limit per tenant
      kernel.pipeline(
        'enqueue',
        async (ctx, next) => {
          const tenantId = ctx.job.tenantId
          if (!tenantId) {
            // No tenantId — pass through without rate limiting
            await next()
            return
          }

          // Resolve the tenant's tier config and configure the limiter (once per tenant)
          const tierConfig = await tierManager.getTierConfig(tenantId)

          if (!configuredTenants.has(tenantId)) {
            rateLimiter.configure(tenantId, {
              max: tierConfig.rateLimit.max,
              window: tierConfig.rateLimit.window,
            })
            configuredTenants.add(tenantId)
          }

          const result = rateLimiter.check(tenantId)
          if (!result.allowed) {
            kernel.events.emit('tenancy:rate-limited', {
              tenantId,
              retryAfter: result.retryAfter,
            })
            throw new RateLimitError(tenantId, result.retryAfter ?? 0)
          }

          rateLimiter.record(tenantId)

          // Attach tenant context for downstream middleware
          ctx.tenant = {
            id: tenantId,
            tier: await tierManager.resolveTier(tenantId),
          }

          await next()
        },
        { phase: 'guard' },
      )

      // Expose tenancy management API
      kernel.expose('tenancy', {
        setTier: (tenantId: string, tier: string) => {
          tierManager.setTier(tenantId, tier)
          // Reconfigure rate limiter next time this tenant enqueues
          configuredTenants.delete(tenantId)
        },
        override: (tenantId: string, overrides: Record<string, unknown>) => {
          tierManager.override(tenantId, overrides as Parameters<TierManager['override']>[1])
          // Reconfigure rate limiter next time this tenant enqueues
          configuredTenants.delete(tenantId)
        },
        removeOverride: (tenantId: string) => {
          tierManager.removeOverride(tenantId)
          configuredTenants.delete(tenantId)
        },
        list: () => {
          return tierManager.list()
        },
        selectTenant: (pendingTenants: string[]) => {
          return scheduler.selectTenant(pendingTenants)
        },
      })
    },
  }
}
