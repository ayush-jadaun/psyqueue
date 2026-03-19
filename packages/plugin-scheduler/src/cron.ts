import type { BackendAdapter, Job } from '@psyqueue/core'
// cron-parser v4 uses CommonJS default export
import cronParser from 'cron-parser'

export interface CronManagerOpts {
  /** ms lock TTL for cron leader election (default: 60000) */
  cronLockTtl: number
  /** ms between polling for cron leader lock renewal (default: 30000) */
  lockRenewalInterval?: number
}

const CRON_LEADER_KEY = 'psyqueue:cron-leader'

/**
 * Manages cron-based recurring jobs.
 *
 * When a job with a `cron` expression completes, CronManager schedules the
 * next occurrence using cron-parser to compute the next run time.
 *
 * Leader election via backend.acquireLock() prevents duplicate cron runs
 * in a clustered deployment.
 */
export class CronManager {
  private readonly backend: BackendAdapter
  private readonly cronLockTtl: number
  private readonly lockRenewalInterval: number
  private renewalTimer: ReturnType<typeof setInterval> | null = null
  private isLeader = false

  constructor(backend: BackendAdapter, opts: CronManagerOpts) {
    this.backend = backend
    this.cronLockTtl = opts.cronLockTtl
    this.lockRenewalInterval = opts.lockRenewalInterval ?? Math.floor(opts.cronLockTtl / 2)
  }

  async start(): Promise<void> {
    // Attempt initial leader election
    await this.tryAcquireLeadership()

    // Periodically try to renew / acquire leadership
    this.renewalTimer = setInterval(() => {
      void this.tryAcquireLeadership()
    }, this.lockRenewalInterval)

    if (typeof this.renewalTimer === 'object' && this.renewalTimer !== null && 'unref' in this.renewalTimer) {
      (this.renewalTimer as { unref(): void }).unref()
    }
  }

  async stop(): Promise<void> {
    if (this.renewalTimer !== null) {
      clearInterval(this.renewalTimer)
      this.renewalTimer = null
    }
    if (this.isLeader) {
      await this.backend.releaseLock(CRON_LEADER_KEY)
      this.isLeader = false
    }
  }

  /** Returns whether this instance currently holds the cron leader lock. */
  get leader(): boolean {
    return this.isLeader
  }

  /**
   * Called when a job completes. If the job has a `cron` expression and this
   * instance is the cron leader, schedules the next occurrence.
   */
  async onJobCompleted(job: Job): Promise<void> {
    if (!job.cron) return
    if (!this.isLeader) {
      // Try to acquire leadership before giving up
      const acquired = await this.tryAcquireLeadership()
      if (!acquired) return
    }
    await this.scheduleNextOccurrence(job)
  }

  /** Compute next run time from cron expression and schedule the job. */
  async scheduleNextOccurrence(job: Job): Promise<void> {
    const nextRunAt = computeNextRunAt(job.cron!)
    if (!nextRunAt) return

    // Create a fresh scheduled job preserving the cron expression
    const nextJob: Job = {
      ...job,
      // New identity
      id: generateId(),
      status: 'scheduled',
      runAt: nextRunAt,
      // Reset execution state
      attempt: 1,
      result: undefined,
      error: undefined,
      startedAt: undefined,
      completedAt: undefined,
      createdAt: new Date(),
    }

    await this.backend.scheduleAt(nextJob, nextRunAt)
  }

  private async tryAcquireLeadership(): Promise<boolean> {
    const acquired = await this.backend.acquireLock(CRON_LEADER_KEY, this.cronLockTtl)
    if (acquired) {
      this.isLeader = true
    }
    return acquired || this.isLeader
  }
}

/**
 * Computes the next Date a cron expression will fire, after now.
 * Returns null if the expression is invalid.
 */
export function computeNextRunAt(cronExpression: string, after: Date = new Date()): Date | null {
  try {
    const interval = cronParser.parseExpression(cronExpression, { currentDate: after })
    return interval.next().toDate()
  } catch {
    return null
  }
}

/** Simple ID generator (mirrors core's approach with a fallback). */
function generateId(): string {
  const ts = Date.now().toString(36)
  const rand = Math.random().toString(36).slice(2, 10)
  return `${ts}-${rand}`
}
