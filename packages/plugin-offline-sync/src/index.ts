import type { PsyPlugin, Kernel } from 'psyqueue'
import { SyncEngine } from './sync-engine.js'

export { SyncEngine } from './sync-engine.js'

export interface OfflineSyncOpts {
  localPath: string
  remote?: string // namespace of the remote backend (default: 'backend')
  sync?: {
    intervalMs?: number
    autoSync?: boolean
  }
  maxLocalJobs?: number
}

export function offlineSync(opts: OfflineSyncOpts): PsyPlugin {
  let engine: SyncEngine | null = null
  let syncInterval: ReturnType<typeof setInterval> | null = null
  let kernel: Kernel | null = null

  return {
    name: 'offline-sync',
    version: '0.1.0',
    provides: 'offline-sync',

    init(k: Kernel): void {
      kernel = k

      // Register guard middleware on enqueue: if remote fails, buffer locally
      k.pipeline('enqueue', async (ctx, next) => {
        if (!engine) {
          await next()
          return
        }

        try {
          await next()
        } catch (_err) {
          // Remote enqueue failed — buffer locally
          await engine.enqueueLocal(ctx.job)
          k.events.emit('offline:fallback', {
            jobId: ctx.job.id,
            queue: ctx.job.queue,
            error: _err instanceof Error ? _err.message : String(_err),
          }, 'offline-sync')
        }
      }, { phase: 'guard' })
    },

    async start(): Promise<void> {
      if (!kernel) throw new Error('Plugin not initialized')

      const backend = kernel.getBackend()

      engine = new SyncEngine({
        localPath: opts.localPath,
        remote: backend,
        maxLocalJobs: opts.maxLocalJobs,
        onEvent: (event, data) => {
          kernel!.events.emit(event, data, 'offline-sync')
        },
      })

      kernel.expose('offline-sync', {
        engine,
        push: () => engine!.push(),
        unsyncedCount: () => engine!.unsyncedCount(),
        listLocal: () => engine!.listLocal(),
      })

      // Auto-sync if configured
      if (opts.sync?.autoSync !== false && opts.sync?.intervalMs) {
        syncInterval = setInterval(async () => {
          try {
            const synced = await engine!.push()
            if (synced > 0) {
              kernel!.events.emit('offline:auto-synced', { count: synced }, 'offline-sync')
            }
          } catch (_err) {
            // Ignore sync errors during auto-sync
          }
        }, opts.sync.intervalMs)
      }
    },

    async stop(): Promise<void> {
      if (syncInterval) {
        clearInterval(syncInterval)
        syncInterval = null
      }

      // Final push attempt before shutting down
      if (engine) {
        try {
          await engine.push()
        } catch (_err) {
          // Best effort
        }
        engine.close()
        engine = null
      }
    },
  }
}
