import type {
  BackendAdapter,
  DequeuedJob,
  EnqueueOpts,
  EventBusInterface,
  Job,
  JobFilter,
  JobHandler,
  HandlerOpts,
  Kernel,
  LifecycleEvent,
  Middleware,
  MiddlewarePhase,
  PaginatedResult,
  PsyPlugin,
  WorkerOpts,
} from './types.js'
import { EventBus } from './event-bus.js'
import { PluginRegistry } from './plugin-registry.js'
import { MiddlewarePipeline } from './middleware-pipeline.js'
import { createJob } from './job.js'
import { createContext } from './context.js'
import { PsyQueueError } from './errors.js'
import { WorkerPool } from './worker.js'
import { presets, type PresetConfig } from './presets.js'

interface RegisteredHandler {
  handler: JobHandler
  opts: HandlerOpts
}

export class PsyQueue {
  private readonly eventBus: EventBus
  private readonly pluginRegistry: PluginRegistry
  private readonly middlewarePipeline: MiddlewarePipeline
  private readonly kernel: Kernel
  private readonly handlers = new Map<string, RegisteredHandler>()
  private readonly exposed = new Map<string, Record<string, unknown>>()

  private backend: BackendAdapter | null = null
  private runningState = false
  private readonly workers = new Map<string, WorkerPool>()

  get isRunning(): boolean {
    return this.runningState
  }
  private coreMiddlewareRegistered = false

  /** Public event bus for subscriptions */
  readonly events: EventBusInterface

  /** Dead letter management */
  readonly deadLetter: {
    list(filter?: JobFilter): Promise<PaginatedResult<Job>>
    replay(jobId: string): Promise<void>
    replayAll(filter?: JobFilter): Promise<number>
    purge(opts?: { queue?: string; before?: Date }): Promise<number>
  }

  /**
   * Create a PsyQueue instance from a named preset configuration.
   * Returns the instance and the preset config (list of required plugin names).
   * The caller is responsible for installing and `.use()`-ing the actual plugins.
   */
  static from(
    preset: string | PresetConfig,
    overrides?: Partial<PresetConfig>,
  ): { queue: PsyQueue; config: PresetConfig } {
    let config: PresetConfig
    if (typeof preset === 'string') {
      const base = presets[preset]
      if (!base) {
        throw new PsyQueueError('UNKNOWN_PRESET', `Unknown preset "${preset}". Available: ${Object.keys(presets).join(', ')}`)
      }
      config = { ...base }
    } else {
      config = { ...preset }
    }

    if (overrides?.plugins) {
      config.plugins = [...config.plugins, ...overrides.plugins]
    }

    return { queue: new PsyQueue(), config }
  }

  constructor() {
    this.eventBus = new EventBus()
    this.middlewarePipeline = new MiddlewarePipeline()

    this.kernel = {
      events: this.eventBus,
      pipeline: (event: LifecycleEvent, fn: Middleware, opts?: { phase?: MiddlewarePhase }) => {
        this.middlewarePipeline.add(event, fn, {
          phase: opts?.phase ?? 'execute',
          pluginName: '__plugin__',
        })
      },
      getBackend: () => this.getBackend(),
      expose: (namespace: string, api: Record<string, unknown>) => {
        this.exposed.set(namespace, api)
        if (namespace === 'backend') {
          this.backend = api as unknown as BackendAdapter
        }
      },
      getExposed: (namespace: string) => {
        return this.exposed.get(namespace)
      },
    }

    this.pluginRegistry = new PluginRegistry(this.kernel)
    this.events = this.eventBus

    // Dead letter API
    this.deadLetter = {
      list: async (filter?: JobFilter) => {
        const backend = this.getBackend()
        return backend.listJobs({
          ...filter,
          status: 'dead',
        })
      },
      replay: async (jobId: string) => {
        const backend = this.getBackend()
        const job = await backend.getJob(jobId)
        if (!job) {
          throw new PsyQueueError('JOB_NOT_FOUND', `Job "${jobId}" not found`)
        }
        if (job.status !== 'dead') {
          throw new PsyQueueError('INVALID_STATE', `Job "${jobId}" is not in dead letter (status: ${job.status})`)
        }
        await backend.nack(jobId, { requeue: true })
        this.eventBus.emit('job:replayed', { jobId, queue: job.queue, name: job.name })
      },
      replayAll: async (filter?: JobFilter) => {
        const backend = this.getBackend()
        const result = await backend.listJobs({
          ...filter,
          status: 'dead',
        })
        let count = 0
        for (const job of result.data) {
          await backend.nack(job.id, { requeue: true })
          count++
        }
        return count
      },
      purge: async (opts?: { queue?: string; before?: Date }) => {
        const backend = this.getBackend()
        const filter: JobFilter = { status: 'dead' }
        if (opts?.queue) filter.queue = opts.queue
        if (opts?.before) filter.to = opts.before
        const result = await backend.listJobs(filter)
        for (const job of result.data) {
          await backend.nack(job.id, { requeue: false, deadLetter: false })
        }
        return result.data.length
      },
    }
  }

