# API Reference

Complete API documentation for the `psyqueue` core package.

## PsyQueue Class

The main entry point. Creates a micro-kernel instance that coordinates plugins, middleware, and the backend.

### Constructor

```typescript
const q = new PsyQueue()
```

No arguments. Configure by registering plugins with `q.use()`.

### Static Methods

#### `PsyQueue.from(preset, overrides?)`

Create a PsyQueue instance from a named preset configuration.

```typescript
static from(
  preset: string | PresetConfig,
  overrides?: Partial<PresetConfig>,
): { queue: PsyQueue; config: PresetConfig }
```

**Parameters:**

| Name | Type | Description |
|------|------|-------------|
| `preset` | `string \| PresetConfig` | Preset name (`'lite'`, `'saas'`, `'enterprise'`) or a custom config object |
| `overrides` | `Partial<PresetConfig>` | Additional plugins to merge into the preset |

**Returns:** `{ queue: PsyQueue; config: PresetConfig }` -- The queue instance and the resolved config listing required plugin names. You still need to install and `.use()` the actual plugins.

```typescript
const { queue, config } = PsyQueue.from('lite')
// config.plugins = ['backend-sqlite', 'scheduler', 'crash-recovery']
```

**Available presets:**

| Preset | Plugins |
|--------|---------|
| `lite` | `backend-sqlite`, `scheduler`, `crash-recovery` |
| `saas` | `backend-redis`, `tenancy`, `workflows`, `saga`, `circuit-breaker`, `backpressure`, `dashboard`, `metrics` |
| `enterprise` | `backend-postgres`, `tenancy`, `workflows`, `saga`, `exactly-once`, `audit-log`, `otel-tracing`, `schema-versioning`, `circuit-breaker`, `backpressure`, `dashboard`, `metrics` |

### Instance Properties

#### `q.isRunning: boolean`

Returns `true` after `q.start()` completes and before `q.stop()` is called.

#### `q.events: EventBusInterface`

The public event bus. Use to subscribe to lifecycle events.

```typescript
q.events.on('job:completed', (event) => { /* ... */ })
q.events.off('job:completed', handler)
```

#### `q.deadLetter`

Dead letter queue management API.

```typescript
q.deadLetter: {
  list(filter?: JobFilter): Promise<PaginatedResult<Job>>
  replay(jobId: string): Promise<void>
  replayAll(filter?: JobFilter): Promise<number>
  purge(opts?: { queue?: string; before?: Date }): Promise<number>
}
```

**Methods:**

| Method | Description |
|--------|-------------|
| `list(filter?)` | List dead-lettered jobs. Supports filtering by queue, name, date range, pagination. |
| `replay(jobId)` | Requeue a specific dead-lettered job. Throws if job not found or not in `dead` status. |
| `replayAll(filter?)` | Requeue all matching dead-lettered jobs. Returns count of replayed jobs. |
| `purge(opts?)` | Permanently remove dead-lettered jobs. Returns count of purged jobs. |

### Instance Methods

#### `q.use(plugin): this`

Register a plugin. Returns `this` for chaining.

```typescript
q.use(sqlite({ path: ':memory:' }))
 .use(scheduler())
 .use(crashRecovery())
```

The plugin's `init()` method is called immediately during `use()`. Throws `DUPLICATE_PLUGIN` if a plugin with the same name is already registered.

#### `q.start(): Promise<void>`

Start the queue: connect the backend and start all plugins in dependency order.

Throws `NO_BACKEND` if no backend plugin has been registered.

```typescript
await q.start()
```

#### `q.stop(): Promise<void>`

Stop the queue: stop all plugins in reverse order, then disconnect the backend.

```typescript
await q.stop()
```

#### `q.enqueue(name, payload, opts?): Promise<string>`

Enqueue a job. Runs through the enqueue middleware pipeline, then persists via the backend.

```typescript
const jobId = await q.enqueue('email.send', {
  to: 'user@example.com',
  subject: 'Hello',
}, {
  priority: 5,
  maxRetries: 5,
  timeout: 15_000,
})
```

**Parameters:**

