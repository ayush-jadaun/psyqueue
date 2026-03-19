import type { PsyPlugin, Kernel, Job } from 'psyqueue'
import { BatchCollector } from './batcher.js'
import type { FusionRule } from './batcher.js'

export type { FusionRule } from './batcher.js'
export { BatchCollector } from './batcher.js'

export interface JobFusionOpts {
  rules: FusionRule[]
}

export function jobFusion(opts: JobFusionOpts): PsyPlugin {
  let collector: BatchCollector | null = null

  const plugin: PsyPlugin = {
    name: 'job-fusion',
    version: '0.1.0',
    provides: 'job-fusion',

    init(k: Kernel): void {
      collector = new BatchCollector((rule, groupKey, jobs) => {
        // Called when a batch is ready to flush
        const fusedPayload = rule.fuse(jobs)

        // Pick highest priority and earliest deadline from the batch
        const maxPriority = Math.max(...jobs.map(j => j.priority))
        const deadlines = jobs.map(j => j.deadline).filter((d): d is Date => d !== undefined)
        const earliestDeadline = deadlines.length > 0
          ? new Date(Math.min(...deadlines.map(d => d.getTime())))
          : undefined

        const originalJobIds = jobs.map(j => j.id)

        // Enqueue the fused job via the kernel's backend
        const backend = k.getBackend()

        // Build a fused job with the aggregated properties
        const fusedJob: Job = {
          id: `fused-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          queue: jobs[0]!.queue,
          name: rule.match,
          payload: fusedPayload,
          priority: maxPriority,
          deadline: earliestDeadline,
          tenantId: jobs[0]!.tenantId,
          maxRetries: Math.max(...jobs.map(j => j.maxRetries)),
          attempt: 0,
          backoff: 'exponential',
          timeout: Math.max(...jobs.map(j => j.timeout)),
          status: 'pending',
          createdAt: new Date(),
          meta: {
            'fusion.originalJobIds': originalJobIds,
            'fusion.groupKey': groupKey,
            'fusion.count': jobs.length,
          },
        }

        // Enqueue asynchronously — we're in a timer callback
        backend.enqueue(fusedJob).then(() => {
          k.events.emit('job:fused', {
            fusedJobId: fusedJob.id,
            originalJobIds,
            groupKey,
            count: jobs.length,
          })
        }).catch(() => {
          // Silently fail — plugin should not crash the process
        })
      })

      // Transform phase on enqueue: intercept matching jobs
      k.pipeline(
        'enqueue',
        async (ctx, next) => {
          const job = ctx.job
          const matchingRule = opts.rules.find(r => r.match === job.name)

          if (!matchingRule) {
            // No rule matches — pass through
            await next()
            return
          }

          // Collect the job into the batcher — short-circuit (don't call next)
          collector!.collect(matchingRule, job)
          // Do NOT call next() — this short-circuits the enqueue pipeline
          // The job is buffered and will be fused later
        },
        { phase: 'transform' },
      )
    },

    async start(): Promise<void> {
      // nothing extra to start — collector is created in init
    },

    async stop(): Promise<void> {
      collector?.clear()
    },
  }

  // Expose collector for testing
  const extended = plugin as PsyPlugin & {
    getCollector(): BatchCollector | null
  }

  extended.getCollector = () => collector

  return extended
}
