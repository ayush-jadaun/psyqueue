import type { PsyPlugin, Kernel } from '@psyqueue/core'
import { DuplicateJobError } from '@psyqueue/core'

export interface ExactlyOnceOpts {
  /** How long an idempotency key is held, e.g. '24h', '1h', '5m', '30s', '500ms'. Default: '24h' */
  window?: string
  /** What to do when a duplicate is detected. Default: 'ignore' */
  onDuplicate?: 'ignore' | 'reject'
  /** @deprecated No effect. Keys are stored and expired by the backend. */
  cleanupInterval?: string
}

/**
 * Parses a human-readable duration string into milliseconds.
 *
 * Supported units: ms, s, m, h, d
 * Examples: '24h' → 86400000, '1h' → 3600000, '5m' → 300000, '500ms' → 500
 */
export function parseWindow(input: string): number {
  const trimmed = input.trim()

  // Check ms first (before checking 'm' to avoid ambiguity)
  const msMatch = trimmed.match(/^(\d+(?:\.\d+)?)ms$/)
  if (msMatch) return parseFloat(msMatch[1]!)

  const match = trimmed.match(/^(\d+(?:\.\d+)?)([smhd])$/)
  if (!match) {
    throw new Error(
      `Invalid window format: "${input}". Expected formats like '24h', '1h', '5m', '30s', or '500ms'.`
    )
  }

  const value = parseFloat(match[1]!)
  const unit = match[2]!

  switch (unit) {
    case 's': return value * 1_000
    case 'm': return value * 60_000
    case 'h': return value * 3_600_000
    case 'd': return value * 86_400_000
    default:
      throw new Error(`Unknown unit "${unit}" in window: "${input}"`)
  }
}

/**
 * Idempotent enqueue.
 *
 * Deduplication itself is done by the backend, atomically with the insert, so
 * it holds across processes and restarts: while a job with the same queue,
 * name and `idempotencyKey` exists and hasn't failed or died, enqueue returns
 * that job's id. This plugin sets the key's lifetime (`window`) and can turn
 * duplicates into a `DuplicateJobError` (`onDuplicate: 'reject'`).
 *
 * Processing stays at-least-once (a retried or reclaimed job runs again), so
 * handlers with side effects should still be idempotent.
 */
export function exactlyOnce(opts: ExactlyOnceOpts = {}): PsyPlugin {
  const windowMs = parseWindow(opts.window ?? '24h')
  const onDuplicate = opts.onDuplicate ?? 'ignore'

  return {
    name: 'exactly-once',
    version: '0.1.0',
    provides: 'exactly-once',
    depends: ['backend'],

    init(kernel: Kernel): void {
      kernel.pipeline(
        'enqueue',
        async (ctx, next) => {
          const key = ctx.job.idempotencyKey
          if (!key) return next()

          ctx.job.idempotencyTtl ??= windowMs
          await next()

          const existingJobId = ctx.state['_duplicateOf'] as string | undefined
          if (existingJobId && onDuplicate === 'reject') {
            throw new DuplicateJobError(key, existingJobId)
          }
        },
        { phase: 'guard' },
      )
    },
  }
}