  /**
   * Register a plugin. Returns `this` for chaining.
   */
  use(plugin: PsyPlugin): this {
    this.pluginRegistry.register(plugin)
    return this
  }

  /**
   * Register user middleware for a lifecycle event.
   */
  pipeline(event: LifecycleEvent, fn: Middleware, opts?: { phase?: MiddlewarePhase }): void {
    this.middlewarePipeline.add(event, fn, {
      phase: opts?.phase ?? 'execute',
      pluginName: '__user__',
    })
  }

  /**
   * Register a job handler.
   */
  handle(name: string, handler: JobHandler, opts: HandlerOpts = {}): void {
    this.handlers.set(name, { handler, opts })
  }

  /**
   * Start the queue: connect the backend and start all plugins.
   */
  async start(): Promise<void> {
    if (!this.backend) {
      throw new PsyQueueError('NO_BACKEND', 'Cannot start without a backend. Register a backend plugin first.')
    }

    // Register core middleware once
    if (!this.coreMiddlewareRegistered) {
      this.coreMiddlewareRegistered = true

      // Core enqueue middleware: persist the job to backend
      this.middlewarePipeline.add('enqueue', async (c, next) => {
        await this.getBackend().enqueue(c.job)
        await next()
      }, { phase: 'execute', pluginName: '__core__' })
    }

    await this.backend.connect()
    await this.pluginRegistry.startAll()
    this.runningState = true
    this.eventBus.emit('kernel:started', {})
  }

  /**
   * Stop the queue: stop all workers, plugins, and disconnect the backend.
   */
  async stop(): Promise<void> {
    this.runningState = false
    await this.stopWorkers()
    await this.pluginRegistry.stopAll()
    if (this.backend) {
      await this.backend.disconnect()
    }
    this.eventBus.emit('kernel:stopped', {})
  }

  /**
   * Enqueue a job. Runs through the enqueue middleware pipeline, then persists via backend.
   */
  async enqueue(name: string, payload: unknown, opts?: EnqueueOpts): Promise<string> {
    const backend = this.getBackend()
    const job = createJob(name, payload, opts)

    const ctx = createContext(job, 'enqueue', {
      enqueue: (n, p, o) => this.enqueue(n, p, o),
      updateJob: async (id, updates) => {
        await backend.atomic([{ type: 'update', jobId: id, updates }])
        Object.assign(job, updates)
      },
    })

    await this.middlewarePipeline.run('enqueue', ctx)

    this.eventBus.emit('job:enqueued', { jobId: job.id, queue: job.queue, name: job.name })
    return job.id
  }

  /**
   * Bulk enqueue jobs atomically via backend.
   */
  async enqueueBulk(items: Array<{ name: string; payload: unknown; opts?: EnqueueOpts }>): Promise<string[]> {
    const backend = this.getBackend()
    const jobs = items.map(item => createJob(item.name, item.payload, item.opts))
    const ids = await backend.enqueueBulk(jobs)
    for (const job of jobs) {
      this.eventBus.emit('job:enqueued', { jobId: job.id, queue: job.queue, name: job.name })
    }
    return ids
  }

