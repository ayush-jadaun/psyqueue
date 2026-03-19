export interface TierConfig {
  rateLimit: { max: number; window: '1s' | '1m' | '1h' }
  concurrency: number
  weight: number
}

type PartialTierConfig = {
  rateLimit?: Partial<TierConfig['rateLimit']>
  concurrency?: number
  weight?: number
}

export class TierManager {
  private readonly tiers: Map<string, TierConfig>
  private readonly tierCache: Map<string, string>
  private readonly overrides: Map<string, PartialTierConfig>
  private readonly resolveFn: (tenantId: string) => Promise<string>

  constructor(
    tiers: Record<string, TierConfig>,
    resolveFn: (tenantId: string) => Promise<string>,
  ) {
    this.tiers = new Map(Object.entries(tiers))
    this.tierCache = new Map()
    this.overrides = new Map()
    this.resolveFn = resolveFn
  }

  async resolveTier(tenantId: string): Promise<string> {
    const cached = this.tierCache.get(tenantId)
    if (cached !== undefined) return cached
    const tier = await this.resolveFn(tenantId)
    this.tierCache.set(tenantId, tier)
    return tier
  }

  setTier(tenantId: string, tier: string): void {
    this.tierCache.set(tenantId, tier)
  }

  override(tenantId: string, overrides: PartialTierConfig): void {
    this.overrides.set(tenantId, overrides)
  }

  removeOverride(tenantId: string): void {
    this.overrides.delete(tenantId)
  }

  async getTierConfig(tenantId: string): Promise<TierConfig> {
    const tierName = await this.resolveTier(tenantId)
    const base = this.tiers.get(tierName)
    if (!base) {
      throw new Error(`Unknown tier: "${tierName}" for tenant "${tenantId}"`)
    }

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
    return Array.from(this.tierCache.entries()).map(([tenantId, tier]) => ({
      tenantId,
      tier,
    }))
  }
}
