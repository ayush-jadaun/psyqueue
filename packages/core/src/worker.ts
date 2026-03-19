import type {
  BackendAdapter,
  DequeuedJob,
  Job,
  JobHandler,
  HandlerOpts,
  EventBusInterface,
  Middleware,
  WorkerOpts,
  EnqueueOpts,
} from './types.js'
import type { MiddlewarePipeline } from './middleware-pipeline.js'
import { createContext } from './context.js'

interface RegisteredHandler {
  handler: JobHandler
  opts: HandlerOpts
}

interface WorkerInternals {
  enqueue: (name: string, payload: unknown, opts?: EnqueueOpts) => Promise<string>
  classifyError: (error: Error) => 'transient' | 'validation' | 'rate-limit' | 'fatal' | 'unknown'
  calculateBackoff: (job: Job) => number
}

/**
 * Single-loop semaphore worker architecture.
 *
 * ONE dequeue loop with a semaphore controlling concurrency.
 * - 1 blocking connection (BZPOPMIN) + 1 command connection = 2 Redis connections total
 * - Semaphore limits parallelism (concurrency:10 = up to 10 handlers running)
 * - Non-blocking batch grab with local buffer reduces Redis round-trips
 * - BZPOPMIN only used when queue is empty (efficient blocking wait)
 * - Non-blocking dispatch: loop doesn't wait for handlers, keeps pulling
 */
export class WorkerPool {
  private running = false
  private stopping = false
  private loopPromise: Promise<void> | null = null
  private activeCount = 0
  private pendingResolves: Array<() => void> = []
  /** Local buffer of pre-fetched jobs ready for dispatch */
  private jobBuffer: DequeuedJob[] = []

  constructor(
    private queue: string,
    private backend: BackendAdapter,
    private pipeline: MiddlewarePipeline,
    private handlers: Map<string, RegisteredHandler>,
    private eventBus: EventBusInterface,
    private opts: WorkerOpts,
    private internals: WorkerInternals,
  ) {}

  start(): void {
    this.running = true
    this.stopping = false
    this.loopPromise = this.dequeueLoop()
  }

  async stop(): Promise<void> {
    this.stopping = true
    // Wake up any waitForCapacity that's blocking
    for (const resolve of this.pendingResolves) {
      resolve()
    }
    this.pendingResolves = []
    // Wait for dequeue loop to exit
    if (this.loopPromise) await this.loopPromise
    // Wait for all in-flight handlers to complete
    while (this.activeCount > 0) {
      await new Promise(r => setTimeout(r, 10))
    }
    this.running = false
    this.loopPromise = null
  }

  get isRunning(): boolean {
    return this.running
  }

  private get concurrency(): number {
    return this.opts.concurrency ?? 1
  }

  private get freeSlots(): number {
    return this.concurrency - this.activeCount
  }

  /** How many jobs to grab per Redis call (buffer + concurrency) */
  private get fetchSize(): number {
    // Grab a multiple of concurrency to reduce round-trips
    // batchSize controls this; defaults to 2x concurrency for throughput
    return this.opts.batchSize ?? Math.max(this.concurrency * 2, 10)
  }

  /**
   * Wait until at least 1 concurrency slot is free.
   * Returns immediately if slots are available.
   */
  private async waitForCapacity(): Promise<void> {
    if (this.freeSlots > 0) return
    return new Promise(resolve => {
      this.pendingResolves.push(resolve)
    })
  }

  /**
   * Release a concurrency slot after a handler completes.
   * Wakes up the dequeue loop if it was waiting for capacity.
   */
  private releaseSlot(): void {
    this.activeCount--
    const next = this.pendingResolves.shift()
    if (next) next()
  }

  /**
   * Dispatch jobs from the buffer up to available concurrency slots.
   * Returns number of jobs dispatched.
   */
  private dispatchFromBuffer(): number {
    let dispatched = 0
    while (this.jobBuffer.length > 0 && this.freeSlots > 0) {
      const job = this.jobBuffer.shift()!
      this.activeCount++
      this.processJob(job).finally(() => this.releaseSlot())
      dispatched++
    }
    return dispatched
  }

