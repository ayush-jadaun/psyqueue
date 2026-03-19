import type { PsyPlugin, Kernel } from '@psyqueue/core'
import { HttpWorkerServer } from './server.js'

export { HttpWorkerServer } from './server.js'

export interface HttpWorkersOpts {
  port: number
  auth?: { type: 'bearer'; tokens: string[] }
  queues?: string[]
}

export function httpWorkers(opts: HttpWorkersOpts): PsyPlugin {
  let server: HttpWorkerServer | null = null
  let kernel: Kernel | null = null

  return {
    name: 'http-workers',
    version: '0.1.0',
    provides: 'http-workers',

    init(k: Kernel): void {
      kernel = k
    },

    async start(): Promise<void> {
      if (!kernel) throw new Error('Plugin not initialized')

      const backend = kernel.getBackend()
      server = new HttpWorkerServer({
        port: opts.port,
        auth: opts.auth,
        queues: opts.queues,
        backend,
        onEvent: (event, data) => {
          kernel!.events.emit(event, data, 'http-workers')
        },
      })

      const port = await server.listen()
      kernel.events.emit('http:listening', { port }, 'http-workers')

      kernel.expose('http-workers', {
        server,
        port,
        getWorkers: () => server!.getWorkers(),
      })
    },

    async stop(): Promise<void> {
      if (server) {
        await server.shutdown()
        server = null
      }
    },
  }
}
