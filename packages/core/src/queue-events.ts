/**
 * Cross-process event listener for PsyQueue.
 *
 * Unlike q.events.on() which is in-process only, QueueEvents works across
 * multiple servers/processes via Redis Pub/Sub + Stream backup.
 *
 * Primary path: SUBSCRIBE psyqueue:{queue}:events -> instant delivery via Pub/Sub.
 * On reconnect: XREAD from lastStreamId to catch up on missed events.
 *
 * Requires 1 dedicated Redis connection (SUBSCRIBE blocks the connection) and
 * 1 command connection for XREAD catch-up.
 *
 * Usage:
 *   const events = new QueueEvents({ url: 'redis://localhost:6379', queue: 'emails' })
 *   await events.start()
 *   events.on('completed', (data) => console.log('Job done:', data.jobId))
 *   await events.stop()
 */

export interface QueueEventsOpts {
  /** Redis URL */
  url: string
  /** Queue name to subscribe to */
  queue: string
  /** Key prefix (default: 'psyqueue') */
  prefix?: string
  /** Stream MAXLEN for backup (default: 500) */
  streamMaxLen?: number
}

export type QueueEventType = 'completed' | 'failed' | 'stalled' | 'progress' | 'active' | 'enqueued'

export interface QueueEventData {
  event: QueueEventType
  jobId: string
  result?: unknown
  error?: string
  data?: unknown
  timestamp: number
}

export type QueueEventHandler = (data: QueueEventData) => void

export class QueueEvents {
  private subClient: any = null      // SUBSCRIBE connection (dedicated, blocked)
  private cmdClient: any = null      // Command connection for XREAD
  private handlers = new Map<string, Set<QueueEventHandler>>()
  private lastStreamId = '$'         // Start from latest
  private running = false
  private channel: string
  private streamKey: string

  constructor(private opts: QueueEventsOpts) {
    const prefix = opts.prefix ?? 'psyqueue'
    this.channel = `${prefix}:${opts.queue}:events`
    this.streamKey = `${prefix}:${opts.queue}:events:stream`
  }

  on(event: QueueEventType | '*', handler: QueueEventHandler): void {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set())
    this.handlers.get(event)!.add(handler)
  }

  off(event: string, handler: QueueEventHandler): void {
    this.handlers.get(event)?.delete(handler)
  }

  async start(): Promise<void> {
    // Create ioredis instances
    const IORedis = (await import('ioredis')).default
    const Redis = (IORedis as any).default ?? IORedis

    this.subClient = new Redis(this.opts.url)
    this.cmdClient = new Redis(this.opts.url)

    // Wait for both connections to be ready
    await Promise.all([
      this.waitForReady(this.subClient),
      this.waitForReady(this.cmdClient),
    ])

    // Subscribe to Pub/Sub channel
    await this.subClient.subscribe(this.channel)
    this.subClient.on('message', (_ch: string, message: string) => {
      try {
        const parsed = JSON.parse(message)
        const data: QueueEventData = {
          event: parsed.event,
          jobId: parsed.jobId ?? '',
          result: parsed.result ? this.tryParseJson(parsed.result) : undefined,
          error: parsed.error,
          timestamp: parseInt(parsed.ts ?? '0', 10),
        }
        this.emitToHandlers(data)
      } catch { /* ignore malformed messages */ }
    })

    // On reconnect, catch up from stream and re-subscribe
    this.subClient.on('ready', async () => {
      if (this.running) {
        await this.catchUpFromStream()
        await this.subClient.subscribe(this.channel).catch(() => {})
      }
    })

    this.running = true
  }

  async stop(): Promise<void> {
    this.running = false
    if (this.subClient) {
      await this.subClient.unsubscribe(this.channel).catch(() => {})
      await this.subClient.quit().catch(() => {})
      this.subClient = null
    }
    if (this.cmdClient) {
      await this.cmdClient.quit().catch(() => {})
      this.cmdClient = null
    }
  }

  /** Wait for a specific job to complete or fail */
  async waitUntilFinished(jobId: string, timeoutMs = 30000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error(`Job ${jobId} did not finish within ${timeoutMs}ms`))
      }, timeoutMs)

      const onCompleted = (data: QueueEventData) => {
        if (data.jobId === jobId) { cleanup(); resolve(data.result) }
      }
      const onFailed = (data: QueueEventData) => {
        if (data.jobId === jobId) { cleanup(); reject(new Error(data.error ?? 'Job failed')) }
      }

      const cleanup = () => {
        clearTimeout(timer)
        this.off('completed', onCompleted)
        this.off('failed', onFailed)
      }

      this.on('completed', onCompleted)
      this.on('failed', onFailed)
    })
  }

  private emitToHandlers(data: QueueEventData): void {
    const handlers = this.handlers.get(data.event)
    if (handlers) {
      for (const h of handlers) {
        try { h(data) } catch { /* handler error must not break others */ }
      }
    }
    // Also emit to wildcard '*' listeners
    const wildcards = this.handlers.get('*')
    if (wildcards) {
      for (const h of wildcards) {
        try { h(data) } catch { /* handler error must not break others */ }
      }
    }
  }

  private async catchUpFromStream(): Promise<void> {
    if (!this.cmdClient) return
    try {
      const result = await this.cmdClient.xread('COUNT', 1000, 'STREAMS', this.streamKey, this.lastStreamId)
      if (result) {
        for (const [, entries] of result) {
          for (const [id, fields] of entries) {
            this.lastStreamId = id
            // Convert field array to object
            const obj: Record<string, string> = {}
            for (let i = 0; i < fields.length; i += 2) {
              obj[fields[i]] = fields[i + 1]
            }
            const data: QueueEventData = {
              event: obj['event'] as QueueEventType,
              jobId: obj['jobId'] ?? '',
              result: obj['result'] ? this.tryParseJson(obj['result']) : undefined,
              error: obj['error'],
              timestamp: parseInt(id.split('-')[0] ?? '0', 10),
            }
            this.emitToHandlers(data)
          }
        }
      }
    } catch { /* stream catch-up best effort */ }
  }

  private tryParseJson(value: string): unknown {
    try { return JSON.parse(value) } catch { return value }
  }

  private waitForReady(client: any): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (client.status === 'ready') { resolve(); return }
      const onReady = () => { client.off('error', onError); resolve() }
      const onError = (err: Error) => { client.off('ready', onReady); reject(err) }
      client.once('ready', onReady)
      client.once('error', onError)
    })
  }
}
