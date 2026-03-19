import express, { type Request, type Response, type NextFunction } from 'express'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import type { BackendAdapter, JobFilter, JobStatus } from 'psyqueue'
import type http from 'node:http'

export interface DashboardServerOpts {
  port?: number
  auth?: {
    type: 'basic' | 'bearer'
    credentials: string // "user:pass" for basic, token for bearer
  }
  getBackend: () => BackendAdapter
}

export function createDashboardServer(opts: DashboardServerOpts): {
  app: express.Express
  start: () => Promise<http.Server>
  stop: () => Promise<void>
} {
  const app = express()
  let server: http.Server | null = null

  // Auth middleware
  if (opts.auth) {
    app.use(authMiddleware(opts.auth))
  }

  app.use(express.json())

  // GET /api/health
  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() })
  })

  // GET /api/overview
  app.get('/api/overview', async (_req: Request, res: Response) => {
    try {
      const backend = opts.getBackend()
      const statuses: JobStatus[] = ['pending', 'active', 'completed', 'failed', 'dead']
      const counts: Record<string, number> = {}

      for (const status of statuses) {
        const result = await backend.listJobs({ status, limit: 0 })
        counts[status] = result.total
      }

      res.json({
        totalPending: counts['pending'] ?? 0,
        totalActive: counts['active'] ?? 0,
        totalCompleted: counts['completed'] ?? 0,
        totalFailed: (counts['failed'] ?? 0) + (counts['dead'] ?? 0),
        queues: [],
      })
    } catch (err) {
      res.status(500).json({ error: String(err) })
    }
  })

  // GET /api/queues
  app.get('/api/queues', async (_req: Request, res: Response) => {
    try {
      const backend = opts.getBackend()
      // List all jobs to deduce queues — since backend has no listQueues,
      // we gather from existing jobs
      const result = await backend.listJobs({ limit: 1000 })
      const queueMap = new Map<string, { pending: number; active: number; completed: number; failed: number }>()

      for (const job of result.data) {
        if (!queueMap.has(job.queue)) {
          queueMap.set(job.queue, { pending: 0, active: 0, completed: 0, failed: 0 })
        }
        const q = queueMap.get(job.queue)!
        if (job.status === 'pending' || job.status === 'scheduled') q.pending++
        else if (job.status === 'active') q.active++
        else if (job.status === 'completed') q.completed++
        else if (job.status === 'failed' || job.status === 'dead') q.failed++
      }

      const queues = Array.from(queueMap.entries()).map(([name, counts]) => ({
        name,
        ...counts,
      }))

      res.json({ queues })
    } catch (err) {
      res.status(500).json({ error: String(err) })
    }
  })

  // GET /api/jobs?queue=X&status=Y&limit=N
  app.get('/api/jobs', async (req: Request, res: Response) => {
    try {
      const backend = opts.getBackend()
      const filter: JobFilter = {}
      if (req.query['queue']) filter.queue = String(req.query['queue'])
      if (req.query['status']) filter.status = String(req.query['status']) as JobStatus
      if (req.query['limit']) filter.limit = Number(req.query['limit'])
      if (req.query['offset']) filter.offset = Number(req.query['offset'])

      const result = await backend.listJobs(filter)
      res.json(result)
    } catch (err) {
      res.status(500).json({ error: String(err) })
    }
  })

  // GET /api/jobs/:id
  app.get('/api/jobs/:id', async (req: Request, res: Response) => {
    try {
      const backend = opts.getBackend()
      const job = await backend.getJob(req.params['id']!)
      if (!job) {
        res.status(404).json({ error: 'Job not found' })
        return
      }
      res.json(job)
    } catch (err) {
      res.status(500).json({ error: String(err) })
    }
  })

  // POST /api/jobs/:id/retry
  app.post('/api/jobs/:id/retry', async (req: Request, res: Response) => {
    try {
      const backend = opts.getBackend()
      const job = await backend.getJob(req.params['id']!)
      if (!job) {
        res.status(404).json({ error: 'Job not found' })
        return
      }
      if (job.status !== 'dead' && job.status !== 'failed') {
        res.status(400).json({ error: `Job is not in dead/failed state (status: ${job.status})` })
        return
      }
      await backend.nack(job.id, { requeue: true })
      res.json({ success: true, jobId: job.id })
    } catch (err) {
      res.status(500).json({ error: String(err) })
    }
  })

  // ─── Live Events (Server-Sent Events) ────────────────────────────────
  // Streams real-time job events to the browser via SSE.
  // Uses QueueEvents (cross-process Pub/Sub + Stream) when Redis URL provided,
  // otherwise falls back to in-process event bus polling.
  const sseClients = new Set<Response>()

  app.get('/api/events/stream', (req: Request, res: Response) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    })
    res.write('data: {"event":"connected"}\n\n')
    sseClients.add(res)
    req.on('close', () => { sseClients.delete(res) })
  })

  // Broadcast to all SSE clients
  function broadcastEvent(data: Record<string, unknown>) {
    const msg = `data: ${JSON.stringify(data)}\n\n`
    for (const client of sseClients) {
      try { client.write(msg) } catch { sseClients.delete(client) }
    }
  }

  // Expose broadcastEvent so the plugin can wire it to QueueEvents
  ;(app as any)._broadcastEvent = broadcastEvent

  // Recent events buffer (last 100 for polling clients)
  const recentEvents: Array<Record<string, unknown>> = []

  app.get('/api/events/recent', (_req: Request, res: Response) => {
    res.json({ events: recentEvents.slice(-100) })
  })

  // Hook: store + broadcast when called externally
  ;(app as any)._pushEvent = (evt: Record<string, unknown>) => {
    recentEvents.push({ ...evt, _receivedAt: Date.now() })
    if (recentEvents.length > 500) recentEvents.splice(0, recentEvents.length - 500)
    broadcastEvent(evt)
  }

  // Serve built UI static files
  const currentDir = path.dirname(fileURLToPath(import.meta.url))
  const uiDir = path.resolve(currentDir, '..', 'dist', 'ui')
  if (fs.existsSync(uiDir)) {
    app.use(express.static(uiDir))
    // SPA fallback — serve index.html for any non-API route
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(uiDir, 'index.html'))
    })
  }

  return {
    app,
    start: () => {
      return new Promise<http.Server>((resolve) => {
        const port = opts.port ?? 9999
        server = app.listen(port, () => {
          resolve(server!)
        })
      })
    },
    stop: () => {
      return new Promise<void>((resolve, reject) => {
        if (server) {
          server.close((err) => {
            if (err) reject(err)
            else resolve()
          })
          server = null
        } else {
          resolve()
        }
      })
    },
  }
}

function authMiddleware(auth: NonNullable<DashboardServerOpts['auth']>) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (auth.type === 'bearer') {
      const header = req.headers['authorization']
      if (!header || header !== `Bearer ${auth.credentials}`) {
        res.status(401).json({ error: 'Unauthorized' })
        return
      }
    } else if (auth.type === 'basic') {
      const header = req.headers['authorization']
      if (!header || !header.startsWith('Basic ')) {
        res.status(401).json({ error: 'Unauthorized' })
        return
      }
      const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8')
      if (decoded !== auth.credentials) {
        res.status(401).json({ error: 'Unauthorized' })
        return
      }
    }
    next()
  }
}
