import type { PsyPlugin, Kernel } from '@psyqueue/core'
import { WriteAheadLog } from './wal.js'
import { recoverFromWal, type RecoveryBackend } from './recovery.js'

export type { WalEntry } from './wal.js'
export { WriteAheadLog } from './wal.js'
export { recoverFromWal } from './recovery.js'

export interface CrashRecoveryOpts {
  /** Path to the WAL file. Default: './psyqueue.wal' */
  walPath?: string
  /** Periodic flush interval in ms (reserved for future buffered mode). Default: 100 */
  flushInterval?: number
  /** Automatically recover orphaned jobs on start. Default: true */
  autoRecover?: boolean
  /**
   * What to do with a job that was 'active' when the process crashed.
   * - 'requeue' — put it back in the queue (default)
   * - 'fail'    — nack without requeue
   * - function  — custom logic, returns 'requeue' | 'fail' | 'dead-letter'
   */
  onRecoverActiveJob?:
    | 'requeue'
    | 'fail'
    | ((job: { jobId: string; attempt: number }) => Promise<'requeue' | 'fail' | 'dead-letter'>)
  /** Maximum time to wait for in-flight jobs to complete on stop (ms). Default: 30000 */
  shutdownTimeout?: number
}

/**
 * Create a crash-recovery plugin that writes a WAL before/after each job and
 * automatically re-queues orphaned jobs on the next startup.
 */
export function crashRecovery(opts: CrashRecoveryOpts = {}): PsyPlugin {
  const {
    walPath = './psyqueue.wal',
    autoRecover = true,
    onRecoverActiveJob = 'requeue',
  } = opts

  let wal: WriteAheadLog | null = null
  let kernel: Kernel | null = null

  return {
    name: 'crash-recovery',
    version: '0.1.0',
    depends: ['backend'],

    init(k: Kernel): void {
      kernel = k
      wal = new WriteAheadLog(walPath)

      // --- process: guard phase — record job as 'active' BEFORE processing ---
      k.pipeline(
        'process',
        async (ctx, next) => {
          wal!.writeEntry({
            jobId: ctx.job.id,
            status: 'active',
            timestamp: Date.now(),
          })
          await next()
        },
        { phase: 'guard' },
      )

      // --- process: finalize phase — record job as 'completed' AFTER processing ---
      k.pipeline(
        'process',
        async (ctx, next) => {
          wal!.writeEntry({
            jobId: ctx.job.id,
            status: 'completed',
            timestamp: Date.now(),
          })
          await next()
        },
        { phase: 'finalize' },
      )

      // --- fail: finalize phase — record job as 'failed' ---
      k.pipeline(
        'fail',
        async (ctx, next) => {
          wal!.writeEntry({
            jobId: ctx.job.id,
            status: 'failed',
            timestamp: Date.now(),
          })
          await next()
        },
        { phase: 'finalize' },
      )
    },

    async start(): Promise<void> {
      if (!autoRecover || !wal || !kernel) return

      const backend = kernel.getBackend() as unknown as RecoveryBackend
      await recoverFromWal(wal, backend, { onRecoverActiveJob })
    },

    async stop(): Promise<void> {
      if (wal) {
        wal.close()
      }
    },
  }
}