| Name | Type | Description |
|------|------|-------------|
| `name` | `string` | Job name. Also used as the default queue name. |
| `payload` | `unknown` | Arbitrary job data. |
| `opts` | `EnqueueOpts` | Optional settings (see below). |

**Returns:** `Promise<string>` -- The job ID (ULID).

#### `q.enqueueBulk(items): Promise<string[]>`

Bulk enqueue jobs atomically via the backend. Events are emitted for each job.

```typescript
const ids = await q.enqueueBulk([
  { name: 'email.send', payload: { to: 'a@b.com' } },
  { name: 'email.send', payload: { to: 'c@d.com' }, opts: { priority: 10 } },
])
```

**Parameters:**

| Name | Type | Description |
|------|------|-------------|
| `items` | `Array<{ name: string; payload: unknown; opts?: EnqueueOpts }>` | Jobs to enqueue. |

**Returns:** `Promise<string[]>` -- Array of job IDs.

Note: `enqueueBulk` bypasses the enqueue middleware pipeline and goes directly to the backend. Use `enqueue` if you need middleware processing (rate limiting, deduplication, etc.).

#### `q.processNext(queue): Promise<boolean>`

Dequeue and process the next job from a queue.

```typescript
const hadWork = await q.processNext('email.send')
```

**Parameters:**

| Name | Type | Description |
|------|------|-------------|
| `queue` | `string` | Queue name to dequeue from. |

**Returns:** `Promise<boolean>` -- `true` if a job was processed (success or failure), `false` if the queue was empty.

Processing flow:
1. Dequeues one job from the backend.
2. Looks up the registered handler by job name.
3. Runs the `process` middleware pipeline.
4. Runs the handler.
5. On success: acks the job, emits `job:completed`.
6. On failure: classifies the error, retries or dead-letters, emits `job:failed`.

#### `q.handle(name, handler, opts?): void`

Register a job handler.

```typescript
q.handle('email.send', async (ctx) => {
  const { to, subject } = ctx.job.payload as any
  await sendEmail(to, subject)
  return { sent: true }
}, {
  concurrency: 5,
  timeout: 30_000,
})
```

**Parameters:**

| Name | Type | Description |
|------|------|-------------|
| `name` | `string` | Job name to handle. |
| `handler` | `JobHandler` | Async function receiving `JobContext`. Return value becomes `job.result`. |
| `opts` | `HandlerOpts` | Optional handler settings. |

#### `q.pipeline(event, fn, opts?): void`

Register user middleware for a lifecycle event.

```typescript
q.pipeline('process', async (ctx, next) => {
  console.log(`Processing ${ctx.job.name}`)
  await next()
}, { phase: 'observe' })
```

**Parameters:**

| Name | Type | Description |
|------|------|-------------|
| `event` | `LifecycleEvent` | One of: `'enqueue'`, `'dequeue'`, `'process'`, `'complete'`, `'fail'`, `'retry'`, `'schedule'` |
| `fn` | `Middleware` | `(ctx: JobContext, next: () => Promise<void>) => Promise<void>` |
| `opts.phase` | `MiddlewarePhase` | One of: `'guard'`, `'validate'`, `'transform'`, `'observe'`, `'execute'`, `'finalize'`. Default: `'execute'`. |

#### `q.getExposed(namespace): Record<string, unknown> | undefined`

Get an API exposed by a plugin.

```typescript
const workflowsApi = q.getExposed('workflows')
```

---

## Types

### Job

The complete job object stored in the backend.

