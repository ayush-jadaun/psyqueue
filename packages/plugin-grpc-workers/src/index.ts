import type { PsyPlugin, Kernel } from '@psyqueue/core'
import { GrpcWorkerServer } from './server.js'

export { GrpcWorkerServer } from './server.js'

export interface GrpcWorkersOpts {
  port: number
  auth?: boolean
  tokens?: string[]
  queues?: string[]
}

export function grpcWorkers(opts: GrpcWorkersOpts): PsyPlugin {
  let server: GrpcWorkerServer | null = null
  let kernel: Kernel | null = null

  return {
    name: 'grpc-workers',
    version: '0.1.0',
    provides: 'grpc-workers',

    init(k: Kernel): void {
      kernel = k
    },

    async start(): Promise<void> {
      if (!kernel) throw new Error('Plugin not initialized')

      const backend = kernel.getBackend()
      server = new GrpcWorkerServer({
        port: opts.port,
        tokens: opts.auth !== false ? opts.tokens : undefined,
        queues: opts.queues,
        backend,
        onEvent: (event, data) => {
          kernel!.events.emit(event, data, 'grpc-workers')
        },
      })

      const port = await server.listen()
      kernel.events.emit('grpc:listening', { port }, 'grpc-workers')

      kernel.expose('grpc-workers', {
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
