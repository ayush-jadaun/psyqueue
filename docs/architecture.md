# Architecture

PsyQueue follows a **micro-kernel** architecture. The core kernel is ~500 lines of TypeScript and provides four services: a plugin registry, an event bus, a middleware pipeline, and a backend adapter abstraction. All features are delivered through plugins.

## Micro-Kernel Design

```
  User Code
     |
     v
+-----------+    +---------+    +-----------+    +----------+
| PsyQueue  |--->| Plugin  |--->| Middleware |--->| Backend  |
| (Kernel)  |    | Registry|    | Pipeline  |    | Adapter  |
+-----------+    +---------+    +-----------+    +----------+
     |                                                |
     v                                                v
+-----------+                                   +---------+
| Event Bus |                                   | SQLite  |
| (pub/sub) |                                   | Redis   |
+-----------+                                   | Postgres|
                                                +---------+
```

The kernel's responsibilities:
1. Register and manage plugins (with dependency resolution)
2. Route jobs through the middleware pipeline
3. Delegate storage to whichever backend plugin is installed
4. Emit events so plugins can react to lifecycle transitions

The kernel does NOT contain business logic for retries, scheduling, rate limiting, or workflows. All of that lives in plugins.

## Plugin System

### Plugin Interface

Every plugin implements the `PsyPlugin` interface:

```typescript
interface PsyPlugin {
  name: string          // Unique plugin name
  version: string       // Semver version
  provides?: string | string[]  // Capabilities this plugin provides
  depends?: string[]    // Capabilities this plugin requires
  init(kernel: Kernel): void    // Called on q.use() -- register middleware and events
  start?(): Promise<void>       // Called on q.start() -- connect, start timers
  stop?(): Promise<void>        // Called on q.stop() -- disconnect, stop timers
  destroy?(): Promise<void>     // Called after stop -- final cleanup
}
```

### Lifecycle

1. **Registration** (`q.use(plugin)`) -- The plugin's `init()` method is called immediately. This is where plugins register middleware and event listeners.

2. **Start** (`q.start()`) -- The plugin registry resolves a topological start order based on dependency declarations. Plugins are started in order. Backend plugins connect first.

3. **Stop** (`q.stop()`) -- Plugins are stopped in reverse order. The `stop()` method runs first (stop timers, flush buffers), then `destroy()` runs (release resources).

### Dependency Resolution

Plugins declare their dependencies via `depends` and `provides`:

```typescript
// A backend plugin
{
  name: 'backend-redis',
  provides: 'backend',
  // ...
}

// A plugin that needs a backend
{
  name: 'scheduler',
  depends: ['backend'],
  // ...
}
```

The registry uses Kahn's algorithm (topological sort) to determine start order. If a dependency is missing, a `DependencyError` is thrown with an actionable message. Circular dependencies are detected and reported.

### Exposing APIs

Plugins can expose APIs to other plugins or to user code:

```typescript
// In the plugin's init():
kernel.expose('workflows', {
  registerWorkflow: (def) => engine.registerDefinition(def),
  getEngine: () => engine,
  list: () => engine.store.list(),
  cancel: (id) => engine.cancel(id),
})

// In user code:
const workflowsApi = q.getExposed('workflows')
```

The special namespace `'backend'` is reserved for backend adapters. When a plugin exposes this namespace, the kernel uses it as the storage layer.

## Middleware Pipeline

The pipeline is the central mechanism for job processing. Every lifecycle event (enqueue, dequeue, process, complete, fail, retry, schedule) runs through a chain of middleware functions.

### Phases

Middleware is organized into 6 ordered phases:

| Phase | Order | Purpose | Example |
|-------|-------|---------|---------|
| `guard` | 1 | Block/allow execution | Rate limiting, circuit breakers |
| `validate` | 2 | Validate job data | Payload schema validation |
| `transform` | 3 | Modify job before execution | Workflow interception, schema migration |
| `observe` | 4 | Side-effects without modification | Tracing spans, metrics recording |
| `execute` | 5 | Core business logic | Backend persistence, job handler |
| `finalize` | 6 | Post-execution cleanup | Audit logging, WAL entries |

Within each phase, middleware runs in registration order.