  /**
   * Dequeue and process the next job from a queue.
   * Returns true if a job was processed, false if the queue was empty.
   */
  async processNext(queue: string): Promise<boolean> {
    const backend = this.getBackend()
    const dequeued = await backend.dequeue(queue, 1)

    if (dequeued.length === 0) {
      return false
    }

    const dequeuedJob = dequeued[0]! as DequeuedJob
    const job = dequeuedJob as Job
    const completionToken = dequeuedJob.completionToken

    const registered = this.handlers.get(job.name)
    if (!registered) {
      // No handler registered for this job name — nack with dead letter
      await backend.nack(job.id, {
        requeue: false,
        deadLetter: true,
        reason: `No handler registered for job "${job.name}"`,
      })
      this.eventBus.emit('job:failed', {
        jobId: job.id,
        queue: job.queue,
        name: job.name,
        error: `No handler registered for job "${job.name}"`,
      })
      return true
    }

    const ctx = createContext(job, 'process', {
      enqueue: (n, p, o) => this.enqueue(n, p, o),
      updateJob: async (id, updates) => {
        await backend.atomic([{ type: 'update', jobId: id, updates }])
        Object.assign(job, updates)
      },
    })

    this.eventBus.emit('job:started', { jobId: job.id, queue: job.queue, name: job.name })

    // Register the job handler as a finalize middleware so user/plugin middleware runs first
    const handlerMiddleware: Middleware = async (c, next) => {
      const result = await registered.handler(c)
      c.job.result = result
      await next()
    }

    try {
      // Run the process pipeline
      await this.middlewarePipeline.run('process', ctx)

      // Run the handler
      await handlerMiddleware(ctx, async () => {})

      // Check if middleware requested dead letter
      if (ctx.state['_deadLetter']) {
        await backend.nack(job.id, {
          requeue: false,
          deadLetter: true,
          reason: String(ctx.state['_deadLetter']),
        })
        this.eventBus.emit('job:dead', {
          jobId: job.id,
          queue: job.queue,
          name: job.name,
          reason: ctx.state['_deadLetter'],
        })
        return true
      }

      // Check if middleware requested requeue
      if (ctx.state['_requeue']) {
        const requeueOpts = ctx.state['_requeue'] as { delay?: number; priority?: number }
        await backend.nack(job.id, {
          requeue: true,
          delay: requeueOpts.delay,
        })
        this.eventBus.emit('job:requeued', { jobId: job.id, queue: job.queue, name: job.name })
        return true
      }

      const resultJson = job.result !== undefined ? JSON.stringify(job.result) : undefined
      await backend.ack(job.id, completionToken, resultJson)
      this.eventBus.emit('job:completed', {
        jobId: job.id,
        queue: job.queue,
        name: job.name,
        result: job.result,
      })
      return true
    } catch (err) {
      // Failure path
      const error = err instanceof Error ? err : new Error(String(err))

      // Classify error
      const category = this.classifyError(error)
      const retryable = category !== 'fatal' && category !== 'validation'

      const jobError = {
        message: error.message,
        stack: error.stack,
        category,
        retryable,
      }

      // Check retries
      if (retryable && job.attempt < job.maxRetries) {
        const delay = this.calculateBackoff(job)

        if (delay > 0 && delay <= 1000) {
          // Short delay: wait in-process then requeue immediately.
          // This avoids needing the scheduler plugin for quick retries.
          await new Promise(r => setTimeout(r, delay))
          await backend.nack(job.id, { requeue: true, delay: 0 })
        } else if (delay > 1000) {
          // Long delay: use scheduled set. Warn if no scheduler.
          await backend.nack(job.id, { requeue: true, delay })
          // Try to promote immediately from scheduled set (self-heal)
          try { await backend.pollScheduled(new Date(Date.now() + delay + 100), 1) } catch {}
        } else {
          await backend.nack(job.id, { requeue: true, delay: 0 })
        }

        this.eventBus.emit('job:retry', {
          jobId: job.id,
          queue: job.queue,
          name: job.name,
          attempt: job.attempt,
          delay,
          error: error.message,
        })
      } else {
        // Exhausted retries or non-retryable — dead letter
        await backend.nack(job.id, {
          requeue: false,
          deadLetter: true,
          reason: error.message,
        })

        this.eventBus.emit('job:dead', {
          jobId: job.id,
          queue: job.queue,
          name: job.name,
          error: jobError,
          attempt: job.attempt,
        })
      }

      this.eventBus.emit('job:failed', {
        jobId: job.id,
        queue: job.queue,
        name: job.name,
        error: error.message,
      })

      return true
    }
  }

