import type { PsyPlugin, Kernel } from '@psyqueue/core'
import { RedisBackendAdapter } from './adapter.js'
import type { RedisAdapterOpts } from './adapter.js'

export type { RedisAdapterOpts }

export function redis(opts: RedisAdapterOpts = {}): PsyPlugin {
  const adapter = new RedisBackendAdapter(opts)
  return {
    name: 'backend-redis',
    version: '0.1.0',
    provides: 'backend',
    init(kernel: Kernel) {
      kernel.expose('backend', adapter as unknown as Record<string, unknown>)
    },
    async start() { await adapter.connect() },
    async stop() { await adapter.disconnect() },
  }
}

export { RedisBackendAdapter, serializeJobToHash, deserializeJobFromHash } from './adapter.js'
