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

export class WorkerPool {
  private running = false
  private stopping = false
  private workerPromises: Promise<void>[] = []

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
    const concurrency = this.opts.concurrency ?? 1
    for (let i = 0; i < concurrency; i++) {
      this.workerPromises.push(this.workerLoop(i))
    }
  }

  async stop(): Promise<void> {
    this.stopping = true
    await Promise.allSettled(this.workerPromises)
    this.running = false
    this.workerPromises = []
  }

  get isRunning(): boolean {
    return this.running
  }

  private async workerLoop(_workerId: number): Promise<void> {
    while (!this.stopping) {
      try {
        let jobs: DequeuedJob[]

        if (this.backend.supportsBlocking && this.backend.blockingDequeue) {
          // Blocking mode -- waits efficiently for jobs
          jobs = await this.backend.blockingDequeue(this.queue, this.opts.blockTimeout ?? 5000)

          // After unblocking, grab more if available (batch)
          if (jobs.length > 0 && this.backend.batchDequeue && (this.opts.batchSize ?? 1) > 1) {
            const remaining = (this.opts.batchSize ?? 1) - jobs.length
            if (remaining > 0) {
              const more = await this.backend.batchDequeue(this.queue, remaining)
              jobs.push(...more)
            }
          }
        } else {
          // Poll mode for non-blocking backends (SQLite)
          jobs = await this.backend.dequeue(this.queue, this.opts.batchSize ?? 1)
          if (jobs.length === 0) {
            if (this.stopping) break
            await new Promise(r => setTimeout(r, this.opts.pollInterval ?? 50))
            continue
          }
        }

        if (jobs.length === 0) continue // timeout on blocking dequeue

        // Process jobs -- if batch, process in parallel
        if (jobs.length === 1) {
          await this.processJob(jobs[0]!)
        } else {
          await Promise.allSettled(jobs.map(job => this.processJob(job)))
        }
      } catch (err) {
        // Worker loop error -- log and continue with backoff
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

      // Success
      await backend.ack(job.id, completionToken)
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

        await backend.nack(job.id, {
          requeue: true,
          delay,
        })

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