  /**
   * Single dequeue loop -- the heart of the architecture.
   *
   * Strategy for blocking backends:
   * 1. Dispatch any buffered jobs first (no Redis call needed)
   * 2. If buffer empty, try non-blocking batch grab (fast path)
   * 3. If queue empty, fall back to BZPOPMIN (blocking wait)
   * 4. After BZPOPMIN unblocks, batch-grab more to fill buffer
   *
   * Strategy for polling backends:
   * - Standard poll with sleep when queue is empty
   */
  private async dequeueLoop(): Promise<void> {
    let queueWasEmpty = false

    while (!this.stopping) {
      try {
        // First, dispatch any buffered jobs without touching Redis
        if (this.jobBuffer.length > 0) {
          await this.waitForCapacity()
          if (this.stopping) break
          this.dispatchFromBuffer()
          // If buffer still has jobs, loop again to dispatch more
          if (this.jobBuffer.length > 0) continue
        }

        // Buffer empty -- need to fetch from Redis
        // Wait until at least 1 slot is free before fetching
        await this.waitForCapacity()
        if (this.stopping) break

        let jobs: DequeuedJob[]

        if (this.backend.supportsBlocking && this.backend.blockingDequeue) {
          if (!queueWasEmpty && this.backend.batchDequeue) {
            // FAST PATH: non-blocking batch grab
            // Grab more than concurrency to build up buffer
            jobs = await this.backend.batchDequeue(this.queue, this.fetchSize)

            if (jobs.length === 0) {
              queueWasEmpty = true
              continue
            }
            queueWasEmpty = false
          } else {
            // BLOCKING PATH: queue was empty, wait with BZPOPMIN
            jobs = await this.backend.blockingDequeue(this.queue, this.opts.blockTimeout ?? 5000)

            if (jobs.length === 0) continue // timeout

            // Queue active again, grab more to fill buffer
            queueWasEmpty = false
            if (this.backend.batchDequeue) {
              const more = await this.backend.batchDequeue(this.queue, this.fetchSize - jobs.length)
              jobs.push(...more)
            }
          }
        } else {
          // POLL MODE for non-blocking backends (SQLite, etc.)
          const count = Math.max(1, this.freeSlots)
          jobs = await this.backend.dequeue(this.queue, count)
          if (jobs.length === 0) {
            if (this.stopping) break
            await new Promise(r => setTimeout(r, this.opts.pollInterval ?? 50))
            continue
          }
        }

        // Dispatch up to concurrency, buffer the rest
        for (const job of jobs) {
          if (this.freeSlots > 0) {
            this.activeCount++
            this.processJob(job).finally(() => this.releaseSlot())
          } else {
            this.jobBuffer.push(job)
          }
        }
      } catch {
        if (!this.stopping) {
          await new Promise(r => setTimeout(r, 1000))
        }
      }
    }
  }

  private async processJob(dequeuedJob: DequeuedJob): Promise<void> {
    const job = dequeuedJob as Job
    const completionToken = dequeuedJob.completionToken
    const backend = this.backend

    const registered = this.handlers.get(job.name)
    if (!registered) {
      // No handler registered for this job name -- nack with dead letter
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
      return
    }

    const ctx = createContext(job, 'process', {
      enqueue: (n, p, o) => this.internals.enqueue(n, p, o),
      updateJob: async (id, updates) => {
        await backend.nack(id, {})
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
      await this.pipeline.run('process', ctx)

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
        return
      }

      // Check if middleware requested requeue
      if (ctx.state['_requeue']) {
        const requeueOpts = ctx.state['_requeue'] as { delay?: number; priority?: number }
        await backend.nack(job.id, {
          requeue: true,
          delay: requeueOpts.delay,
        })
        this.eventBus.emit('job:requeued', { jobId: job.id, queue: job.queue, name: job.name })
        return
      }

      // Success — use ackAndFetch when available to fuse ack + dequeue in one call
      if (backend.ackAndFetch) {
        const { nextJob } = await backend.ackAndFetch(job.id, completionToken, job.queue)
        if (nextJob) {
          this.jobBuffer.push(nextJob)
        }
      } else {
        await backend.ack(job.id, completionToken)
      }
      this.eventBus.emit('job:completed', {
        jobId: job.id,
        queue: job.queue,
        name: job.name,
        result: job.result,
      })
    } catch (err) {
      // Failure path
      const error = err instanceof Error ? err : new Error(String(err))

      // Classify error
      const category = this.internals.classifyError(error)
      const retryable = category !== 'fatal' && category !== 'validation'

      const jobError = {
        message: error.message,
        stack: error.stack,
        category,
        retryable,
      }

      // Check retries
      if (retryable && job.attempt < job.maxRetries) {
        const delay = this.internals.calculateBackoff(job)

        if (delay > 0 && delay <= 1000) {
          // Short delay: wait in-process then requeue immediately.
          // This avoids the scheduled→ready round-trip through the scheduler,
          // which adds poll interval latency. For delays > 1s, use the
          // scheduled set so we don't hold memory/block the worker.
          await new Promise(r => setTimeout(r, delay))
          await backend.nack(job.id, { requeue: true, delay: 0 })
        } else {
          await backend.nack(job.id, { requeue: true, delay })
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
        // Exhausted retries or non-retryable -- dead letter
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
    }
  }
}
