import type { PsyPlugin, Kernel, Job } from '@psyqueue/core'
import { linearCurve, exponentialCurve, stepCurve } from './curves.js'

export { linearCurve, exponentialCurve, stepCurve } from './curves.js'

export type UrgencyCurve =
  | 'linear'
  | 'exponential'
  | 'step'
  | ((timeRemainingPct: number, basePriority: number) => number)

export interface DeadlinePriorityOpts {
  urgencyCurve: UrgencyCurve
  boostThreshold?: number
  maxBoost?: number
  interval?: number
  onDeadlineMiss?: 'process-anyway' | 'fail' | 'move-to-dead-letter'
}

function getCurveFn(
  urgencyCurve: UrgencyCurve,
  boostThreshold: number,
  maxBoost: number,
): (timeRemainingPct: number, basePriority: number) => number {
  if (typeof urgencyCurve === 'function') {
    return urgencyCurve
  }
  switch (urgencyCurve) {
    case 'linear':
      return (pct, base) => linearCurve(pct, base, maxBoost, boostThreshold)
    case 'exponential':
      return (pct, base) => exponentialCurve(pct, base, maxBoost, boostThreshold)
    case 'step':
      return (pct, base) => stepCurve(pct, base, maxBoost, boostThreshold)
    default:
      throw new Error(`Unknown urgency curve: ${String(urgencyCurve)}`)
  }
}

export function deadlinePriority(opts: DeadlinePriorityOpts): PsyPlugin {
  const boostThreshold = opts.boostThreshold ?? 0.5
  const maxBoost = opts.maxBoost ?? 95
  const interval = opts.interval ?? 5000
  const onDeadlineMiss = opts.onDeadlineMiss ?? 'process-anyway'

  const curveFn = getCurveFn(opts.urgencyCurve, boostThreshold, maxBoost)

  let kernelRef: Kernel | null = null
  let timer: ReturnType<typeof setInterval> | null = null

  // Track jobs with deadlines (jobId → {createdAt, deadline, basePriority})
  const trackedJobs = new Map<string, { createdAt: Date; deadline: Date; basePriority: number }>()

  const processDeadlines = (): void => {
    const now = new Date()

    for (const [jobId, info] of trackedJobs.entries()) {
      const totalMs = info.deadline.getTime() - info.createdAt.getTime()
      const remainingMs = info.deadline.getTime() - now.getTime()
      const timeRemainingPct = totalMs > 0 ? Math.max(0, remainingMs / totalMs) : 0

      if (remainingMs <= 0) {
        // Deadline missed
        kernelRef?.events.emit('job:deadline-missed', {
          jobId,
          deadline: info.deadline,
          action: onDeadlineMiss,
        })
        // Remove from tracking after miss detection
        trackedJobs.delete(jobId)
        continue
      }

      // Recalculate priority
      const newPriority = curveFn(timeRemainingPct, info.basePriority)

      if (newPriority !== info.basePriority) {
        kernelRef?.events.emit('job:priority-boosted', {
          jobId,
          oldPriority: info.basePriority,
          newPriority,
          timeRemainingPct,
        })
      }
    }
  }

  const plugin: PsyPlugin = {
    name: 'deadline-priority',
    version: '0.1.0',
    provides: 'deadline-priority',

    init(k: Kernel): void {
      kernelRef = k

      // On enqueue: track jobs with deadlines
      k.pipeline(
        'enqueue',
        async (ctx, next) => {
          if (ctx.job.deadline) {
            trackedJobs.set(ctx.job.id, {
              createdAt: ctx.job.createdAt,
              deadline: ctx.job.deadline,
              basePriority: ctx.job.priority,
            })
          }
          await next()
        },
        { phase: 'observe' },
      )

      // On process: check deadline miss and handle accordingly
      k.pipeline(
        'process',
        async (ctx, next) => {
          if (ctx.job.deadline) {
            const now = new Date()
            if (ctx.job.deadline < now) {
              if (onDeadlineMiss === 'fail') {
                ctx.deadLetter(`Deadline missed: job was due at ${ctx.job.deadline.toISOString()}`)
                k.events.emit('job:deadline-missed', {
                  jobId: ctx.job.id,
                  deadline: ctx.job.deadline,
                  action: onDeadlineMiss,
                })
                return
              } else if (onDeadlineMiss === 'move-to-dead-letter') {
                ctx.deadLetter(`Deadline missed: job was due at ${ctx.job.deadline.toISOString()}`)
                k.events.emit('job:deadline-missed', {
                  jobId: ctx.job.id,
                  deadline: ctx.job.deadline,
                  action: onDeadlineMiss,
                })
                return
              }
              // 'process-anyway': emit event but continue
              k.events.emit('job:deadline-missed', {
                jobId: ctx.job.id,
                deadline: ctx.job.deadline,
                action: onDeadlineMiss,
              })
            }
            // Remove from tracking once we're processing
            trackedJobs.delete(ctx.job.id)
          }
          await next()
        },
        { phase: 'guard' },
      )
    },

    async start(): Promise<void> {
      timer = setInterval(processDeadlines, interval)
    },

    async stop(): Promise<void> {
      if (timer !== null) {
        clearInterval(timer)
        timer = null
      }
      trackedJobs.clear()
    },
  }

  // Expose internal state for testing
  const extended = plugin as PsyPlugin & {
    computePriority(job: Pick<Job, 'createdAt' | 'deadline' | 'priority'>): number
    getTrackedCount(): number
  }

  extended.computePriority = (job: Pick<Job, 'createdAt' | 'deadline' | 'priority'>): number => {
    if (!job.deadline) return job.priority
    const now = new Date()
    const totalMs = job.deadline.getTime() - job.createdAt.getTime()
    const remainingMs = job.deadline.getTime() - now.getTime()
    const timeRemainingPct = totalMs > 0 ? Math.max(0, remainingMs / totalMs) : 0
    return curveFn(timeRemainingPct, job.priority)
  }

  extended.getTrackedCount = () => trackedJobs.size

  return extended
}
