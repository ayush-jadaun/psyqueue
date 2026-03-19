import type { PsyPlugin, Kernel } from '@psyqueue/core'
import { PostgresBackendAdapter } from './adapter.js'
import type { PostgresAdapterOpts } from './adapter.js'

export type { PostgresAdapterOpts }

export function postgres(opts: PostgresAdapterOpts = {}): PsyPlugin {
  const adapter = new PostgresBackendAdapter(opts)
  return {
    name: 'backend-postgres',
    version: '0.1.0',
    provides: 'backend',
    init(kernel: Kernel) {
      kernel.expose('backend', adapter as unknown as Record<string, unknown>)
    },
    async start() { await adapter.connect() },
    async stop() { await adapter.disconnect() },
  }
}

export { PostgresBackendAdapter } from './adapter.js'
