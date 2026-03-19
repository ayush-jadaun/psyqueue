// === Job Types ===

export type JobStatus = 'pending' | 'scheduled' | 'active' | 'completed' | 'failed' | 'dead'

export type BackoffStrategy = 'fixed' | 'exponential' | 'linear'
export type BackoffFunction = (attempt: number, error?: Error) => number

export interface JobError {
  message: string
  code?: string
  stack?: string
  category?: 'transient' | 'validation' | 'rate-limit' | 'fatal' | 'unknown'
  retryable: boolean
}

export interface Job {
  id: string
  queue: string
  name: string
  payload: unknown

  schemaVersion?: number

  priority: number
  deadline?: Date
  runAt?: Date
  cron?: string

  tenantId?: string

  idempotencyKey?: string
  maxRetries: number
  attempt: number
  backoff: BackoffStrategy | BackoffFunction
  backoffBase?: number
  backoffCap?: number
  backoffJitter?: boolean
  timeout: number

  workflowId?: string
  stepId?: string
  parentJobId?: string

  traceId?: string
  spanId?: string

  status: JobStatus
  result?: unknown
  error?: JobError

  createdAt: Date
  startedAt?: Date
  completedAt?: Date

  meta: Record<string, unknown>
}

// === Enqueue Options ===

export interface EnqueueOpts {
  queue?: string
  tenantId?: string
  priority?: number
  deadline?: Date
  runAt?: Date
  cron?: string
  idempotencyKey?: string
  maxRetries?: number
  timeout?: number
  backoff?: BackoffStrategy | BackoffFunction
  backoffBase?: number
  backoffCap?: number
  backoffJitter?: boolean
  meta?: Record<string, unknown>
}

// === Backend Types ===

export interface DequeuedJob extends Job {
  completionToken: string
}

export interface AckResult {
  alreadyCompleted: boolean
}

export interface NackOpts {
  requeue?: boolean
  delay?: number
  deadLetter?: boolean
  reason?: string
}

export interface JobFilter {
  queue?: string
  status?: JobStatus | JobStatus[]
  tenantId?: string
  name?: string
  from?: Date
  to?: Date
  limit?: number
  offset?: number
  sortBy?: 'createdAt' | 'priority' | 'runAt'
  sortOrder?: 'asc' | 'desc'
}

export interface PaginatedResult<T> {
  data: T[]
  total: number
  limit: number
  offset: number
  hasMore: boolean
}

export type AtomicOp =
  | { type: 'enqueue'; job: Job }
  | { type: 'ack'; jobId: string }
  | { type: 'nack'; jobId: string; opts?: NackOpts }
  | { type: 'update'; jobId: string; updates: Partial<Job> }

export interface BackendAdapter {
  name: string
  type: string

  connect(): Promise<void>
  disconnect(): Promise<void>
  healthCheck(): Promise<boolean>

  enqueue(job: Job): Promise<string>
  enqueueBulk(jobs: Job[]): Promise<string[]>
  dequeue(queue: string, count: number): Promise<DequeuedJob[]>
  ack(jobId: string, completionToken?: string): Promise<AckResult>
  nack(jobId: string, opts?: NackOpts): Promise<void>

  getJob(jobId: string): Promise<Job | null>
  listJobs(filter: JobFilter): Promise<PaginatedResult<Job>>

  scheduleAt(job: Job, runAt: Date): Promise<string>
  pollScheduled(now: Date, limit: number): Promise<Job[]>

  acquireLock(key: string, ttlMs: number): Promise<boolean>
  releaseLock(key: string): Promise<void>

  atomic(ops: AtomicOp[]): Promise<void>

  /** Whether this backend supports blocking dequeue */
  supportsBlocking?: boolean

  /**
   * Block until a job is available or timeout expires.
   * Returns empty array on timeout. Uses BZPOPMIN (Redis) or LISTEN/NOTIFY (Postgres).
   * IMPORTANT: This blocks the connection — caller must use a dedicated connection.
   */
  blockingDequeue?(queue: string, timeoutMs: number): Promise<DequeuedJob[]>