```typescript
interface Job {
  id: string              // ULID, auto-generated
  queue: string           // Queue name (defaults to job name)
  name: string            // Job name (matches handler registration)
  payload: unknown        // Arbitrary data

  schemaVersion?: number  // For schema-versioning plugin

  priority: number        // Higher = dequeued first. Default: 0
  deadline?: Date         // Optional deadline for priority boosting
  runAt?: Date            // Future execution time (creates scheduled job)
  cron?: string           // Cron expression for recurring jobs

  tenantId?: string       // Tenant identifier for multi-tenancy

  idempotencyKey?: string // For exactly-once deduplication
  maxRetries: number      // Max retry attempts. Default: 3
  attempt: number         // Current attempt number (starts at 1)
  backoff: BackoffStrategy | BackoffFunction  // Default: 'exponential'
  backoffBase?: number    // Base delay in ms. Default: 1000
  backoffCap?: number     // Max delay in ms. Default: 300000
  backoffJitter?: boolean // +/- 25% randomization. Default: true
  timeout: number         // Handler timeout in ms. Default: 30000

  workflowId?: string     // Set by workflows plugin
  stepId?: string         // Set by workflows plugin
  parentJobId?: string    // Set by workflows plugin

  traceId?: string        // Set by OTel tracing plugin
  spanId?: string         // Set by OTel tracing plugin

  status: JobStatus       // Current status
  result?: unknown        // Handler return value (on completion)
  error?: JobError        // Error details (on failure)

  createdAt: Date
  startedAt?: Date
  completedAt?: Date

  meta: Record<string, unknown>  // Arbitrary metadata
}
```

### JobStatus

```typescript
type JobStatus = 'pending' | 'scheduled' | 'active' | 'completed' | 'failed' | 'dead'
```

### EnqueueOpts

Options for `q.enqueue()`.

```typescript
interface EnqueueOpts {
  queue?: string            // Override queue name (default: job name)
  tenantId?: string         // Tenant ID for multi-tenancy
  priority?: number         // Default: 0
  deadline?: Date           // Deadline for priority boosting
  runAt?: Date              // Schedule for future execution
  cron?: string             // Cron expression for recurring jobs
  idempotencyKey?: string   // Deduplication key
  maxRetries?: number       // Default: 3
  timeout?: number          // Default: 30000 (30s)
  backoff?: BackoffStrategy | BackoffFunction  // Default: 'exponential'
  backoffBase?: number      // Default: 1000 (1s)
  backoffCap?: number       // Default: 300000 (5min)
  backoffJitter?: boolean   // Default: true
  meta?: Record<string, unknown>
}
```

### HandlerOpts

```typescript
interface HandlerOpts {
  concurrency?: number  // Max concurrent executions
  timeout?: number      // Handler timeout in ms
  queue?: string        // Override queue name
}
```

### BackoffStrategy

```typescript
type BackoffStrategy = 'fixed' | 'exponential' | 'linear'
type BackoffFunction = (attempt: number, error?: Error) => number
```

| Strategy | Formula | Example (base=1000) |
|----------|---------|---------------------|
| `fixed` | `base` | 1s, 1s, 1s, 1s |
| `linear` | `base * attempt` | 1s, 2s, 3s, 4s |
| `exponential` | `base * 2^(attempt-1)` | 1s, 2s, 4s, 8s |

All strategies respect `backoffCap` and apply `+/- 25%` jitter when `backoffJitter` is true.

### JobContext

Passed to handlers and middleware.

```typescript
interface JobContext {
  job: Job
  event: LifecycleEvent
  tenant?: { id: string; tier: string; [key: string]: unknown }
  trace?: { traceId: string; spanId: string }
  workflow?: { workflowId: string; stepId: string; results: Record<string, unknown> }
  results?: Record<string, unknown>
  state: Record<string, unknown>
  log: Logger

  requeue(opts?: { delay?: number; priority?: number }): void
  deadLetter(reason: string): void
  breaker(name: string, fn: () => Promise<unknown>): Promise<unknown>
  updateJob(updates: Partial<Job>): Promise<void>
  enqueue(name: string, payload: unknown, opts?: EnqueueOpts): Promise<string>
}
```

### PsyPlugin

```typescript
interface PsyPlugin {
  name: string
  version: string
  provides?: string | string[]
  depends?: string[]
  init(kernel: Kernel): void
  start?(): Promise<void>
  stop?(): Promise<void>
  destroy?(): Promise<void>
}
```

### Kernel

The kernel interface provided to plugins during `init()`.

```typescript
interface Kernel {
  events: EventBusInterface
  pipeline(event: LifecycleEvent, fn: Middleware, opts?: { phase?: MiddlewarePhase }): void
  getBackend(): BackendAdapter
  expose(namespace: string, api: Record<string, unknown>): void
  getExposed(namespace: string): Record<string, unknown> | undefined
}
```