### Middleware Signature

```typescript
type Middleware = (ctx: JobContext, next: () => Promise<void>) => Promise<void>
```

Middleware MUST call `next()` to pass control to the next middleware in the chain. Skipping `next()` short-circuits the pipeline (used for interception, e.g., rate limiting).

### Registering Middleware

**As a plugin:**

```typescript
kernel.pipeline('enqueue', async (ctx, next) => {
  // Guard: reject if rate limited
  if (isRateLimited(ctx.job.tenantId)) {
    throw new RateLimitError(ctx.job.tenantId, 60)
  }
  await next()
}, { phase: 'guard' })
```

**As user code:**

```typescript
q.pipeline('process', async (ctx, next) => {
  console.log('Before processing:', ctx.job.name)
  await next()
  console.log('After processing:', ctx.job.name)
}, { phase: 'observe' })
```

### Short-Circuiting

Middleware can prevent downstream execution by not calling `next()`:

```typescript
kernel.pipeline('enqueue', async (ctx, next) => {
  if (engine.hasDefinition(ctx.job.name)) {
    // Start a workflow instead of a normal enqueue
    const id = await engine.startWorkflow(ctx.job.name, ctx.job.payload)
    ctx.job.id = id
    return // Don't call next() -- intercepted
  }
  await next()
}, { phase: 'transform' })
```

### Context Actions

Within middleware, you can signal the kernel to requeue or dead-letter a job:

```typescript
// Requeue with optional delay
ctx.requeue({ delay: 5000 })

// Send to dead letter queue
ctx.deadLetter('Unrecoverable error: invalid tenant')
```

These set internal state flags that the kernel reads after the pipeline completes.

## Event Bus

The event bus provides decoupled communication between the kernel, plugins, and user code.

### Core Events

| Event | Data | When |
|-------|------|------|
| `kernel:started` | `{}` | Queue has started |
| `kernel:stopped` | `{}` | Queue has stopped |
| `job:enqueued` | `{ jobId, queue, name }` | Job persisted |
| `job:started` | `{ jobId, queue, name }` | Job dequeued, about to process |
| `job:completed` | `{ jobId, queue, name, result }` | Handler succeeded |
| `job:failed` | `{ jobId, queue, name, error }` | Handler threw |
| `job:retry` | `{ jobId, queue, name, attempt, delay, error }` | Job requeued for retry |
| `job:dead` | `{ jobId, queue, name, error, attempt }` | Job moved to dead letter |
| `job:requeued` | `{ jobId, queue, name }` | Job requeued by middleware |
| `job:replayed` | `{ jobId, queue, name }` | Dead letter replayed |

### Wildcard Subscriptions

Use `*` to match all events under a namespace:

```typescript
q.events.on('job:*', (event) => {
  // Matches job:enqueued, job:completed, job:failed, etc.
})

q.events.on('workflow:*', (event) => {
  // Matches workflow:started, workflow:completed, workflow:failed, etc.
})
```

Wildcards match events with exactly two segments separated by `:`. The event `circuit:open` matches `circuit:*` but `my:deep:event` does not match `my:*`.

### Error Isolation

Event handlers are wrapped in try/catch. A failing handler does not prevent other handlers from running and does not crash the queue.

## Context Object

The `JobContext` is the primary interface for middleware and handlers:

```typescript
interface JobContext {
  job: Job                      // The current job (mutable)
  event: LifecycleEvent         // 'enqueue' | 'process' | etc.
  tenant?: {                    // Set by tenancy plugin
    id: string
    tier: string
  }
  trace?: {                     // Set by tracing plugin
    traceId: string
    spanId: string
  }
  workflow?: {                  // Set by workflows plugin
    workflowId: string
    stepId: string
    results: Record<string, unknown>
  }
  results?: Record<string, unknown>  // Shortcut for workflow.results
  state: Record<string, unknown>     // Arbitrary state shared across middleware
  log: Logger                   // Job-scoped logger (prefixed with job ID)

  // Actions
  requeue(opts?: { delay?: number; priority?: number }): void
  deadLetter(reason: string): void
  breaker(name: string, fn: () => Promise<unknown>): Promise<unknown>
  updateJob(updates: Partial<Job>): Promise<void>
  enqueue(name: string, payload: unknown, opts?: EnqueueOpts): Promise<string>
}
```

