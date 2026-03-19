export type BreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN'

export interface BreakerConfig {
  /** Number of failures within the window to trip the breaker */
  failureThreshold: number
  /** Time window in ms for counting failures */
  failureWindow: number
  /** Time in ms to wait before transitioning OPEN → HALF_OPEN */
  resetTimeout: number
  /** Number of successful requests in HALF_OPEN needed to close the breaker */
  halfOpenRequests: number
  /** What to do when the circuit is open. Default: 'requeue' */
  onOpen?: 'requeue' | 'fail'
}

export class Breaker {
  private state: BreakerState = 'CLOSED'
  private failures: number[] = []
  private halfOpenSuccesses = 0
  private openedAt = 0

  constructor(private config: BreakerConfig) {}

  /**
   * Returns the current state, auto-transitioning OPEN → HALF_OPEN if resetTimeout
   * has elapsed. Side-effect: may update internal state.
   */
  get currentState(): BreakerState {
    // Auto-transition OPEN → HALF_OPEN after resetTimeout
    if (this.state === 'OPEN' && Date.now() - this.openedAt >= this.config.resetTimeout) {
      this.state = 'HALF_OPEN'
      this.halfOpenSuccesses = 0
    }
    return this.state
  }

  /**
   * Returns the raw internal state without triggering any transitions.
   * Use this when you need to snapshot the state without side effects.
   */
  get rawState(): BreakerState {
    return this.state
  }

  recordFailure(): void {
    this.failures.push(Date.now())
    this.pruneOldFailures()
    if (this.state === 'HALF_OPEN') {
      this.state = 'OPEN'
      this.openedAt = Date.now()
    } else if (this.failures.length >= this.config.failureThreshold) {
      this.state = 'OPEN'
      this.openedAt = Date.now()
    }
  }

  recordSuccess(): void {
    if (this.currentState === 'HALF_OPEN') {
      this.halfOpenSuccesses++
      if (this.halfOpenSuccesses >= this.config.halfOpenRequests) {
        this.state = 'CLOSED'
        this.failures = []
      }
    }
  }

  canExecute(): boolean {
    const s = this.currentState
    if (s === 'CLOSED') return true
    if (s === 'HALF_OPEN') return true
    return false // OPEN
  }

  private pruneOldFailures(): void {
    const cutoff = Date.now() - this.config.failureWindow
    this.failures = this.failures.filter(t => t > cutoff)
  }
}
