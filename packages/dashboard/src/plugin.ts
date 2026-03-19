import type { PsyPlugin, Kernel, BackendAdapter } from 'psyqueue'
import { createDashboardServer } from './server.js'

export interface DashboardOpts {
  port?: number
  auth?: {
    type: 'basic' | 'bearer'
    credentials: string
  }
}

export function dashboard(opts: DashboardOpts = {}): PsyPlugin {
  let stopFn: (() => Promise<void>) | null = null

  return {
    name: 'dashboard',
    version: '0.1.0',
    provides: 'dashboard',
    depends: ['backend'],

    init(kernel: Kernel): void {
      const server = createDashboardServer({
        port: opts.port,
        auth: opts.auth,
        getBackend: () => kernel.getBackend() as unknown as BackendAdapter,
      })

      kernel.expose('dashboard', {
        getApp: () => server.app,
        start: () => server.start(),
        stop: () => server.stop(),
      })

      stopFn = server.stop
    },

    async start(): Promise<void> {
      // Server auto-starts are managed by the user or via exposed API
    },

    async stop(): Promise<void> {
      if (stopFn) {
        await stopFn()
      }
    },
  }
}
