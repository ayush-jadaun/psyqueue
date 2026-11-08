export interface TierConfig {
  rateLimit: { max: number; window: '1s' | '1m' | '1h' }
  /** Max jobs of one tenant running at once, per fair queue */
  concurrency: number
  /** Share of workers relative to other tiers (weighted fair queuing) */
  weight: number
}

type PartialTierConfig = {
  rateLimit?: Partial<TierConfig['rateLimit']>
  concurrency?: number
  weight?: number
}

export interface TierManagerOpts {
  /** Tier used when resolveFn fails or returns an unknown tier */
  defaultTier?: string
  /** Cache resolved tiers this long (ms). Default: 60000 */
  cacheTtlMs?: number
}

export class TierManager {
  private readonly tiers: Map<string, TierConfig>
  private readonly tierCache = new Map<string, { tier: string; expiresAt: number }>()
  private readonly overrides = new Map<string, PartialTierConfig>()
  private readonly cacheTtlMs: number
  private readonly defaultTier?: string

  constructor(
    tiers: Record<string, TierConfig>,
    private readonly resolveFn: (tenantId: string) => Promise<string>,
    opts: TierManagerOpts = {},
  ) {
    this.tiers = new Map(Object.entries(tiers))
    this.cacheTtlMs = opts.cacheTtlMs ?? 60_000
    this.defaultTier = opts.defaultTier
    if (this.defaultTier !== undefined && !this.tiers.has(this.defaultTier)) {
      throw new Error(`defaultTier "${this.defaultTier}" is not one of the configured tiers`)
    }
  }

  async resolveTier(tenantId: string): Promise<string> {
    const cached = this.tierCache.get(tenantId)
    if (cached && cached.expiresAt > Date.now()) return cached.tier

    let tier: string
    try {
      tier = await this.resolveFn(tenantId)
    } catch (err) {
      if (this.defaultTier === undefined) throw err
      tier = this.defaultTier
    }
    if (!this.tiers.has(tier)) {
      if (this.defaultTier === undefined) {
        throw new Error(`Unknown tier: "${tier}" for tenant "${tenantId}"`)
      }
      tier = this.defaultTier
    }
    this.remember(tenantId, tier)
    return tier
  }

  /** Last resolved tier, without resolving (undefined if unknown or expired). */
  cachedTier(tenantId: string): string | undefined {
    const cached = this.tierCache.get(tenantId)
    return cached && cached.expiresAt > Date.now() ? cached.tier : undefined
  }

  setTier(tenantId: string, tier: string): void {
    if (!this.tiers.has(tier)) throw new Error(`Unknown tier: "${tier}"`)
    this.remember(tenantId, tier)
  }

  override(tenantId: string, overrides: PartialTierConfig): void {
    this.overrides.set(tenantId, overrides)
  }

  removeOverride(tenantId: string): void {
    this.overrides.delete(tenantId)
  }

  async getTierConfig(tenantId: string): Promise<TierConfig> {
    const base = this.tiers.get(await this.resolveTier(tenantId))!
    const ov = this.overrides.get(tenantId)
    if (!ov) return base

    return {
      rateLimit: {
        max: ov.rateLimit?.max ?? base.rateLimit.max,
        window: ov.rateLimit?.window ?? base.rateLimit.window,
      },
      concurrency: ov.concurrency ?? base.concurrency,
      weight: ov.weight ?? base.weight,
    }
  }

  list(): Array<{ tenantId: string; tier: string }> {
    return [...this.tierCache.entries()].map(([tenantId, { tier }]) => ({ tenantId, tier }))
  }

  private remember(tenantId: string, tier: string): void {
    const now = Date.now()
    this.tierCache.set(tenantId, { tier, expiresAt: now + this.cacheTtlMs })
    // Bound memory: drop expired entries now and then
    if (this.tierCache.size % 1000 === 0) {
      for (const [id, e] of this.tierCache) if (e.expiresAt <= now) this.tierCache.delete(id)
    }
  }
}