### BackendAdapter

```typescript
interface BackendAdapter {
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
}
```

### EventBusInterface

```typescript
interface EventBusInterface {
  on(event: string, handler: EventHandler): void
  off(event: string, handler: EventHandler): void
  emit(event: string, data: unknown, source?: string): void
}

type EventHandler<T = unknown> = (event: PsyEvent<T>) => void | Promise<void>
```

### PsyEvent

```typescript
interface PsyEvent<T = unknown> {
  type: string        // Event name (e.g., 'job:completed')
  timestamp: Date
  source: string      // 'kernel', plugin name, etc.
  data: T
  traceId?: string
}
```

### JobFilter

```typescript
interface JobFilter {
  queue?: string
  status?: JobStatus | JobStatus[]
  tenantId?: string
  name?: string
  from?: Date
  to?: Date
  limit?: number       // Default: backend-specific
  offset?: number      // Default: 0
  sortBy?: 'createdAt' | 'priority' | 'runAt'
  sortOrder?: 'asc' | 'desc'
}
```

### PaginatedResult

```typescript
interface PaginatedResult<T> {
  data: T[]
  total: number
  limit: number
  offset: number
  hasMore: boolean
}
```

### NackOpts

```typescript
interface NackOpts {
  requeue?: boolean      // Requeue the job for retry
  delay?: number         // Delay before requeue (ms)
  deadLetter?: boolean   // Move to dead letter queue
  reason?: string        // Reason for nack
}
```

### JobError

```typescript
interface JobError {
  message: string
  code?: string
  stack?: string
  category?: 'transient' | 'validation' | 'rate-limit' | 'fatal' | 'unknown'
  retryable: boolean
}
```

### MiddlewarePhase

```typescript
type MiddlewarePhase = 'guard' | 'validate' | 'transform' | 'observe' | 'execute' | 'finalize'
```

### LifecycleEvent

```typescript
type LifecycleEvent = 'enqueue' | 'dequeue' | 'process' | 'complete' | 'fail' | 'retry' | 'schedule'
```

### Logger

```typescript
interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void
  info(msg: string, data?: Record<string, unknown>): void
  warn(msg: string, data?: Record<string, unknown>): void
  error(msg: string, data?: Record<string, unknown>): void
}
```

---

## Error Classes

All errors extend `PsyQueueError` which has a `code` property.

| Error | Code | When |
|-------|------|------|
| `PsyQueueError` | varies | Base error class |
| `PluginError` | `PLUGIN_ERROR` | Plugin-specific error |
| `DependencyError` | `MISSING_DEPENDENCY` | Plugin requires a missing dependency |
| `CircularDependencyError` | `CIRCULAR_DEPENDENCY` | Plugin dependency cycle detected |
| `RateLimitError` | `RATE_LIMIT_EXCEEDED` | Tenant exceeded rate limit |
| `DuplicateJobError` | `DUPLICATE_JOB` | Job with same idempotency key exists |
| `SchemaError` | `SCHEMA_MISMATCH` | Payload does not match expected schema |

```typescript
import { PsyQueueError, RateLimitError } from 'psyqueue'

try {
  await q.enqueue('job', payload)
} catch (err) {
  if (err instanceof RateLimitError) {
    console.log(`Rate limited. Retry after ${err.retryAfter}ms`)
  }
}
```

---

## Exported Utilities

### `createJob(name, payload, opts?): Job`

Create a Job object with defaults applied. Used internally by `q.enqueue()`.

### `generateId(): string`

Generate a ULID string. Used internally for job IDs.

### `createContext(job, event, internals): JobContext`

Create a JobContext for middleware execution. Used internally.

### `EventBus`

The event bus class. Instantiated internally by the kernel.

### `PluginRegistry`

The plugin registry class. Instantiated internally by the kernel.

### `MiddlewarePipeline`

The middleware pipeline class. Instantiated internally by the kernel.

### `presets`

The presets configuration object:

```typescript
import { presets } from 'psyqueue'

console.log(presets.lite.plugins)
// ['backend-sqlite', 'scheduler', 'crash-recovery']
```
