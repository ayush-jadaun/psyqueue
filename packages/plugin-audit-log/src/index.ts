import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'
import type { PsyPlugin, Kernel, LifecycleEvent } from '@psyqueue/core'
import type { AuditEntry, AuditFilter } from './types.js'
import { computeHash, verifyChain } from './hash-chain.js'

export type { AuditEntry, AuditFilter } from './types.js'
export { computeHash, verifyChain } from './hash-chain.js'

export interface AuditLogOpts {
  store: 'memory' | 'file'
  filePath?: string
  events?: 'all' | string[]
  includePayload?: boolean
  hashChain?: boolean
  retention?: string   // e.g. '90d' — metadata only, not auto-pruned
}

export interface AuditAPI {
  query(filter?: AuditFilter): AuditEntry[]
  verify(from?: number, to?: number): boolean
}

export type AuditLogPlugin = PsyPlugin & {
  audit: AuditAPI
}

// Middleware pipeline lifecycle events that PsyQueue actually runs
const PIPELINE_EVENTS: LifecycleEvent[] = ['enqueue', 'process']

// Bus events we can listen to for additional audit trail
const BUS_EVENTS: string[] = [
  'job:completed',
  'job:failed',
  'job:retry',
  'job:dead',
  'job:requeued',
  'job:replayed',
  'job:enqueued',
  'job:started',
]

export function auditLog(opts: AuditLogOpts): AuditLogPlugin {
  const includePayload = opts.includePayload ?? false
  const useHashChain = opts.hashChain ?? true
  const eventsFilter = opts.events ?? 'all'

  const memoryStore: AuditEntry[] = []
  let lastHash = ''

  function shouldRecord(eventName: string): boolean {
    if (eventsFilter === 'all') return true
    return (eventsFilter as string[]).includes(eventName)
  }

  function writeEntry(entry: AuditEntry): void {
    if (opts.store === 'memory') {
      memoryStore.push(entry)
    } else {
      if (!opts.filePath) {
        throw new Error('filePath is required for file store')
      }
      const dir = dirname(opts.filePath)
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
      }
      appendFileSync(opts.filePath, JSON.stringify(entry) + '\n', 'utf8')
    }
  }

  function recordEvent(
    eventName: string,
    job: { id: string; name: string; queue: string; tenantId?: string; payload?: unknown },
  ): void {
    if (!shouldRecord(eventName)) return

    const prevHash = lastHash
    const entryWithoutHash: Omit<AuditEntry, 'hash'> = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      event: eventName,
      jobId: job.id,
      jobName: job.name,
      queue: job.queue,
      tenantId: job.tenantId,
      prevHash,
      ...(includePayload ? { payload: job.payload } : {}),
    }

    const hash = useHashChain ? computeHash(entryWithoutHash, prevHash) : ''
    const entry: AuditEntry = { ...entryWithoutHash, hash }

    lastHash = hash
    writeEntry(entry)
  }

  const auditAPI: AuditAPI = {
    query(filter?: AuditFilter): AuditEntry[] {
      let results = [...memoryStore]

      if (filter?.event) {
        const events = Array.isArray(filter.event) ? filter.event : [filter.event]
        results = results.filter(e => events.includes(e.event))
      }
      if (filter?.jobId) {
        results = results.filter(e => e.jobId === filter.jobId)
      }
      if (filter?.queue) {
        results = results.filter(e => e.queue === filter.queue)
      }
      if (filter?.from) {
        const from = filter.from.getTime()
        results = results.filter(e => new Date(e.timestamp).getTime() >= from)
      }
      if (filter?.to) {
        const to = filter.to.getTime()
        results = results.filter(e => new Date(e.timestamp).getTime() <= to)
      }

      return results
    },

    verify(from = 0, to?: number): boolean {
      const slice = memoryStore.slice(from, to)
      return verifyChain(slice)
    },
  }

  const plugin: AuditLogPlugin = {
    name: 'audit-log',
    version: '0.1.0',
    provides: 'audit-log',
    audit: auditAPI,

    init(k: Kernel): void {
      // Register finalize-phase middleware for pipeline lifecycle events
      for (const lifecycleEvent of PIPELINE_EVENTS) {
        k.pipeline(
          lifecycleEvent,
          async (ctx, next) => {
            await next()
            recordEvent(lifecycleEvent, ctx.job)
          },
          { phase: 'finalize' },
        )
      }

      // Listen to bus events for completed/failed/etc
      for (const busEvent of BUS_EVENTS) {
        k.events.on(busEvent, (event) => {
          const data = event.data as {
            jobId?: string
            queue?: string
            name?: string
            tenantId?: string
          }
          if (!data.jobId || !data.name || !data.queue) return
          recordEvent(busEvent, {
            id: data.jobId,
            name: data.name,
            queue: data.queue,
            tenantId: data.tenantId,
          })
        })
      }
    },

    async start(): Promise<void> {
      // Nothing
    },

    async stop(): Promise<void> {
      // Nothing
    },
  }

  return plugin
}
