export type PressureState = 'HEALTHY' | 'PRESSURE' | 'CRITICAL'

export interface SignalThresholds {
  queueDepth?: { pressure: number; critical: number }
  errorRate?: { pressure: number; critical: number }
}

export interface Metrics {
  queueDepth?: number
  errorRate?: number
}

export class SignalMonitor {
  private state: PressureState = 'HEALTHY'

  constructor(private readonly thresholds: SignalThresholds) {}

  get currentState(): PressureState {
    return this.state
  }

  /**
   * Recalculates pressure state based on incoming metrics.
   * Returns the new state.
   */
  update(metrics: Metrics): PressureState {
    let isCritical = false
    let isPressure = false

    if (this.thresholds.queueDepth !== undefined && metrics.queueDepth !== undefined) {
      if (metrics.queueDepth >= this.thresholds.queueDepth.critical) {
        isCritical = true
      } else if (metrics.queueDepth >= this.thresholds.queueDepth.pressure) {
        isPressure = true
      }
    }

    if (this.thresholds.errorRate !== undefined && metrics.errorRate !== undefined) {
      if (metrics.errorRate >= this.thresholds.errorRate.critical) {
        isCritical = true
      } else if (metrics.errorRate >= this.thresholds.errorRate.pressure) {
        isPressure = true
      }
    }

    if (isCritical) {
      this.state = 'CRITICAL'
    } else if (isPressure) {
      this.state = 'PRESSURE'
    } else {
      this.state = 'HEALTHY'
    }

    return this.state
  }
}
