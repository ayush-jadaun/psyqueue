import * as http from 'node:http'
import type { BackendAdapter, DequeuedJob } from 'psyqueue'

export interface HttpServerOpts {
  port: number
  auth?: { type: 'bearer'; tokens: string[] }
  queues?: string[]
  backend: BackendAdapter
  onEvent?: (event: string, data: Record<string, unknown>) => void
}

interface WorkerRegistration {
  workerId: string
  queues: string[]
  registeredAt: number
}

function parseBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8')
      if (!raw) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(raw))
      } catch (err) {
        reject(err)
      }
    })
    req.on('error', reject)
  })
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(json),
  })
  res.end(json)
}

export class HttpWorkerServer {
  private server: http.Server
  private readonly opts: HttpServerOpts
  private workers = new Map<string, WorkerRegistration>()

  constructor(opts: HttpServerOpts) {
    this.opts = opts
    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res).catch((err) => {
        sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
      })
    })
  }

  private checkAuth(req: http.IncomingMessage): boolean {
    if (!this.opts.auth) return true
    const authHeader = req.headers['authorization'] || ''
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
    return this.opts.auth.tokens.includes(token)
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
    const method = req.method?.toUpperCase() || 'GET'
    const pathname = url.pathname

    // Auth check
    if (!this.checkAuth(req)) {
      sendJson(res, 401, { error: 'Unauthorized' })
      return
    }

    // Route: GET /jobs/fetch?queue=xxx&count=N
    if (method === 'GET' && pathname === '/jobs/fetch') {
      const queue = url.searchParams.get('queue') || 'default'
      const count = parseInt(url.searchParams.get('count') || '1', 10)

      if (this.opts.queues && this.opts.queues.length > 0 && !this.opts.queues.includes(queue)) {
        sendJson(res, 403, { error: `Queue "${queue}" is not in the allowed list` })
        return
      }

      const jobs = await this.opts.backend.dequeue(queue, count)
      const mapped = jobs.map((j: DequeuedJob) => ({
        id: j.id,
        queue: j.queue,
        name: j.name,
        payload: j.payload,
        completionToken: j.completionToken,
        attempt: j.attempt,
        maxRetries: j.maxRetries,
      }))

      this.opts.onEvent?.('http:fetch', { queue, count: jobs.length })
      sendJson(res, 200, { jobs: mapped })
      return
    }

    // Route: POST /jobs/:id/ack
    const ackMatch = pathname.match(/^\/jobs\/([^/]+)\/ack$/)
    if (method === 'POST' && ackMatch) {
      const jobId = ackMatch[1]!
      const body = await parseBody(req) as { completionToken?: string }
      const result = await this.opts.backend.ack(jobId, body.completionToken)
      this.opts.onEvent?.('http:ack', { jobId })
      sendJson(res, 200, { alreadyCompleted: result.alreadyCompleted })
      return
    }

    // Route: POST /jobs/:id/nack
    const nackMatch = pathname.match(/^\/jobs\/([^/]+)\/nack$/)
    if (method === 'POST' && nackMatch) {
      const jobId = nackMatch[1]!
      const body = await parseBody(req) as { requeue?: boolean; delay?: number; reason?: string }
      await this.opts.backend.nack(jobId, {
        requeue: body.requeue,
        delay: body.delay,
        reason: body.reason,
      })
      this.opts.onEvent?.('http:nack', { jobId })
      sendJson(res, 200, { ok: true })
      return
    }

    // Route: POST /workers/register
    if (method === 'POST' && pathname === '/workers/register') {
      const body = await parseBody(req) as { workerId?: string; queues?: string[] }
      const workerId = body.workerId || `worker-${Date.now()}`
      const workerQueues = body.queues || ['default']

      this.workers.set(workerId, {
        workerId,
        queues: workerQueues,
        registeredAt: Date.now(),
      })

      this.opts.onEvent?.('http:worker-registered', { workerId, queues: workerQueues })
      sendJson(res, 200, { workerId, queues: workerQueues, ok: true })
      return
    }

    // 404
    sendJson(res, 404, { error: 'Not found' })
  }

  async listen(): Promise<number> {
    return new Promise((resolve) => {
      this.server.listen(this.opts.port, () => {
        const addr = this.server.address()
        const port = typeof addr === 'object' && addr ? addr.port : this.opts.port
        resolve(port)
      })
    })
  }

  async shutdown(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.close((err) => {
        if (err) reject(err)
        else resolve()
      })
    })
  }

  getWorkers(): Map<string, WorkerRegistration> {
    return new Map(this.workers)
  }
}
