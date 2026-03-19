export type SchedulingMode = 'weighted-fair-queue' | 'round-robin' | 'strict-priority'

interface TierWeightConfig {
  weight: number
}

export class FairScheduler {
  private readonly mode: SchedulingMode
  private readonly weights: Map<string, number>

  // Weighted fair queue state
  private readonly deficits: Map<string, number> = new Map()

  // Round-robin state
  private rrIndex = 0
  private rrOrder: string[] = []

  constructor(mode: SchedulingMode, tiers: Record<string, TierWeightConfig>) {
    this.mode = mode
    this.weights = new Map(
      Object.entries(tiers).map(([name, cfg]) => [name, cfg.weight]),
    )
  }

  selectTenant(pendingTenants: string[]): string {
    if (pendingTenants.length === 0) {
      throw new Error('No pending tenants to select from')
    }

    switch (this.mode) {
      case 'weighted-fair-queue':
        return this.selectWFQ(pendingTenants)
      case 'round-robin':
        return this.selectRoundRobin(pendingTenants)
      case 'strict-priority':
        return this.selectStrictPriority(pendingTenants)
    }
  }

  private selectWFQ(pendingTenants: string[]): string {
    // Add weight to each pending tenant's deficit counter
    for (const tenant of pendingTenants) {
      const weight = this.weights.get(tenant) ?? 1
      const current = this.deficits.get(tenant) ?? 0
      this.deficits.set(tenant, current + weight)
    }

    // Pick the tenant with the highest deficit
    let best: string = pendingTenants[0]!
    let bestDeficit = this.deficits.get(best) ?? 0

    for (const tenant of pendingTenants) {
      const deficit = this.deficits.get(tenant) ?? 0
      if (deficit > bestDeficit) {
        best = tenant
        bestDeficit = deficit
      }
    }

    // Consume the deficit
    this.deficits.set(best, 0)

    return best
  }

  private selectRoundRobin(pendingTenants: string[]): string {
    // Rebuild order if new tenants appear or order is empty
    // We maintain a stable ordering based on the first time we see tenants
    for (const tenant of pendingTenants) {
      if (!this.rrOrder.includes(tenant)) {
        this.rrOrder.push(tenant)
      }
    }

    // Advance through the stable order, skipping tenants not in pending list
    const maxAttempts = this.rrOrder.length
    for (let i = 0; i < maxAttempts; i++) {
      const idx = this.rrIndex % this.rrOrder.length
      const tenant = this.rrOrder[idx]!
      this.rrIndex++
      if (pendingTenants.includes(tenant)) {
        return tenant
      }
    }

    // Fallback: return first pending tenant
    return pendingTenants[0]!
  }

  private selectStrictPriority(pendingTenants: string[]): string {
    let best: string = pendingTenants[0]!
    let bestWeight = this.weights.get(best) ?? 0

    for (const tenant of pendingTenants) {
      const weight = this.weights.get(tenant) ?? 0
      if (weight > bestWeight) {
        best = tenant
        bestWeight = weight
      }
    }

    return best
  }
}
