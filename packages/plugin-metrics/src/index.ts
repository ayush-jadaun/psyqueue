import type { PsyPlugin, Kernel } from '@psyqueue/core'
import {
  Registry,
  Counter,
  Histogram,
  Gauge,
} from 'prom-client'

export interface MetricsOpts {
  prefix?: string
  defaultLabels?: Record<string, string>
  /** Provide a custom Registry (for testing — avoids polluting the global default registry) */
  registry?: Registry
}

export type MetricsPlugin = PsyPlugin & {
  getRegistry(): Registry
}

export function metrics(opts?: MetricsOpts): MetricsPlugin {
  const prefix = opts?.prefix ?? 'psyqueue'
  const registry = opts?.registry ?? new Registry()

  if (opts?.defaultLabels) {
    registry.setDefaultLabels(opts.defaultLabels)
  }

  const jobsEnqueued = new Counter({
    name: `${prefix}_jobs_enqueued_total`,
    help: 'Total number of jobs enqueued',
    labelNames: ['queue', 'name'] as const,
    registers: [registry],
  })

  const jobsCompleted = new Counter({
    name: `${prefix}_jobs_completed_total`,
    help: 'Total number of jobs completed successfully',
    labelNames: ['queue', 'name'] as const,
    registers: [registry],
  })

  const jobsFailed = new Counter({
    name: `${prefix}_jobs_failed_total`,
    help: 'Total number of jobs failed',
    labelNames: ['queue', 'name'] as const,
    registers: [registry],
  })

  const jobDuration = new Histogram({
    name: `${prefix}_job_duration_ms`,
    help: 'Job processing duration in milliseconds',
    labelNames: ['queue', 'name'] as const,
    buckets: [10, 50, 100, 250, 500, 1000, 2500, 5000, 10000],
    registers: [registry],
  })

  const queueDepth = new Gauge({
    name: `${prefix}_queue_depth`,
    help: 'Current number of pending jobs per queue',
    labelNames: ['queue'] as const,
    registers: [registry],
  })

  const plugin: MetricsPlugin = {
    name: 'metrics',
    version: '0.1.0',
    provides: 'metrics',

    getRegistry(): Registry {
      return registry
    },

    init(k: Kernel): void {
      // Increment enqueued counter and queue depth when a job is enqueued
      k.pipeline(
        'enqueue',
        async (ctx, next) => {
          await next()
          jobsEnqueued.labels(ctx.job.queue, ctx.job.name).inc()
          queueDepth.labels(ctx.job.queue).inc()
        },
        { phase: 'observe' },
      )

      // Record job start time to compute duration later
      const startTimes = new Map<string, number>()

      k.pipeline(
        'process',
        async (ctx, next) => {
          startTimes.set(ctx.job.id, Date.now())
          await next()
        },
        { phase: 'observe' },
      )

      // Listen to bus events to track completed/failed metrics
      k.events.on('job:completed', (event) => {
        const data = event.data as { jobId: string; queue: string; name: string }
        const start = startTimes.get(data.jobId)
        if (start !== undefined) {
          jobDuration.labels(data.queue, data.name).observe(Date.now() - start)
          startTimes.delete(data.jobId)
        }
        jobsCompleted.labels(data.queue, data.name).inc()
        queueDepth.labels(data.queue).dec()
      })

      k.events.on('job:failed', (event) => {
        const data = event.data as { jobId: string; queue: string; name: string }
        const start = startTimes.get(data.jobId)
        if (start !== undefined) {
          jobDuration.labels(data.queue, data.name).observe(Date.now() - start)
          startTimes.delete(data.jobId)
        }
        jobsFailed.labels(data.queue, data.name).inc()
        queueDepth.labels(data.queue).dec()
      })

      k.events.on('job:dead', (event) => {
        const data = event.data as { jobId: string }
        startTimes.delete(data.jobId)
        // queueDepth is already decremented via job:failed which always fires alongside job:dead
      })

      k.events.on('job:requeued', (event) => {
        const data = event.data as { jobId: string }
        startTimes.delete(data.jobId)
      })
    },

    async start(): Promise<void> {
      // Nothing to start
    },

    async stop(): Promise<void> {
      // Nothing to stop
    },
  }

  return plugin
}
