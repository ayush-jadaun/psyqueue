import type { BackendAdapter, DequeuedJob, WorkerOpts } from './types.js'
import { runJob, type RunnerDeps } from './job-runner.js'

/**
 * Single-loop semaphore worker architecture.
 *
 * ONE dequeue loop with a semaphore controlling concurrency.
 * - 1 blocking connection (BLMOVE) + 1 command connection = 2 Redis connections total
 * - Semaphore limits parallelism (concurrency:10 = up to 10 handlers running)
 * - Non-blocking batch grab with local buffer reduces Redis round-trips
 * - BLMOVE only used when queue is empty (efficient blocking wait)
 * - One heartbeat timer renews leases on every held job, so stale recovery
 *   only reclaims jobs whose worker died (not long-running ones)
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
  /** Jobs this worker holds (in flight or buffered): jobId -> completion token */
  private held = new Map<string, string>()
  private heartbeat: ReturnType<typeof setInterval> | null = null

  private readonly backend: BackendAdapter

  constructor(
    private queue: string,
    private deps: RunnerDeps,
    private opts: WorkerOpts,
  ) {
    this.backend = deps.backend
  }

  private get eventBus() {
    return this.deps.eventBus
  }

  start(): void {
    this.running = true
    this.stopping = false
    if (this.backend.extendLeases) {
      // ponytail: timer runs on the event loop, so a handler that blocks it with
      // sync CPU work for > leaseMs can still be reclaimed; raise leaseMs for those.
      this.heartbeat = setInterval(() => { void this.renewLeases() }, this.leaseMs / 4)
      this.heartbeat.unref?.()
    }
    this.loopPromise = this.dequeueLoop()
  }

  private get leaseMs(): number {
    return this.opts.leaseMs ?? 60_000
  }

  private hold(job: DequeuedJob): void {
    if (job.completionToken) this.held.set(job.id, job.completionToken)
  }

  private async renewLeases(): Promise<void> {
    if (this.held.size === 0 || !this.backend.extendLeases) return
    const leases = [...this.held].map(([jobId, token]) => ({ jobId, token }))
    try {
      await this.backend.extendLeases(this.queue, leases)
    } catch {
      // Best-effort: a missed beat is fine, the lease survives 3 more
    }
  }

  /** Run a job in a concurrency slot; releases the slot and lease when done. */
  private run(job: DequeuedJob): void {
    this.activeCount++
    this.processJob(job).catch((err: unknown) => {
      // Backend failure while acking/nacking. Never let it become an unhandled
      // rejection (that kills the process); the lease reclaims the job later.
      this.eventBus.emit('worker:error', {
        queue: this.queue,
        jobId: job.id,
        error: err instanceof Error ? err.message : String(err),
      })
    }).finally(() => {
      this.held.delete(job.id)
      this.releaseSlot()
    })
  }

  async stop(): Promise<void> {
    this.stopping = true
    // Wake up any waitForCapacity that's blocking
    for (const resolve of this.pendingResolves) {
      resolve()
    }
    this.pendingResolves = []
    // Don't wait out a blocking dequeue's timeout
    this.backend.interruptBlocking?.()
    // Wait for dequeue loop to exit
    if (this.loopPromise) await this.loopPromise
    // Wait for all in-flight handlers to complete
    while (this.activeCount > 0) {
      await new Promise(r => setTimeout(r, 10))
    }
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = null
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
      this.run(this.jobBuffer.shift()!)
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
   * 3. If queue empty, fall back to BLMOVE (blocking wait)
   * 4. After BLMOVE unblocks, batch-grab more to fill buffer
   *
   * Strategy for polling backends:
   * - Standard poll with sleep when queue is empty
   */
  private async dequeueLoop(): Promise<void> {
    let queueWasEmpty = false
    let lastStaleCheck = Date.now()
    let lastScheduledPoll = Date.now()

    while (!this.stopping) {
      try {
        // Periodically poll scheduled set for due jobs (every 1 second)
        // This is a safety net — if no scheduler plugin is registered,
        // delayed retries still get promoted to the ready queue.
        if (Date.now() - lastScheduledPoll > 1000) {
          try {
            const due = await this.backend.pollScheduled(new Date(), 20)
            if (due.length > 0) {
              this.eventBus.emit('job:scheduled-promoted', { queue: this.queue, count: due.length })
            }
          } catch {
            // Best-effort — scheduler plugin handles this if registered
          }
          lastScheduledPoll = Date.now()
        }

        // Periodically reclaim jobs whose lease expired (their worker died)
        if (Date.now() - lastStaleCheck > this.leaseMs / 2) {
          if (this.backend.recoverStaleJobs) {
            try {
              const recovered = await this.backend.recoverStaleJobs(this.queue, this.leaseMs)
              if (recovered.length > 0) {
                this.eventBus.emit('job:recovered', { queue: this.queue, count: recovered.length, jobIds: recovered })
              }
            } catch {
              // Stale recovery is best-effort, don't crash the loop
            }
          }
          lastStaleCheck = Date.now()
        }

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
            // BLOCKING PATH: queue was empty, wait with BLMOVE
            jobs = await this.backend.blockingDequeue(this.queue, this.opts.blockTimeout ?? 5000)

            if (jobs.length === 0) {
              // Timeout. BLMOVE only watches the normal list, so retry the
              // non-blocking path, which also checks the priority set.
              // ponytail: priority jobs on an idle queue wait up to blockTimeout;
              // add a wake-up marker on priority enqueue if that latency matters.
              queueWasEmpty = false
              continue
            }

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
          this.hold(job)
          if (this.freeSlots > 0) {
            this.run(job)
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

  private async processJob(job: DequeuedJob): Promise<void> {
    const nextJob = await runJob(job, this.deps, { fetchNext: true })
    if (nextJob) {
      this.hold(nextJob)
      this.jobBuffer.push(nextJob)
    }
  }
}
