const WINDOW_MS: Record<string, number> = {
  '1s': 1_000,
  '1m': 60_000,
  '1h': 3_600_000,
}

const SUB_WINDOWS = 6

interface SubWindowEntry {
  count: number
  windowStart: number
}

interface TenantState {
  subWindows: SubWindowEntry[]
  windowMs: number
  max: number
}

export interface RateLimitResult {
  allowed: boolean
  retryAfter?: number
}

export class SlidingWindowRateLimiter {
  private readonly tenants: Map<string, TenantState> = new Map()

  configure(tenantId: string, config: { max: number; window: string }): void {
    const rawMs = WINDOW_MS[config.window]
    const windowMs = rawMs !== undefined ? rawMs : this.parseWindow(config.window)
    this.tenants.set(tenantId, {
      subWindows: [],
      windowMs,
      max: config.max,
    })
  }

  private parseWindow(window: string): number {
    // Support numeric ms for testing (e.g. '100ms')
    const msMatch = window.match(/^(\d+)ms$/)
    if (msMatch) return parseInt(msMatch[1]!, 10)

    const known = WINDOW_MS[window]
    if (known !== undefined) return known

    throw new Error(`Unknown window format: "${window}"`)
  }

  private getState(tenantId: string): TenantState | undefined {
    return this.tenants.get(tenantId)
  }

  private prune(state: TenantState, now: number): void {
    const cutoff = now - state.windowMs
    state.subWindows = state.subWindows.filter(sw => sw.windowStart > cutoff)
  }

  private countTotal(state: TenantState): number {
    return state.subWindows.reduce((sum, sw) => sum + sw.count, 0)
  }

  private currentSubWindowStart(state: TenantState, now: number): number {
    const subWindowSize = Math.ceil(state.windowMs / SUB_WINDOWS)
    return Math.floor(now / subWindowSize) * subWindowSize
  }

  check(tenantId: string): RateLimitResult {
    const state = this.getState(tenantId)
    if (!state) {
      // No configuration — allow by default
      return { allowed: true }
    }

    const now = Date.now()
    this.prune(state, now)

    const total = this.countTotal(state)
    if (total < state.max) {
      return { allowed: true }
    }

    // Calculate when the oldest sub-window expires
    const oldest = state.subWindows[0]
    const retryAfter = oldest
      ? Math.max(1, oldest.windowStart + state.windowMs - now)
      : 1

    return { allowed: false, retryAfter }
  }

  record(tenantId: string): void {
    const state = this.getState(tenantId)
    if (!state) return

    const now = Date.now()
    this.prune(state, now)

    const swStart = this.currentSubWindowStart(state, now)
    const existing = state.subWindows.find(sw => sw.windowStart === swStart)
    if (existing) {
      existing.count++
    } else {
      state.subWindows.push({ count: 1, windowStart: swStart })
    }
  }
}