  /**
   * Start a worker pool for the given queue. Jobs are automatically dequeued
   * and processed using registered handlers.
   * Uses blocking reads (BRPOPLPUSH) for Redis, polling for other backends.
   */
  startWorker(queue: string, opts: WorkerOpts = {}): void {
    if (this.workers.has(queue)) {
      throw new PsyQueueError('WORKER_EXISTS', `Worker already running for queue "${queue}"`)
    }

    const backend = this.getBackend()

    const pool = new WorkerPool(
      queue,
      backend,
      this.middlewarePipeline,
      this.handlers,
      this.eventBus,
      opts,
      {
        enqueue: (name, payload, o) => this.enqueue(name, payload, o),
        classifyError: (error) => this.classifyError(error),
        calculateBackoff: (job) => this.calculateBackoff(job),
      },
    )

    this.workers.set(queue, pool)
    pool.start()
  }

  /**
   * Stop all worker pools.
   */
  async stopWorkers(): Promise<void> {
    const stops = [...this.workers.values()].map(w => w.stop())
    await Promise.allSettled(stops)
    this.workers.clear()
  }

  /**
   * Get an exposed API by namespace.
   */
  getExposed(namespace: string): Record<string, unknown> | undefined {
    return this.exposed.get(namespace)
  }

  /**
   * Get the backend adapter. Throws if none registered.
   */
  private getBackend(): BackendAdapter {
    if (!this.backend) {
      throw new PsyQueueError('NO_BACKEND', 'No backend registered. Register a backend plugin first.')
    }
    return this.backend
  }

  /**
   * Classify an error to determine retry behavior.
   */
  private classifyError(error: Error): 'transient' | 'validation' | 'rate-limit' | 'fatal' | 'unknown' {
    // Check for specific error types
    if ('category' in error && typeof (error as Record<string, unknown>).category === 'string') {
      return (error as Record<string, unknown>).category as 'transient' | 'validation' | 'rate-limit' | 'fatal' | 'unknown'
    }

    const msg = error.message.toLowerCase()
    if (msg.includes('timeout') || msg.includes('econnrefused') || msg.includes('econnreset')) {
      return 'transient'
    }
    if (msg.includes('validation') || msg.includes('invalid')) {
      return 'validation'
    }
    if (msg.includes('rate limit')) {
      return 'rate-limit'
    }

    return 'unknown'
  }

  /**
   * Calculate backoff delay for a failed job.
   */
  calculateBackoff(job: Job): number {
    const base = job.backoffBase ?? 1000
    const cap = job.backoffCap ?? 300_000
    const jitter = job.backoffJitter ?? true
    const attempt = job.attempt

    let delay: number

    if (typeof job.backoff === 'function') {
      delay = job.backoff(attempt)
    } else {
      switch (job.backoff) {
        case 'fixed':
          delay = base
          break
        case 'linear':
          delay = base * attempt
          break
        case 'exponential':
        default:
          delay = Math.min(base * Math.pow(2, attempt - 1), cap)
          break
      }
    }

    // Apply cap
    delay = Math.min(delay, cap)

    // Apply jitter (+-25%)
    if (jitter) {
      const jitterRange = delay * 0.25
      delay = delay - jitterRange + Math.random() * jitterRange * 2
    }

    return Math.round(delay)
  }
}