  /**
   * Non-blocking batch pop — grab up to `count` jobs immediately.
   * Called after blockingDequeue unblocks to grab more jobs in the same cycle.
   */
  batchDequeue?(queue: string, count: number): Promise<DequeuedJob[]>

  /**
   * Acknowledge multiple jobs in a single round-trip (pipeline).
   */
  ackBatch?(items: Array<{ jobId: string; completionToken?: string }>): Promise<AckResult[]>

  /**
   * Ack current job AND dequeue the next job in one atomic Lua call (3→2 calls/job).
   * Returns ack result for current job and optionally the next dequeued job.
   */
  ackAndFetch?(jobId: string, completionToken: string | undefined, queue: string): Promise<{ ackResult: AckResult; nextJob: DequeuedJob | null }>
}

// === Event Types ===

export interface PsyEvent<T = unknown> {
  type: string
  timestamp: Date
  source: string
  data: T
  traceId?: string
}

// === Middleware Types ===

export type MiddlewarePhase = 'guard' | 'validate' | 'transform' | 'observe' | 'execute' | 'finalize'

export type LifecycleEvent = 'enqueue' | 'dequeue' | 'process' | 'complete' | 'fail' | 'retry' | 'schedule'

export interface JobContext {
  job: Job
  event: LifecycleEvent
  tenant?: { id: string; tier: string; [key: string]: unknown }
  trace?: { traceId: string; spanId: string }
  workflow?: { workflowId: string; stepId: string; results: Record<string, unknown> }
  results?: Record<string, unknown>
  state: Record<string, unknown>
  requeue(opts?: { delay?: number; priority?: number }): void
  deadLetter(reason: string): void
  breaker(name: string, fn: () => Promise<unknown>): Promise<unknown>
  updateJob(updates: Partial<Job>): Promise<void>
  enqueue(name: string, payload: unknown, opts?: EnqueueOpts): Promise<string>
  log: Logger
}

export type Middleware = (ctx: JobContext, next: () => Promise<void>) => Promise<void>

export interface MiddlewareEntry {
  phase: MiddlewarePhase
  fn: Middleware
  pluginName: string
}

// === Plugin Types ===

export interface Kernel {
  events: EventBusInterface
  pipeline(event: LifecycleEvent, fn: Middleware, opts?: { phase?: MiddlewarePhase }): void
  getBackend(): BackendAdapter
  expose(namespace: string, api: Record<string, unknown>): void
  getExposed(namespace: string): Record<string, unknown> | undefined
}

export interface PsyPlugin {
  name: string
  version: string
  provides?: string | string[]
  depends?: string[]
  init(kernel: Kernel): void
  start?(): Promise<void>
  stop?(): Promise<void>
  destroy?(): Promise<void>
}

// === Logger ===

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void
  info(msg: string, data?: Record<string, unknown>): void
  warn(msg: string, data?: Record<string, unknown>): void
  error(msg: string, data?: Record<string, unknown>): void
}

// === Event Bus Interface ===

export type EventHandler<T = unknown> = (event: PsyEvent<T>) => void | Promise<void>

export interface EventBusInterface {
  on(event: string, handler: EventHandler): void
  off(event: string, handler: EventHandler): void
  emit(event: string, data: unknown, source?: string): void
}

// === Handler Types ===

export interface HandlerOpts {
  concurrency?: number
  timeout?: number
  queue?: string
}

export type JobHandler = (ctx: JobContext) => Promise<unknown>

// === Worker Types ===

export interface WorkerOpts {
  /** Number of parallel worker loops (default: 1) */
  concurrency?: number
  /** Milliseconds to wait in blocking dequeue before retrying (default: 5000) */
  blockTimeout?: number
  /** Max jobs to grab per cycle after unblock (default: 1) */
  batchSize?: number
  /** Milliseconds between polls for non-blocking backends (default: 50) */
  pollInterval?: number
}
