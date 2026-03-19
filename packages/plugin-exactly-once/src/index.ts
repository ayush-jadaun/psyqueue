import type { PsyPlugin, Kernel } from 'psyqueue'
import { DuplicateJobError } from 'psyqueue'
import { DedupStore } from './dedup.js'

export type { DedupStore }

export interface ExactlyOnceOpts {
  /** Dedup window, e.g. '24h', '1h', '5m', '30s', '500ms'. Default: '24h' */
  window?: string
  /** What to do when a duplicate is detected. Default: 'ignore' */
  onDuplicate?: 'ignore' | 'reject'
  /** How often to prune expired keys. Default: '1h' */
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
 * Creates the exactly-once plugin which provides idempotency key deduplication.
 *
 * When a job is enqueued with an `idempotencyKey`, the plugin checks whether
 * a job with the same key was already enqueued within the dedup window:
 *   - 'ignore' (default): returns the original jobId without creating a new job
 *   - 'reject': throws a DuplicateJobError
 *
 * Jobs without an `idempotencyKey` are not affected.
 */
export function exactlyOnce(opts: ExactlyOnceOpts = {}): PsyPlugin {
  const windowMs = parseWindow(opts.window ?? '24h')
  const onDuplicate = opts.onDuplicate ?? 'ignore'
  const cleanupIntervalMs = parseWindow(opts.cleanupInterval ?? '1h')

  const store = new DedupStore()
  let cleanupTimer: ReturnType<typeof setInterval> | null = null

  const plugin: PsyPlugin = {
    name: 'exactly-once',
    version: '0.1.0',
    provides: 'exactly-once',
    depends: ['backend'],

    init(kernel: Kernel): void {
      // Guard phase — runs before the core execute phase (which persists the job)
      kernel.pipeline(
        'enqueue',
        async (ctx, next) => {
          const key = ctx.job.idempotencyKey
          if (!key) {
            // No idempotency key — pass through normally
            await next()
            return
          }

          const existingJobId = store.check(key)
          if (existingJobId !== null) {
            // Duplicate detected
            if (onDuplicate === 'reject') {
              throw new DuplicateJobError(key, existingJobId)
            }
            // 'ignore' mode: mutate ctx.job.id so the caller gets back the
            // original jobId. Do NOT call next() so the job is not persisted.
            ctx.job.id = existingJobId
            return
          }

          // Not a duplicate — reserve the key first to prevent concurrent races,
          // then enqueue normally, then update with the real jobId
          const placeholderId = ctx.job.id // pre-generated ULID
          store.store(key, placeholderId, windowMs)
          try {
            await next()
            // Update with the actual persisted jobId (may differ if backend changes it)
            store.store(key, ctx.job.id, windowMs)
          } catch (err) {
            // Enqueue failed — remove the reservation
            store.remove(key)
            throw err
          }
        },
        { phase: 'guard' },
      )
    },

    async start(): Promise<void> {
      cleanupTimer = setInterval(() => {
        store.cleanup()
      }, cleanupIntervalMs)
    },

    async stop(): Promise<void> {
      if (cleanupTimer !== null) {
        clearInterval(cleanupTimer)
        cleanupTimer = null
      }
    },
  }

  return plugin
}
