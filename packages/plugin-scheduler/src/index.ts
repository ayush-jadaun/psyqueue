import type { PsyPlugin, Kernel, Job } from 'psyqueue'
import { DelayedJobPoller } from './delayed.js'
import { CronManager } from './cron.js'

export { computeNextRunAt } from './cron.js'
export type { DelayedJobPollerOpts } from './delayed.js'
export type { CronManagerOpts } from './cron.js'

export interface SchedulerOpts {
  /** ms between polling for due scheduled jobs (default: 1000) */
  pollInterval?: number
  /** ms lock TTL for cron leader election (default: 60000) */
  cronLockTtl?: number
}

/**
 * Creates the scheduler plugin which handles:
 *  - Delayed jobs: jobs with a future `runAt` are stored as scheduled and
 *    moved to pending when their time arrives.
 *  - Cron jobs: after a job with a `cron` expression completes, the next
 *    occurrence is automatically scheduled.
 */
export function scheduler(opts: SchedulerOpts = {}): PsyPlugin {
  const pollInterval = opts.pollInterval ?? 1000
  const cronLockTtl = opts.cronLockTtl ?? 60_000

  let poller: DelayedJobPoller | null = null
  let cronManager: CronManager | null = null
  // Stored during init, executed during start when backend is ready
  let initComponents: (() => void) | null = null

  const plugin: PsyPlugin = {
    name: 'scheduler',
    version: '0.1.0',
    provides: 'scheduler',
    depends: ['backend'],

    init(kernel: Kernel): void {
      // ------------------------------------------------------------------ //
      // Enqueue middleware — transform phase                                //
      // If a job has a future runAt, redirect to backend.scheduleAt()      //
      // instead of the normal enqueue path.                                 //
      // ------------------------------------------------------------------ //
      kernel.pipeline(
        'enqueue',
        async (ctx, next) => {
          const job = ctx.job
          if (job.runAt) {
            // Intercept ALL runAt jobs — route through scheduleAt().
            // The poller will immediately pick up past-due ones.
            const backend = kernel.getBackend()
            await backend.scheduleAt(job, job.runAt)
            // Do NOT call next() — this replaces the core enqueue execute step
            return
          }
          await next()
        },
        { phase: 'transform' },
      )

      // ------------------------------------------------------------------ //
      // job:completed event — schedule next cron occurrence                 //
      // ------------------------------------------------------------------ //
      kernel.events.on('job:completed', (event) => {
        const data = event.data as { jobId: string; queue: string; name: string; result?: unknown }
        if (!cronManager) return

        // Fetch the full job to read its cron expression, then schedule next run
        const backend = kernel.getBackend()
        backend.getJob(data.jobId).then((job: Job | null) => {
          if (!job || !job.cron) return
          return cronManager!.onJobCompleted(job)
        }).catch(() => {
          // Swallow errors — cron scheduling failure must not crash the queue
        })
      })

      // Capture a factory for the components that need the backend.
      // The backend is guaranteed to be connected by the time start() is called.
      initComponents = () => {
        const backend = kernel.getBackend()
        poller = new DelayedJobPoller(backend, { pollInterval })
        cronManager = new CronManager(backend, { cronLockTtl })
      }
    },

    async start(): Promise<void> {
      initComponents?.()
      poller?.start()
      await cronManager?.start()
    },

    async stop(): Promise<void> {
      poller?.stop()
      await cronManager?.stop()
    },
  }

  return plugin
}
