import type { BackendAdapter, Job } from '@psyqueue/core'

export interface DelayedJobPollerOpts {
  /** ms between polling for due scheduled jobs (default: 1000) */
  pollInterval: number
  /** max jobs to move per tick (default: 100) */
  batchSize?: number
}

/**
 * Polls the backend on each interval and moves due scheduled jobs to pending.
 */
export class DelayedJobPoller {
  private readonly backend: BackendAdapter
  private readonly pollInterval: number
  private readonly batchSize: number
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(backend: BackendAdapter, opts: DelayedJobPollerOpts) {
    this.backend = backend
    this.pollInterval = opts.pollInterval
    this.batchSize = opts.batchSize ?? 100
  }

  start(): void {
    if (this.timer !== null) return
    this.timer = setInterval(() => {
      void this.pollOnce()
    }, this.pollInterval)
    // Unref so it doesn't keep the process alive in tests
    if (typeof this.timer === 'object' && this.timer !== null && 'unref' in this.timer) {
      (this.timer as { unref(): void }).unref()
    }
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** Runs one poll cycle: moves all due scheduled jobs to pending. */
  async pollOnce(): Promise<Job[]> {
    return this.backend.pollScheduled(new Date(), this.batchSize)
  }
}