The context is created fresh for each job lifecycle event. Plugins enrich it in early phases (guard/transform), and handlers consume it in the execute phase.

## Backend Adapter

All storage backends implement the `BackendAdapter` interface:

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

This abstraction allows you to swap backends without changing application code. The dequeue operation returns a `completionToken` for at-least-once delivery guarantees.

## Worker Architecture

PsyQueue's worker system (`startWorker()`) uses a single dequeue loop with semaphore-controlled concurrency. This design avoids the overhead of multiple polling loops while still achieving high parallelism.

### Single Dequeue Loop + Semaphore

Instead of spawning N independent polling loops (one per concurrency slot), PsyQueue runs ONE dequeue loop that:

1. Waits for a free concurrency slot (semaphore).
2. Fetches jobs from the backend.
3. Dispatches jobs to handlers without waiting for them to complete.
4. Loops back immediately to fetch more.

This means the loop is never blocked waiting for a handler to finish -- it keeps pulling as long as concurrency slots are available.

### Blocking vs Poll Mode

The worker automatically selects the right dequeue strategy based on the backend:

**Blocking mode** (Redis -- `supportsBlocking: true`):
1. Try a non-blocking batch grab first (fast path via `batchDequeue()`).
2. If the queue is empty, fall back to BRPOPLPUSH (blocking wait) -- the Redis connection blocks until a job arrives or the timeout expires.
3. When BRPOPLPUSH unblocks, immediately batch-grab more jobs to fill the local buffer.

**Poll mode** (SQLite, Postgres -- `supportsBlocking: false`):
- Standard poll with `dequeue()`, sleeping for `pollInterval` ms when the queue is empty.

### ackAndFetch Fusion

When a handler completes successfully, PsyQueue uses the backend's `ackAndFetch()` method (when available) to ack the current job AND dequeue the next job in a single Lua script call. This reduces per-job Redis round-trips from 3 to 2:

- Without fusion: `dequeue` + `ack` + `dequeue` (3 calls per job)
- With fusion: `dequeue` + `ackAndFetch` (2 calls per job)

This is similar to BullMQ's `moveToFinished` optimization and is a key driver of PsyQueue's throughput advantage.

### Job Buffer

The worker maintains a local buffer of pre-fetched jobs. When the backend returns more jobs than there are free concurrency slots, the extras are buffered locally and dispatched as slots free up -- without making additional backend calls. The buffer size is controlled by the `batchSize` option (defaults to 2x concurrency).

## Job Lifecycle

```
  enqueue()         dequeue()         handler()          ack()
     |                 |                 |                 |
     v                 v                 v                 v
 [pending] -------> [active] -------> [completed]
     |                 |
     |  (future runAt) |  (error, retryable)
     v                 v
 [scheduled]       [retry] ------> [pending]
                       |
                       |  (exhausted / non-retryable)
                       v
                    [dead]
```

Jobs have six statuses:
- **pending** -- Ready to be dequeued and processed.
- **scheduled** -- Has a future `runAt` timestamp. The scheduler plugin polls and promotes to pending.
- **active** -- Currently being processed by a handler.
- **completed** -- Handler returned successfully.
- **failed** -- Handler threw an error (transient state before retry or dead letter).
- **dead** -- All retries exhausted or non-retryable error. Can be replayed via `q.deadLetter.replay()`.

## Creating a Plugin

Here is a minimal plugin that logs all enqueued jobs:

```typescript
import type { PsyPlugin, Kernel } from '@psyqueue/core'

export function myLogger(): PsyPlugin {
  return {
    name: 'my-logger',
    version: '1.0.0',

    init(kernel: Kernel): void {
      kernel.pipeline('enqueue', async (ctx, next) => {
        console.log(`[enqueue] ${ctx.job.name}`, ctx.job.payload)
        await next()
      }, { phase: 'observe' })

      kernel.events.on('job:completed', (event) => {
        const { jobId, name } = event.data as any
        console.log(`[completed] ${name} (${jobId})`)
      })
    },
  }
}
```

Register it: `q.use(myLogger())`
