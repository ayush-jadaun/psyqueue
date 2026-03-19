import type { PsyPlugin, Kernel } from '@psyqueue/core'
import { SQLiteBackendAdapter } from './adapter.js'

export interface SQLiteOpts {
  path: string // ':memory:' for in-memory, or file path
}

export function sqlite(opts: SQLiteOpts): PsyPlugin {
  const adapter = new SQLiteBackendAdapter(opts)
  return {
    name: 'backend-sqlite',
    version: '0.1.0',
    provides: 'backend',
    init(kernel: Kernel) {
      kernel.expose('backend', adapter as unknown as Record<string, unknown>)
    },
    async start() { await adapter.connect() },
    async stop() { await adapter.disconnect() },
  }
}

export { SQLiteBackendAdapter } from './adapter.js'
export type { SQLiteAdapterOpts } from './adapter.js'
