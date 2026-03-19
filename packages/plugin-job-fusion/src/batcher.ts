import type { Job } from '@psyqueue/core'

export interface FusionRule {
  match: string
  groupBy: (job: Job) => string
  window: number
  maxBatch: number
  fuse: (jobs: Job[]) => unknown
}

interface Bucket {
  jobs: Job[]
  timer: ReturnType<typeof setTimeout>
}

export type FlushCallback = (rule: FusionRule, groupKey: string, jobs: Job[]) => void

export class BatchCollector {
  private readonly buckets = new Map<string, Bucket>()
  private readonly onFlush: FlushCallback

  constructor(onFlush: FlushCallback) {
    this.onFlush = onFlush
  }

  /**
   * Add a job to the appropriate bucket for the given rule.
   * Returns true if the job was collected (batched), false if it should pass through.
   */
  collect(rule: FusionRule, job: Job): boolean {
    const groupKey = rule.groupBy(job)
    const bucketKey = `${rule.match}:${groupKey}`

    let bucket = this.buckets.get(bucketKey)

    if (!bucket) {
      // Start a new bucket with timer
      const timer = setTimeout(() => {
        this.flush(rule, groupKey, bucketKey)
      }, rule.window)

      bucket = { jobs: [], timer }
      this.buckets.set(bucketKey, bucket)
    }

    bucket.jobs.push(job)

    if (bucket.jobs.length >= rule.maxBatch) {
      // Hit max batch — flush immediately
      clearTimeout(bucket.timer)
      this.flush(rule, groupKey, bucketKey)
    }

    return true
  }

  private flush(rule: FusionRule, groupKey: string, bucketKey: string): void {
    const bucket = this.buckets.get(bucketKey)
    if (!bucket || bucket.jobs.length === 0) {
      this.buckets.delete(bucketKey)
      return
    }

    const jobs = bucket.jobs.slice()
    this.buckets.delete(bucketKey)
    this.onFlush(rule, groupKey, jobs)
  }

  /**
   * Cancel all pending timers and clear all buckets.
   * Called on plugin stop.
   */
  clear(): void {
    for (const bucket of this.buckets.values()) {
      clearTimeout(bucket.timer)
    }
    this.buckets.clear()
  }

  /** Returns the number of active buckets (for testing). */
  getBucketCount(): number {
    return this.buckets.size
  }
}
