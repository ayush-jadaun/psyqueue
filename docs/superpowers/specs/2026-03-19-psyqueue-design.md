# PsyQueue — Distributed Job Queue Platform

## Design Specification

**Version:** 1.0
**Date:** 2026-03-19
**Status:** Approved
**Runtime:** Node.js 20+ / ESM only
**Language:** TypeScript

---

## Table of Contents

1. [Overview](#1-overview)
2. [Design Philosophy](#2-design-philosophy)
3. [Micro-Kernel Architecture](#3-micro-kernel-architecture)
4. [Plugin System & Middleware Pipeline](#4-plugin-system--middleware-pipeline)
5. [Storage Abstraction](#5-storage-abstraction)
6. [Job Model & Schema Versioning](#6-job-model--schema-versioning)
7. [Workflow Orchestration & Sagas](#7-workflow-orchestration--sagas)
8. [Multi-Tenancy & Fair Scheduling](#8-multi-tenancy--fair-scheduling)
9. [Adaptive Backpressure & Circuit Breakers](#9-adaptive-backpressure--circuit-breakers)
10. [Exactly-Once & Idempotency](#10-exactly-once--idempotency)
11. [Deadline-Aware Dynamic Priority & Job Fusion](#11-deadline-aware-dynamic-priority--job-fusion)
12. [Observability — Dashboard, Tracing & Audit Log](#12-observability--dashboard-tracing--audit-log)
13. [Polyglot Workers](#13-polyglot-workers)
14. [Chaos Testing](#14-chaos-testing)
15. [Offline-First Sync](#15-offline-first-sync)
16. [Crash Recovery & Error Handling](#16-crash-recovery--error-handling)
17. [Package Structure](#17-package-structure)
18. [Standards & Non-Functional Requirements](#18-standards--non-functional-requirements)

---

## 1. Overview

### What Is PsyQueue?

PsyQueue is a **micro-kernel distributed job queue platform** for Node.js. Unlike traditional job queues (BullMQ, Celery, Sidekiq, pg-boss) that ship as monolithic products with fixed behaviors, PsyQueue ships as a tiny kernel with an ecosystem of composable plugins. Users assemble exactly the queue they need — nothing more, nothing less.

### The Problem

Every existing job queue forces trade-offs:

- **BullMQ** — Fast but Redis-only, no multi-tenancy, no workflows, primitive observability. Rate limiting is per-queue, not per-tenant. Stall detection misfires under load.
- **Celery** — 200+ config options, silent job loss with default settings, broken workflow primitives (chords), Python-only. Configuration is tribal knowledge.
- **Sidekiq** — Best features locked behind paid tiers (unique jobs, batches, rate limiting). Ruby-only. Each worker eats 200-500MB.
- **pg-boss** — Postgres isn't a message queue. Degrades past ~1K jobs/sec. No workflows, no tenancy, manual partition management.
- **Temporal** — Powerful but operationally extreme. Requires Cassandra/Postgres + Elasticsearch + Temporal cluster. Overkill for "run this in 5 minutes with 3 retries." Weeks of learning curve.

**Common gaps across ALL existing solutions:**
- No queue offers native multi-tenant fair scheduling
- No queue has adaptive backpressure that auto-tunes based on downstream health
- No queue provides exactly-once with built-in idempotency key management
- No queue supports job fusion (auto-batching identical jobs)
- No queue has deadline-aware dynamic priority
- No queue includes chaos testing for distributed failure simulation
- No queue supports offline-first with sync for unreliable networks
- No queue provides a tamper-evident audit log with hash chaining

PsyQueue solves all of these in a single, modular platform.

### Target Users

PsyQueue is designed in **concentric rings** — each audience enters at their comfort level and grows into advanced features:

**Ring 1: Indie / Startup Developers**
- Zero external dependencies to start (embedded SQLite)
- Minimal setup to initialize: `new PsyQueue()`, `.use(sqlite())`, `.start()` — add handlers as needed
- Works on $5/month VMs with 1GB RAM
- Offline-first sync for unreliable network environments

**Ring 2: SaaS Backend Teams**
- Multi-tenant fair scheduling, per-tenant rate limits
- Workflow orchestration with Saga compensation
- Production dashboard with real-time monitoring
- Schema-versioned payloads for safe deploys

**Ring 3: Platform / Infrastructure Engineers**
- Polyglot workers (enqueue from Node, process in Python/Go/Rust)
- Pluggable backends, custom middleware, third-party plugin ecosystem
- OpenTelemetry tracing, Prometheus metrics, audit logs
- Chaos testing for resilience validation

### Key Differentiators

| Feature | PsyQueue | BullMQ | Celery | Temporal |
|---------|----------|--------|--------|----------|
| Architecture | Micro-kernel + plugins | Monolithic | Monolithic | Monolithic |
| Zero-infra start | SQLite, no Docker needed | Requires Redis | Requires RabbitMQ/Redis | Requires Cassandra + ES |
| Pluggable backends | SQLite, Redis, Postgres, custom | Redis only | Redis or RabbitMQ | Cassandra or Postgres |
| Multi-tenant scheduling | Native, weighted fair queue | None | None | None |
| Workflow DAGs + Sagas | Plugin, with compensation | Parent-child only | Broken chords/chains | Yes, but complex |
| Adaptive backpressure | Auto-tunes concurrency | None | None | None |
| Circuit breakers | Per-dependency | None | None | None |
| Exactly-once | Idempotency keys + completion tokens | At-least-once | At-least-once | Yes |
| Job fusion | Auto-batch identical jobs | None | None | None |
| Dynamic priority | Deadline-aware, custom curves | Static levels | Static levels | None |
| Polyglot workers | gRPC + HTTP | Node only | Python only | Multi-language SDKs |
| Chaos testing | Built-in failure simulation | None | None | None |
| Offline sync | SQLite buffer + sync | None | None | None |
| Audit log | Hash-chained, tamper-evident | None | None | None |
| Dashboard | React + Vite, ships as plugin | Community (Bull Board) | Flower (fragile) | Temporal UI |
| Observability | OTel traces + Prometheus | Bolt-on | Bolt-on | Built-in |

---

## 2. Design Philosophy

### Core Principles

1. **Everything is a plugin.** The kernel does not know what a "queue" is, what "Redis" is, or what a "workflow" is. Plugins teach it. Even basic queue behavior (enqueue/dequeue) is a plugin (the backend adapter). This means:
   - Users compose exactly the features they need
   - Third parties can extend PsyQueue without forking
   - Features can be upgraded, swapped, or removed independently

2. **Every behavior is configurable.** No hardcoded reactions. When backpressure hits critical, the USER decides what happens — reject jobs, spill to disk, slow down, or do nothing. When a circuit breaker opens, the USER decides — requeue, fail, buffer, or route to a fallback. PsyQueue provides the primitives; users compose the policy.

3. **Progressive disclosure.** The simplest usage is 3 lines of code. Advanced features reveal themselves as needs grow. A beginner never sees gRPC protocol definitions or Saga compensation — unless they need them.

4. **Zero mandatory dependencies.** The kernel is zero-dependency. Each plugin brings its own dependencies. `@psyqueue/backend-sqlite` brings `better-sqlite3`. `@psyqueue/backend-redis` brings `ioredis`. Users only install what they use.

5. **Production-grade by default.** Crash recovery, graceful shutdown, structured logging, health checks — these aren't advanced features. They're baseline expectations that work out of the box.

### API Design: Middleware Pipeline Pattern

PsyQueue uses the Express/Koa middleware pattern. This was chosen because:

- **Familiarity** — Every Node.js developer knows `app.use(middleware)`. Zero learning curve for the basic API.
- **Composability** — Middleware can be stacked, reordered, and conditionally applied. Third-party middleware works alongside first-party.
- **Control flow** — Each middleware decides whether to call `next()`, short-circuit, or modify context. This gives fine-grained control over job processing.
- **Testability** — Each middleware is an isolated function that can be unit tested with a mock context.

```ts
// The pattern every Node.js developer already knows
const q = new PsyQueue()
q.use(plugin1())
q.use(plugin2())
q.use(plugin3())
await q.start()
```

---

## 3. Micro-Kernel Architecture

### Overview

The kernel is intentionally tiny — approximately 500 lines of code. It does exactly four things:

1. **Event Bus** — Internal pub/sub for lifecycle events
2. **Plugin Registry** — Register, resolve dependencies, manage plugin lifecycle
3. **Middleware Pipeline** — Ordered chain of functions for each lifecycle event
4. **Context Object** — Shared state passed through every middleware

```
+---------------------------------------------+
|              PsyQueue Kernel                 |
|  +----------+ +----------+ +-------------+  |
|  | Event Bus| | Plugin   | | Middleware   |  |
|  |          | | Registry | | Pipeline     |  |
|  +----------+ +----------+ +-------------+  |
|              +----------+                    |
|              | Context   |                    |
|              +----------+                    |
+---------------------------------------------+
         ^           ^           ^
         |           |           |
    +----+--+  +-----+---+  +---+----+
    |Storage|  |Scheduler |  |Workflow|  ...plugins
    +-------+  +----------+  +--------+
```

The kernel itself has **zero** npm dependencies. No Redis client, no database driver, no HTTP framework — nothing. Plugins bring their own dependencies.

### Event Bus

The event bus is the nervous system of PsyQueue. Every significant action emits an event. Plugins subscribe to events they care about.

**Built-in lifecycle events:**

| Event | Emitted When |
|-------|-------------|
| `kernel:starting` | Kernel is initializing |
| `kernel:started` | Kernel is ready to process |
| `kernel:stopping` | Shutdown initiated |
| `kernel:stopped` | Shutdown complete |
| `plugin:registered` | A plugin was added |
| `plugin:started` | A plugin completed its `start()` |
| `plugin:stopped` | A plugin completed its `stop()` |
| `job:enqueued` | A job was added to the queue |
| `job:dequeued` | A job was picked up by a worker |
| `job:started` | A job began processing |
| `job:completed` | A job finished successfully |
| `job:failed` | A job errored |
| `job:retrying` | A job is being retried |
| `job:dead-lettered` | A job moved to dead letter queue |
| `job:recovered` | A crashed job was recovered |
| `job:deadline-missed` | A job's deadline passed |
| `workflow:started` | A workflow instance began |
| `workflow:step-completed` | A workflow step finished |
| `workflow:completed` | All workflow steps finished |
| `workflow:failed` | A workflow step failed |
| `workflow:compensating` | Saga compensation started |
| `workflow:compensated` | Saga compensation completed |
| `circuit:open` | A circuit breaker opened |
| `circuit:close` | A circuit breaker closed |
| `circuit:half-open` | A circuit breaker is testing recovery |
| `backpressure:pressure` | System entered pressure state |
| `backpressure:critical` | System entered critical state |
| `backpressure:healthy` | System recovered to healthy |
| `sync:started` | Offline sync began |
| `sync:completed` | Offline sync finished |
| `sync:failed` | Offline sync errored |

**Event payload structure:**

```ts
interface PsyEvent<T = unknown> {
  type: string           // event name
  timestamp: Date        // when it occurred
  source: string         // plugin name that emitted it
  data: T                // event-specific payload
  traceId?: string       // OpenTelemetry trace correlation
}
```

**Subscribing to events:**

```ts
// In a plugin
init(kernel) {
  kernel.events.on('job:failed', (event) => {
    // React to job failures
    logger.error(`Job ${event.data.jobId} failed: ${event.data.error.message}`)
  })
}

// User-level event subscription
q.events.on('job:completed', (event) => {
  // Custom logic when jobs complete
})

// Wildcard subscriptions — `*` matches exactly one segment after the colon.
// `workflow:*` matches `workflow:started`, `workflow:failed`, etc.
// It does NOT match nested segments like `workflow:step:sub`.
// Prefix wildcards (e.g., `*:failed`) are NOT supported.
q.events.on('workflow:*', (event) => {
  // All workflow events
})
```

### Plugin Registry

The registry manages plugin lifecycle and dependency resolution.

**Plugin contract:**

```ts
interface PsyPlugin {
  /** Unique plugin name */
  name: string

  /** Semver version */
  version: string

  /**
   * Capabilities this plugin provides — used for dependency resolution.
   * A dependency on 'backend' is satisfied by any plugin that provides 'backend'.
   * Can be a single string or an array if the plugin provides multiple capabilities.
   * If multiple plugins provide the same capability, the last registered one wins.
   */
  provides?: string | string[]

  /**
   * Other plugins (by name or category) that must be registered before this one.
   * The kernel resolves registration order automatically.
   */
  depends?: string[]

  /**
   * Called when the plugin is registered with q.use().
   * Use this to subscribe to events and register middleware.
   * Must be synchronous — no async work here.
   */
  init(kernel: Kernel): void

  /**
   * Called when q.start() is invoked, after all plugins are initialized.
   * Use this for async setup: connect to databases, start servers, etc.
   * Plugins start in dependency order.
   */
  start?(): Promise<void>

  /**
   * Called when q.stop() is invoked.
   * Use this for cleanup: close connections, flush buffers, etc.
   * Plugins stop in reverse dependency order.
   */
  stop?(): Promise<void>

  /**
   * Called after stop(). Final cleanup — release file handles, timers, etc.
   */
  destroy?(): Promise<void>
}
```

**Plugin lifecycle:**

```
q.use(plugin)           → plugin.init(kernel)     [synchronous]
q.start()               → plugin.start()          [async, in dependency order]
q.stop()                → plugin.stop()           [async, in reverse order]
                        → plugin.destroy()        [async, in reverse order]
```

**Dependency resolution:**

When `q.start()` is called, the kernel topologically sorts all registered plugins by their `depends` declarations and starts them in order.

```ts
// Example: workflows depends on a backend
const workflowsPlugin: PsyPlugin = {
  name: 'workflows',
  version: '1.0.0',
  depends: ['backend'],  // any plugin with provides: 'backend' satisfies this
  init(kernel) { /* ... */ }
}

const sqlitePlugin: PsyPlugin = {
  name: 'sqlite',
  version: '1.0.0',
  provides: 'backend',   // satisfies 'backend' dependency
  init(kernel) { /* ... */ }
}

// Registration order doesn't matter — kernel resolves it
q.use(workflowsPlugin)   // registered first, but depends on 'backend'
q.use(sqlitePlugin)       // registered second, but starts first
```

**Error on missing dependencies:**

```
PsyQueueError: Plugin "workflows" requires "backend" but none is registered.
Install a backend: @psyqueue/backend-sqlite, @psyqueue/backend-redis, or @psyqueue/backend-postgres
```

**Error on circular dependencies:**

```
PsyQueueError: Circular dependency detected: plugin-a → plugin-b → plugin-c → plugin-a
```

### Context Object

The context (`ctx`) is a mutable object that flows through every middleware for a given operation. Plugins attach their state to it.

```ts
interface JobContext {
  /** The job being processed */
  job: Job

  /** Current lifecycle event (enqueue, dequeue, process, complete, fail, retry, schedule) */
  event: string

  /** Tenant information (if tenancy plugin is active) */
  tenant?: TenantInfo

  /** Trace context (if otel-tracing plugin is active) */
  trace?: TraceContext

  /** Workflow context (if this job is part of a workflow) */
  workflow?: WorkflowContext

  /** Results from previous workflow steps */
  results?: Record<string, unknown>

  /** Plugin-specific state — each plugin namespaces its data here */
  state: Record<string, unknown>

  /** Requeue the job with options (delay, priority change, etc.) */
  requeue(opts?: RequeueOpts): void

  /** Move job to dead letter queue */
  deadLetter(reason: string): void

  /** Access a circuit breaker by name */
  breaker(name: string, fn: () => Promise<unknown>): Promise<unknown>

  /** Update the job in storage */
  updateJob(updates: Partial<Job>): Promise<void>

  /** Enqueue a child job */
  enqueue(name: string, payload: unknown, opts?: EnqueueOpts): Promise<string>

  /** Logger scoped to this job */
  log: Logger
}
```

---

## 4. Plugin System & Middleware Pipeline

### Middleware Pipeline

Every job lifecycle event has its own middleware chain. When an event fires, the context flows through each middleware in registration order. Each middleware can:

- **Modify the context** — Add data, change priority, tag with metadata
- **Call `next()`** — Pass control to the next middleware
- **Short-circuit** — Return without calling `next()` to stop the chain
- **Wrap `next()`** — Execute code before and after downstream middleware (like Koa)

**Middleware signature:**

```ts
type Middleware = (ctx: JobContext, next: () => Promise<void>) => Promise<void>
```

**Lifecycle events that support middleware:**

| Event | Triggered When | Common Middleware Use |
|-------|---------------|---------------------|
| `enqueue` | Job is being added | Validation, dedup, rate limiting, schema check |
| `dequeue` | Job is being picked up | Tenant-aware selection, priority sorting |
| `process` | Job is being executed | Circuit breaking, timeout, tracing, the actual handler |
| `complete` | Job finished successfully | Cleanup, trigger next workflow step, metrics |
| `fail` | Job errored | Error classification, retry decision, dead letter |
| `retry` | Job is being retried | Backoff calculation, attempt tracking |
| `schedule` | Delayed/cron job scheduling | Deadline tracking, priority calculation |

**Registering middleware:**

Middleware is registered with `q.pipeline()` (or `kernel.pipeline()` inside plugins). This is **distinct** from `q.events.on()` which subscribes to fire-and-forget events. Middleware uses `(ctx, next)` signatures; events use `(event)` signatures.

```ts
// Plugin registers middleware during init
init(kernel) {
  kernel.pipeline('process', async (ctx, next) => {
    const start = Date.now()
    await next()
    ctx.log.info(`Processed in ${Date.now() - start}ms`)
  })
}

// Or user-level
q.pipeline('enqueue', async (ctx, next) => {
  // Add custom metadata to every enqueued job
  ctx.job.meta.source = 'api-v2'
  await next()
})
```

**Middleware ordering:**

Middleware runs in a deterministic order controlled by **phases**. Each middleware declares which phase it belongs to. Phases execute in this fixed order:

| Phase | Purpose | Example Plugins |
|-------|---------|-----------------|
| `guard` | Dedup, rate limiting, auth — short-circuit early | exactly-once, rate-limiter |
| `validate` | Schema validation, payload checks | schema-versioning |
| `transform` | Modify job before processing — fusion, priority | job-fusion, deadline-priority |
| `observe` | Logging, tracing, audit — non-blocking | otel-tracing, audit-log |
| `execute` | The actual work — backend persist, job handler | backend, user handler |
| `finalize` | Post-execution — cleanup, WAL flush, metrics | crash-recovery, metrics |

Within the same phase, middleware runs in plugin dependency order, then registration order. Third-party plugins declare their phase when registering middleware:

```ts
kernel.pipeline('enqueue', myMiddleware, { phase: 'validate' })
```

If no phase is specified, `execute` is the default.

**Resulting execution order:**

```
enqueue middleware chain:
  1. [exactly-once]    check idempotency key → if duplicate, short-circuit
  2. [tenancy]         check rate limit for tenant → if exceeded, throw
  3. [schema]          validate payload against registered schema
  4. [job-fusion]      check if job can be batched with pending jobs
  5. [backpressure]    check system load → if critical, apply configured action
  6. [audit-log]       record enqueue event
  7. [otel-tracing]    create span for enqueue
  8. [backend]         persist to storage (SQLite/Redis/Postgres)

process middleware chain:
  1. [crash-recovery]  write to WAL: job is active
  2. [otel-tracing]    create span for processing
  3. [circuit-breaker] check breaker state → if open, requeue
  4. [tenancy]         enforce concurrency limit for tenant
  5. [timeout]         wrap handler with timeout
  6. [user handler]    the actual job processing function
  7. [audit-log]       record completion/failure
  8. [crash-recovery]  write to WAL: job completed
```

### Plugin Categories

Every plugin PsyQueue ships belongs to a category. Categories are not enforced by the kernel — they're organizational.

**Backend Plugins** — Storage and queue primitives:

| Plugin | Package | Description |
|--------|---------|-------------|
| SQLite | `@psyqueue/backend-sqlite` | Embedded, zero-config. Uses `better-sqlite3`. Best for dev, single-server, IoT. |
| Redis | `@psyqueue/backend-redis` | High-throughput, low-latency. Uses `ioredis`. Supports Streams and Sorted Sets. |
| Postgres | `@psyqueue/backend-postgres` | Transactional, complex queries. Uses `SKIP LOCKED`. Best when Postgres already exists. |

**Scheduling Plugins** — When and in what order jobs run:

| Plugin | Package | Description |
|--------|---------|-------------|
| Scheduler | `@psyqueue/plugin-scheduler` | Delayed jobs (`runAt`), recurring jobs (`cron`). Distributed cron with leader election. |
| Deadline Priority | `@psyqueue/plugin-deadline-priority` | Auto-boost priority as deadlines approach. Configurable urgency curves. |

**Orchestration Plugins** — Multi-job coordination:

| Plugin | Package | Description |
|--------|---------|-------------|
| Workflows | `@psyqueue/plugin-workflows` | DAG execution, conditional branching, nested workflows. |
| Saga | `@psyqueue/plugin-saga` | Compensation (undo) logic for failed workflow steps. Works with workflows plugin. |
| Job Fusion | `@psyqueue/plugin-job-fusion` | Auto-batch identical jobs within a time window. |

**Tenancy Plugins** — Multi-tenant isolation:

| Plugin | Package | Description |
|--------|---------|-------------|
| Tenancy | `@psyqueue/plugin-tenancy` | Tenant tiers, fair scheduling algorithms, noisy-neighbor protection. |
| Rate Limiter | `@psyqueue/plugin-rate-limiter` | Per-tenant, per-queue rate limiting with sliding window. |

**Reliability Plugins** — Fault tolerance:

| Plugin | Package | Description |
|--------|---------|-------------|
| Circuit Breaker | `@psyqueue/plugin-circuit-breaker` | Per-dependency circuit breakers. Configurable open/close behavior. |
| Backpressure | `@psyqueue/plugin-backpressure` | Adaptive concurrency, load shedding. Fully configurable actions per state. |
| Exactly Once | `@psyqueue/plugin-exactly-once` | Idempotency keys, dedup window, completion tokens. |
| Crash Recovery | `@psyqueue/plugin-crash-recovery` | Write-ahead log, automatic job recovery, graceful shutdown. |

**Observability Plugins** — Visibility:

| Plugin | Package | Description |
|--------|---------|-------------|
| Dashboard | `@psyqueue/dashboard` | React + Vite UI served from the queue process. Real-time monitoring. |
| OTel Tracing | `@psyqueue/plugin-otel-tracing` | OpenTelemetry distributed tracing. Auto-correlates requests → jobs → steps. |
| Metrics | `@psyqueue/plugin-metrics` | Prometheus / OTLP metrics export. |
| Audit Log | `@psyqueue/plugin-audit-log` | Immutable, hash-chained event log. |

**Schema Plugins** — Payload management:

| Plugin | Package | Description |
|--------|---------|-------------|
| Schema Versioning | `@psyqueue/plugin-schema-versioning` | Versioned payloads with Zod, auto-migration between versions. |

**Transport Plugins** — Remote worker communication:

| Plugin | Package | Description |
|--------|---------|-------------|
| gRPC Workers | `@psyqueue/plugin-grpc-workers` | High-performance remote workers in any language via gRPC. |
| HTTP Workers | `@psyqueue/plugin-http-workers` | REST API for workers. Any language with HTTP support. |

**Testing Plugins** — Development tools:

| Plugin | Package | Description |
|--------|---------|-------------|
| Chaos Mode | `@psyqueue/plugin-chaos` | Simulate failures: slow processing, crashes, duplicate delivery, partitions. |

**Sync Plugins** — Offline-first:

| Plugin | Package | Description |
|--------|---------|-------------|
| Offline Sync | `@psyqueue/plugin-offline-sync` | Local SQLite buffer, sync to remote when connected. |

### Presets

For users who don't want to hand-pick every plugin, PsyQueue ships presets — curated bundles that cover common use cases.

```ts
import { PsyQueue, presets } from 'psyqueue'

// Lite — zero-config, single server
// Includes: SQLite backend, scheduler, crash recovery
const q = PsyQueue.from(presets.lite)

// SaaS — multi-tenant production
// Includes: Redis backend, tenancy, rate limiter, workflows, saga,
//           circuit breaker, backpressure, dashboard, metrics
const q = PsyQueue.from(presets.saas)

// Enterprise — compliance-ready
// Includes: Postgres backend, tenancy, workflows, saga, exactly-once,
//           circuit breaker, backpressure, audit log, OTel tracing,
//           schema versioning, dashboard, metrics, crash recovery
const q = PsyQueue.from(presets.enterprise)

// Presets are composable — override or extend
const q = PsyQueue.from(presets.saas, {
  override: {
    backend: postgres({ connectionString: process.env.DATABASE_URL })
  },
  add: [
    auditLog({ retention: '1y' }),
    chaosMode({ enabled: process.env.NODE_ENV === 'test' })
  ],
  remove: ['dashboard']  // don't need the UI in this service
})
```

### Third-Party Plugin Development

Anyone can write a PsyQueue plugin. The contract is minimal:

```ts
import type { PsyPlugin, Kernel } from 'psyqueue'

export function myCustomPlugin(options: MyOptions): PsyPlugin {
  return {
    name: 'my-custom-plugin',
    version: '1.0.0',
    depends: [],  // declare dependencies if any

    init(kernel: Kernel) {
      // Register middleware (sequential, with next())
      kernel.pipeline('process', async (ctx, next) => {
        // Your logic here
        await next()
      })

      // Subscribe to events (fire-and-forget observers)
      kernel.events.on('job:failed', (event) => {
        // React to failures
      })

      // Expose APIs to other plugins and users
      kernel.expose('myPlugin', {
        doSomething: () => { /* ... */ }
      })
    },

    async start() {
      // Async setup (connect to services, etc.)
    },

    async stop() {
      // Cleanup
    }
  }
}
```

---

## 5. Storage Abstraction

### Backend Adapter Interface

Every storage backend implements the same interface. The kernel and all plugins interact with storage exclusively through this contract. This is what makes backends swappable.

```ts
interface BackendAdapter {
  /** Unique name for this backend */
  name: string

  /** Backend type identifier */
  type: 'sqlite' | 'redis' | 'postgres' | string

  // === Connection Lifecycle ===

  /** Establish connection to the storage system */
  connect(): Promise<void>

  /** Close connection and release resources */
  disconnect(): Promise<void>

  /** Check if the backend is reachable and healthy */
  healthCheck(): Promise<boolean>

  // === Core Queue Operations ===

  /**
   * Add a job to the queue. Returns the assigned job ID.
   * The backend must persist the job atomically.
   */
  enqueue(job: Job): Promise<string>

  /**
   * Add multiple jobs atomically. Returns assigned job IDs in order.
   * If any job fails to enqueue, the entire batch is rolled back.
   */
  enqueueBulk(jobs: Job[]): Promise<string[]>

  /**
   * Atomically fetch up to `count` jobs from the specified queue.
   * Jobs must be locked so no other worker can dequeue them.
   * Returns an empty array if no jobs are available.
   * Each returned job includes a `completionToken` for exactly-once ack.
   */
  dequeue(queue: string, count: number): Promise<DequeuedJob[]>

  /**
   * Mark a job as successfully completed.
   * If `completionToken` is provided (from exactly-once plugin), the backend
   * atomically verifies the token matches before marking complete.
   * Returns `{ alreadyCompleted: true }` if another worker already acked.
   */
  ack(jobId: string, completionToken?: string): Promise<AckResult>

  /**
   * Reject a job. Depending on NackOpts, the job may be:
   * - Requeued (with optional delay)
   * - Moved to dead letter queue
   * - Marked as failed
   */
  nack(jobId: string, opts?: NackOpts): Promise<void>

  // === Query ===

  /** Retrieve a single job by ID */
  getJob(jobId: string): Promise<Job | null>

  /** List jobs with filtering, pagination, and sorting */
  listJobs(filter: JobFilter): Promise<PaginatedResult<Job>>

  // === Scheduling ===

  /** Schedule a job for future execution */
  scheduleAt(job: Job, runAt: Date): Promise<string>

  /**
   * Poll for scheduled jobs that are due.
   * Returns jobs where runAt <= now, up to `limit`.
   * Must atomically move them from scheduled → pending.
   */
  pollScheduled(now: Date, limit: number): Promise<Job[]>

  // === Distributed Coordination ===

  /**
   * Acquire a distributed lock. Returns true if acquired, false if held by another.
   * TTL (in milliseconds) prevents stale locks from crashed processes.
   * Each backend converts to its native unit internally (e.g., Redis SET NX uses seconds).
   */
  acquireLock(key: string, ttlMs: number): Promise<boolean>

  /** Release a previously acquired lock */
  releaseLock(key: string): Promise<void>

  // === Atomic Operations ===

  /**
   * Execute multiple operations atomically (within a transaction).
   * If any operation fails, all are rolled back.
   */
  atomic(ops: AtomicOp[]): Promise<void>
}
```

**Supporting types:**

```ts
/** Job returned from dequeue, with a completion token for exactly-once ack */
interface DequeuedJob extends Job {
  completionToken: string    // unique token for this dequeue attempt
}

interface AckResult {
  alreadyCompleted: boolean  // true if another worker already acked this job
}

interface NackOpts {
  requeue?: boolean        // put back in queue (default: true)
  delay?: number           // ms to wait before requeue
  deadLetter?: boolean     // move to DLQ instead
  reason?: string          // why it was rejected
}

interface JobFilter {
  queue?: string           // filter by queue name (supports wildcards)
  status?: JobStatus | JobStatus[]
  tenantId?: string
  name?: string            // job type name
  from?: Date              // created after
  to?: Date                // created before
  limit?: number           // page size (default: 50)
  offset?: number          // pagination offset
  sortBy?: 'createdAt' | 'priority' | 'runAt'
  sortOrder?: 'asc' | 'desc'
}

interface PaginatedResult<T> {
  data: T[]
  total: number
  limit: number
  offset: number
  hasMore: boolean
}

type AtomicOp =
  | { type: 'enqueue'; job: Job }
  | { type: 'ack'; jobId: string }
  | { type: 'nack'; jobId: string; opts?: NackOpts }
  | { type: 'update'; jobId: string; updates: Partial<Job> }
```

### Backend Implementations

Each backend plays to its strengths. They are not identical implementations over different databases — each uses the optimal strategy for its storage engine.

#### SQLite Backend (`@psyqueue/backend-sqlite`)

**Dependencies:** `better-sqlite3`

**Best for:** Development, single-server deployments, embedded systems, IoT, offline-first.

**Implementation details:**

| Operation | Strategy |
|-----------|----------|
| Enqueue | `INSERT INTO jobs (...)` |
| Dequeue | `UPDATE jobs SET status='active' WHERE status='pending' AND queue=? ORDER BY priority DESC, created_at ASC LIMIT ? RETURNING *` |
| Scheduling | Indexed `run_at` column, polled on interval |
| Locking | File-level locking (single process only) |
| Transactions | Native SQLite transactions (extremely fast) |

**Performance:** ~1,000 jobs/sec. Limited to single process, but extremely fast within that constraint.

**Schema:**

```sql
CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  queue TEXT NOT NULL,
  name TEXT NOT NULL,
  payload TEXT NOT NULL,           -- JSON
  status TEXT NOT NULL DEFAULT 'pending',
  priority INTEGER NOT NULL DEFAULT 0,
  tenant_id TEXT,
  idempotency_key TEXT,
  schema_version INTEGER,
  max_retries INTEGER NOT NULL DEFAULT 3,
  attempt INTEGER NOT NULL DEFAULT 1,
  backoff TEXT NOT NULL DEFAULT 'exponential',
  timeout INTEGER NOT NULL DEFAULT 30000,
  workflow_id TEXT,
  step_id TEXT,
  parent_job_id TEXT,
  trace_id TEXT,
  span_id TEXT,
  run_at TEXT,                     -- ISO 8601
  cron TEXT,
  deadline TEXT,                   -- ISO 8601
  result TEXT,                     -- JSON
  error TEXT,                      -- JSON
  meta TEXT DEFAULT '{}',          -- JSON
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT
);

CREATE INDEX idx_jobs_dequeue ON jobs (queue, status, priority DESC, created_at ASC);
CREATE INDEX idx_jobs_scheduled ON jobs (run_at) WHERE status = 'scheduled';
CREATE INDEX idx_jobs_tenant ON jobs (tenant_id, queue, status);
CREATE INDEX idx_jobs_idempotency ON jobs (idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX idx_jobs_workflow ON jobs (workflow_id) WHERE workflow_id IS NOT NULL;
```

#### Redis Backend (`@psyqueue/backend-redis`)

**Dependencies:** `ioredis`

**Best for:** High-throughput, low-latency, distributed deployments.

**Implementation details:**

| Operation | Strategy |
|-----------|----------|
| Enqueue | `XADD` to Redis Stream (or `ZADD` to sorted set) |
| Dequeue | `XREADGROUP` with consumer groups (or `BRPOPLPUSH` for simple queues) |
| Scheduling | Sorted set keyed by timestamp. Polled with `ZRANGEBYSCORE`. |
| Locking | `SET key NX EX ttl` (single node) or Redlock (cluster) |
| Dedup | `SET idempotency:key NX EX window` |

**Performance:** ~100,000 jobs/sec. Horizontally scalable with Redis Cluster.

**Key structure:**

```
psyqueue:{queue}:stream       — Redis Stream for the queue
psyqueue:{queue}:scheduled    — Sorted set for delayed jobs
psyqueue:{queue}:dead         — List of dead-lettered jobs
psyqueue:lock:{key}           — Distributed locks
psyqueue:dedup:{key}          — Idempotency dedup keys
psyqueue:job:{id}             — Job hash (full job data)
psyqueue:tenant:{id}:rate     — Sliding window rate counter
psyqueue:metrics:*            — Real-time metric counters
```

#### Postgres Backend (`@psyqueue/backend-postgres`)

**Dependencies:** `pg` (node-postgres)

**Best for:** When Postgres already exists in the stack, transactional guarantees, complex querying.

**Implementation details:**

| Operation | Strategy |
|-----------|----------|
| Enqueue | `INSERT INTO jobs (...)` |
| Dequeue | `SELECT ... FOR UPDATE SKIP LOCKED LIMIT ?` — atomic, non-blocking |
| Scheduling | Partitioned table with `run_at` index, polled on interval |
| Locking | `pg_advisory_lock(hash)` — session-level advisory locks |
| Transactions | Full ACID transactions across enqueue + dequeue + state changes |

**Performance:** ~10,000 jobs/sec. Scales vertically. Can be horizontally read-scaled with replicas.

**Schema:** Same structure as SQLite but with Postgres types (`JSONB` instead of `TEXT` for JSON fields, `TIMESTAMPTZ` for dates, `UUID` or `TEXT` for IDs).

### Backend Migration

Users can migrate between backends without rewriting application code.

```bash
# CLI migration tool
npx psyqueue migrate --from sqlite://./jobs.db --to redis://prod:6379

# With options
npx psyqueue migrate \
  --from sqlite://./jobs.db \
  --to postgres://user:pass@host:5432/psyqueue \
  --batch-size 1000 \
  --include-completed false \
  --include-dead-letter true
```

**Application code change is a single line:**

```ts
// Before (SQLite)
q.use(sqlite({ path: './jobs.db' }))

// After (Redis) — no other code changes
q.use(redis({ url: 'redis://prod:6379' }))
```

---

## 6. Job Model & Schema Versioning

### Core Job Object

Every job in PsyQueue has this structure. Most fields are optional and populated by plugins.

```ts
interface Job {
  // === Identity ===
  /** Unique job ID. ULID format — sortable, timestamp-embedded, globally unique */
  id: string

  /** Logical queue name (e.g., 'email.send', 'payments.charge') */
  queue: string

  /** Job type identifier (e.g., 'send-welcome-email') */
  name: string

  /** User-provided data for the job handler */
  payload: unknown

  // === Schema ===
  /** Payload version number. Enables automatic migration between versions */
  schemaVersion?: number

  // === Scheduling ===
  /** Priority 0-100. Higher = more urgent. Dynamic priority plugins may modify this */
  priority: number

  /** Job must complete by this time. Used by deadline-priority plugin */
  deadline?: Date

  /** Don't process until this time */
  runAt?: Date

  /** Cron expression for recurring jobs */
  cron?: string

  // === Tenancy ===
  /** Tenant identifier for multi-tenant isolation */
  tenantId?: string

  // === Reliability ===
  /** Deduplication key. If another job with this key exists in the dedup window, this job is a duplicate */
  idempotencyKey?: string

  /** Maximum number of retry attempts AFTER the initial attempt (default: 3).
   *  Total executions = 1 initial + maxRetries. So maxRetries: 3 means up to 4 total attempts. */
  maxRetries: number

  /** Current attempt number (starts at 1 for the initial attempt, 2 for first retry, etc.) */
  attempt: number

  /** Retry backoff strategy */
  backoff: 'fixed' | 'exponential' | 'linear' | BackoffFunction

  /** Base delay for backoff in ms (default: 1000). First retry waits this long. */
  backoffBase?: number

  /** Maximum backoff delay in ms (default: 300000 / 5min). Backoff never exceeds this. */
  backoffCap?: number

  /** Add random jitter to backoff delays to prevent thundering herd (default: true) */
  backoffJitter?: boolean

  /** Maximum processing time in ms before job is considered stuck (default: 30000) */
  timeout: number

  // === Workflow ===
  /** Parent workflow instance ID (if this job is a workflow step) */
  workflowId?: string

  /** Step identifier within the workflow DAG */
  stepId?: string

  /** ID of the job that spawned this one */
  parentJobId?: string

  // === Tracing (populated by otel-tracing plugin; absent if plugin not installed) ===
  /** OpenTelemetry trace ID — correlates with originating request */
  traceId?: string

  /** OpenTelemetry span ID */
  spanId?: string

  // === State ===
  /** Current job status */
  status: 'pending' | 'scheduled' | 'active' | 'completed' | 'failed' | 'dead'

  /** Output data on successful completion */
  result?: unknown

  /** Error details on failure */
  error?: JobError

  // === Timestamps ===
  /** When the job was created */
  createdAt: Date

  /** When a worker started processing */
  startedAt?: Date

  /** When the job completed (success or failure) */
  completedAt?: Date

  // === Metadata ===
  /**
   * Open metadata bag. Plugins attach their state here.
   * Users can also attach custom data.
   * Convention: plugins namespace their keys (e.g., meta['tenancy.tier'] = 'pro')
   */
  meta: Record<string, unknown>
}

interface JobError {
  message: string
  code?: string
  stack?: string
  category?: 'transient' | 'validation' | 'rate-limit' | 'fatal' | 'unknown'
  retryable: boolean
}

type BackoffFunction = (attempt: number, error?: Error) => number  // returns ms
```

**Job ID format — ULID:**

PsyQueue uses ULIDs (Universally Unique Lexicographically Sortable Identifiers) instead of UUIDs because:
- They sort chronologically (useful for "show me the latest jobs")
- They embed a timestamp (no separate `createdAt` index needed for sorting)
- They're globally unique without coordination
- They're 26 characters, URL-safe

Example: `01JARQ5ZXKM3JGFWZWHQE3XNHP`

### Enqueue API

```ts
// Simple — minimal arguments
const jobId = await q.enqueue('email.send', {
  to: ['user@example.com'],
  subject: 'Welcome',
  body: 'Hello!'
})

// Full options
const jobId = await q.enqueue('payment.charge', {
  orderId: 'ord_123',
  amount: 9900,
  currency: 'usd'
}, {
  queue: 'payments',               // explicit queue (default: derived from job name)
  tenantId: 'tenant_acme',         // multi-tenant routing
  priority: 80,                    // 0-100
  deadline: new Date('2026-03-19T15:00:00Z'),  // must finish by 3pm
  runAt: new Date('2026-03-20T09:00:00Z'),     // delay until tomorrow 9am
  idempotencyKey: `charge_ord_123`,            // prevent duplicate charges
  maxRetries: 5,
  timeout: 30_000,                 // 30s processing timeout
  backoff: 'exponential',         // 1s, 2s, 4s, 8s, 16s
  meta: {                          // custom metadata
    source: 'checkout-api',
    correlationId: 'req_abc123'
  }
})

// Recurring (cron)
await q.enqueue('reports.daily', {}, {
  cron: '0 2 * * *'              // every day at 2am
})

// Bulk enqueue (atomic)
const jobIds = await q.enqueueBulk([
  { name: 'email.send', payload: { to: 'a@b.com', body: '...' } },
  { name: 'email.send', payload: { to: 'c@d.com', body: '...' } },
  { name: 'email.send', payload: { to: 'e@f.com', body: '...' } }
])
```

### Job Handlers

```ts
// Simple handler
q.handle('email.send', async (ctx) => {
  await sendEmail(ctx.job.payload)
  return { sent: true }  // stored as job.result
})

// Handler with options
q.handle('payment.charge', async (ctx) => {
  const charge = await ctx.breaker('stripe', () =>
    stripe.charges.create(ctx.job.payload)
  )
  return { chargeId: charge.id }
}, {
  concurrency: 10,                // max parallel executions
  timeout: 30_000,
  queue: 'payments'               // only process from this queue
})
```

### Schema Versioning

Job payloads evolve as code changes. PsyQueue's schema versioning plugin ensures old jobs in the queue work with new handlers, and vice versa.

**Registering versioned handlers:**

```ts
import { z } from 'zod'

q.handle('email.send', {
  versions: {
    1: {
      schema: z.object({
        to: z.string(),
        body: z.string()
      }),
      process: async (ctx) => {
        await sendEmail(ctx.job.payload.to, ctx.job.payload.body)
      }
    },
    2: {
      schema: z.object({
        to: z.array(z.string()),      // changed: string → array
        body: z.string(),
        html: z.boolean()              // added: html flag
      }),
      process: async (ctx) => {
        const { to, body, html } = ctx.job.payload
        await sendEmail(to, body, { html })
      },
      // Migration function: how to convert v1 → v2
      migrate: (v1Payload) => ({
        to: [v1Payload.to],           // wrap string in array
        body: v1Payload.body,
        html: false                    // default for new field
      })
    },
    3: {
      schema: z.object({
        recipients: z.array(z.object({ email: z.string(), name: z.string().optional() })),
        body: z.string(),
        html: z.boolean(),
        attachments: z.array(z.string()).optional()
      }),
      process: async (ctx) => { /* v3 handler */ },
      // Can migrate from any prior version
      migrate: (v2Payload) => ({
        recipients: v2Payload.to.map(email => ({ email })),
        body: v2Payload.body,
        html: v2Payload.html,
        attachments: []
      })
    }
  },
  current: 3  // new jobs are enqueued with v3 schema
})
```

**Migration chain:**

When a v1 job hits a v3 worker, migrations chain automatically:
```
v1 payload → migrate(v1→v2) → migrate(v2→v3) → validate against v3 schema → process with v3 handler
```

**On schema validation failure:**
1. Job moves to dead letter queue with error code `SCHEMA_MISMATCH`
2. Error includes: which version was expected, which fields failed, the raw payload
3. Dashboard shows the failure with a "fix and replay" button
4. Audit log records the schema mismatch

---

## 7. Workflow Orchestration & Sagas

### DAG Workflows

The workflow plugin enables composing multiple jobs into a directed acyclic graph (DAG). Steps can run sequentially, in parallel, or conditionally based on prior results.

**Defining a workflow:**

```ts
import { workflow } from '@psyqueue/plugin-workflows'

const orderPipeline = workflow('order.process')
  .step('validate', validateOrder)
  .step('payment', chargePayment, { after: 'validate' })
  .step('inventory', reserveStock, { after: 'validate' })   // parallel with payment
  .step('ship', shipOrder, { after: ['payment', 'inventory'] }) // waits for both
  .step('notify', sendConfirmation, { after: 'ship' })
  .build()
```

**Visual representation:**

```
validate
   |--- payment ---\
   |                |--- ship --- notify
   |--- inventory -/
```

**Starting a workflow:**

```ts
const workflowId = await q.enqueue(orderPipeline, {
  orderId: 'ord_123',
  customer: { id: 'cust_456', email: 'user@example.com' }
})
```

**How it executes:**

1. Workflow engine enqueues the root step (`validate`) as a normal job
2. When `validate` completes, the engine examines the DAG for steps whose dependencies are all satisfied
3. Both `payment` and `inventory` have only `validate` as a dependency → both are enqueued in parallel
4. When BOTH `payment` AND `inventory` complete, `ship` is enqueued
5. When `ship` completes, `notify` is enqueued
6. When all steps complete, workflow status → `COMPLETED`

Each step is a regular job — it flows through the full middleware pipeline, gets retried on failure, has its own timeout, etc.

**Accessing prior step results:**

```ts
const shipOrder = async (ctx) => {
  // Results from completed steps are available
  const paymentResult = ctx.results.payment   // { chargeId: 'ch_123' }
  const inventoryResult = ctx.results.inventory // { reserved: true, warehouseId: 'w1' }

  await shipFromWarehouse(inventoryResult.warehouseId, ctx.job.payload.orderId)
}
```

### Conditional Branching

Steps can include conditions that determine whether they execute:

```ts
workflow('user.onboard')
  .step('verify', verifyIdentity)
  .step('premium-setup', setupPremium, {
    after: 'verify',
    when: (ctx) => ctx.results.verify.tier === 'premium'
  })
  .step('basic-setup', setupBasic, {
    after: 'verify',
    when: (ctx) => ctx.results.verify.tier === 'basic'
  })
  .step('welcome', sendWelcome, { after: ['premium-setup', 'basic-setup'] })
  .build()
```

When `when` returns `false`, the step is skipped (status: `SKIPPED`). Downstream steps that depend on a skipped step still proceed — they only wait for steps that actually ran.

**Edge case — all dependencies skipped:** If ALL dependencies of a step were skipped (e.g., neither `premium-setup` nor `basic-setup` ran), the step runs immediately with no upstream results. This prevents workflows from stalling when conditional branches don't match. If you want a step to be skipped when all its dependencies are skipped, use `when` on that step too.

### Saga Compensation

When a workflow step fails and all retries are exhausted, PsyQueue can automatically undo the work of completed steps by running compensation functions in reverse order.

```ts
workflow('booking.create')
  .step('reserve_flight', bookFlight, {
    compensate: cancelFlight       // undo function
  })
  .step('reserve_hotel', bookHotel, {
    after: 'reserve_flight',
    compensate: cancelHotel
  })
  .step('charge_card', processPayment, {
    after: 'reserve_hotel',
    compensate: refundPayment
  })
  .build()
```

**When `charge_card` fails (after all retries):**

1. Workflow status → `COMPENSATING`
2. Engine walks backward through completed steps:
   - `refundPayment()` — skipped (charge failed, nothing to refund)
   - `cancelHotel()` — runs (hotel was reserved, must be cancelled)
   - `cancelFlight()` — runs (flight was reserved, must be cancelled)
3. If all compensations succeed → workflow status → `COMPENSATED`
4. If a compensation fails → workflow status → `COMPENSATION_FAILED` → requires manual intervention

**Compensation functions receive the original step's result:**

```ts
const cancelFlight = async (ctx) => {
  // ctx.results.reserve_flight contains the original booking result
  const { bookingId } = ctx.results.reserve_flight
  await flightAPI.cancel(bookingId)
}
```

### Workflow State Machine

```
PENDING → RUNNING → COMPLETED
                  → FAILED → COMPENSATING → COMPENSATED
                  |                       → COMPENSATION_FAILED
                  → CANCELLED
FAILED → PENDING (manual retry via API/dashboard)
COMPENSATION_FAILED → COMPENSATING (manual retry compensation)
```

| State | Meaning |
|-------|---------|
| `PENDING` | Workflow created, first step not yet started |
| `RUNNING` | At least one step is active |
| `COMPLETED` | All steps completed successfully |
| `FAILED` | A step failed after all retries (and no compensation defined) |
| `COMPENSATING` | Running compensation functions |
| `COMPENSATED` | All compensations ran successfully |
| `COMPENSATION_FAILED` | A compensation function failed — manual intervention required |
| `CANCELLED` | Workflow was cancelled by user. Active steps are allowed to complete, pending steps are skipped. |

**Manual intervention:**
- `FAILED` workflows can be retried via `q.workflows.retry(workflowId)` — this resets the failed step to `PENDING` and re-runs from there
- `COMPENSATION_FAILED` workflows can retry compensation via `q.workflows.retryCompensation(workflowId)`
- `RUNNING` workflows can be cancelled via `q.workflows.cancel(workflowId)` — active steps finish, pending steps are skipped

### Workflow Persistence

Workflow state is persisted to the backend after every step transition. If the server crashes:

1. On restart, the workflow engine queries the backend for `RUNNING` workflows
2. For each workflow, it determines which steps completed and which are pending
3. It resumes from the last completed step — no work is redone, no steps are skipped

### Nested Workflows

A workflow step can itself be another workflow:

```ts
const buildWorkflow = workflow('build')
  .step('lint', runLint)
  .step('test', runTests, { after: 'lint' })
  .step('compile', runCompile, { after: 'test' })
  .build()

const deployPipeline = workflow('deploy.full')
  .step('build', buildWorkflow)                              // nested workflow
  .step('deploy-staging', deployToStaging, { after: 'build' })
  .step('smoke-test', runSmokeTests, { after: 'deploy-staging' })
  .step('deploy-prod', deployToProd, { after: 'smoke-test' })
  .build()
```

The parent workflow waits for the child workflow to fully complete before advancing.

---

## 8. Multi-Tenancy & Fair Scheduling

### Overview

In SaaS applications, multiple tenants share the same job queue infrastructure. Without tenant-aware scheduling, a single tenant's burst can starve all others. PsyQueue's tenancy plugin solves this at the infrastructure level.

### Tenant Configuration

```ts
q.use(tenancy({
  tiers: {
    free:       { rateLimit: { max: 100, window: '1m' },   concurrency: 5,   weight: 1 },
    pro:        { rateLimit: { max: 1000, window: '1m' },  concurrency: 20,  weight: 3 },
    enterprise: { rateLimit: { max: 10000, window: '1m' }, concurrency: 100, weight: 10 }
  },

  resolveTier: async (tenantId) => {
    return await db.getTenantTier(tenantId)
  },

  scheduling: 'weighted-fair-queue'
}))
```

**Configuration fields:**

| Field | Type | Description |
|-------|------|-------------|
| `rateLimit` | `{ max: number, window: '1s' \| '1m' \| '1h' }` | Maximum jobs this tier can enqueue within the specified window |
| `concurrency` | number | Maximum simultaneously processing jobs for this tenant |
| `weight` | number | Relative share of processing capacity in fair scheduling |

### Scheduling Algorithms

The `scheduling` option determines how the system decides which tenant's job to process next.

**Weighted Fair Queue (recommended for most SaaS):**

Each tenant receives processing time proportional to their tier weight. A tenant with weight 10 gets 10x the throughput of a tenant with weight 1 — but weight-1 tenants are never fully starved.

```
Capacity distribution with weights: enterprise=10, pro=3, free=1

Processing slots: [E][E][E][E][E][E][E][E][E][E][P][P][P][F]
                  <-------- enterprise --------> <--pro--> <f>
```

The algorithm uses deficit-weighted round robin internally:
1. Each tenant has a "deficit" counter
2. On each scheduling cycle, add each tenant's weight to their deficit
3. Pick the tenant with the highest deficit AND has pending jobs
4. Deduct 1 from their deficit
5. This naturally distributes capacity proportionally

**Round Robin:**

Cycle through tenants one at a time, regardless of weight or queue depth. Each tenant gets one job processed before moving to the next. Simple and strictly fair.

**Strict Priority:**

Higher-tier tenants are always processed first. Lower tiers only process when higher tiers have empty queues. Use when enterprise SLAs are non-negotiable.

### Rate Limiting

Rate limits are enforced at the `enqueue` middleware stage using a **sliding window** algorithm. This avoids the burst-at-boundary problem of fixed windows.

```ts
// When a tenant exceeds their rate limit:
await q.enqueue('report.generate', payload, { tenantId: 'tenant_free_123' })
// Throws: PsyQueueError {
//   code: 'RATE_LIMIT_EXCEEDED',
//   message: 'Tenant tenant_free_123 exceeded rate limit: 100/min',
//   retryAfter: 4200  // ms until capacity is available
// }
```

**Sliding window algorithm:**
- Divide each minute into sub-windows (e.g., 6 windows of 10 seconds)
- Count jobs in the current window + weighted count from the previous window
- Weighted count = previous window count * (1 - elapsed fraction of current window)
- This prevents burst allowances at window boundaries

### Noisy Neighbor Protection

When a single tenant suddenly enqueues a massive number of jobs:

1. **Rate limiter** prevents them from exceeding their per-minute cap
2. **Fair scheduler** ensures other tenants keep getting processing slots
3. **Backpressure plugin** can auto-throttle if the burst overwhelms the system
4. **Dashboard** shows a tenant-level queue depth spike alert

### Per-Tenant Metrics

The tenancy plugin automatically tags all metrics with `tenantId`:

```ts
q.on('metrics', (m) => {
  // Available per-tenant metrics:
  // m.tenantId     — which tenant
  // m.queue        — which queue
  // m.throughput   — jobs/sec for this tenant
  // m.p50Latency   — median processing time
  // m.p99Latency   — 99th percentile processing time
  // m.activeJobs   — currently processing
  // m.pendingJobs  — waiting in queue
  // m.failRate     — failure percentage
  // m.rateLimitUsage — current rate / max rate (0.0 to 1.0)
})
```

### Dynamic Tenant Management

Tenant configuration can be changed at runtime without restarting:

```ts
// Upgrade a tenant
await q.tenancy.setTier('tenant_123', 'enterprise')

// Custom overrides for specific tenants
await q.tenancy.override('tenant_456', {
  rateLimit: 5000,       // custom limit, not tied to tier
  concurrency: 50
})

// Remove override (revert to tier defaults)
await q.tenancy.removeOverride('tenant_456')

// List all tenants and their current stats
const tenants = await q.tenancy.list()
// [{ id: 'tenant_123', tier: 'enterprise', activeJobs: 45, pendingJobs: 120, ... }]
```

---

## 9. Adaptive Backpressure & Circuit Breakers

### Adaptive Backpressure

The backpressure plugin monitors system health signals and automatically adjusts behavior. Critically, **every action at every state is user-configurable** — PsyQueue never makes decisions the user hasn't explicitly opted into.

**Three states:**

| State | Meaning |
|-------|---------|
| `HEALTHY` | All signals within normal range. Full speed. |
| `PRESSURE` | One or more signals crossed the pressure threshold. System is stressed. |
| `CRITICAL` | One or more signals crossed the critical threshold. System is at risk. |

**Configuration:**

```ts
q.use(backpressure({
  // Define thresholds for health signals
  signals: {
    queueDepth:     { pressure: 10_000,       critical: 100_000 },
    processingTime: { pressure: '2x baseline', critical: '5x baseline' },
    memoryUsage:    { pressure: 0.75,          critical: 0.90 },
    errorRate:      { pressure: 0.10,          critical: 0.30 },
    consumerLag:    { pressure: '5m',          critical: '30m' }
  },

  // User defines EXACTLY what each state does — pick from available actions
  actions: {
    pressure: [
      'reduce-concurrency',
      'emit-warning'
    ],
    critical: [
      'spill-to-disk',
      'emit-critical'
    ]
  },

  // OR use fully custom functions for complete control.
  // If `onPressure`/`onCritical` callbacks are provided, they REPLACE the
  // corresponding `actions` array. You cannot use both — the kernel validates
  // this at startup and throws if both are specified for the same state.
  onPressure: async (ctx) => {
    await ctx.setConcurrency(ctx.current.concurrency * 0.5)
    await ctx.notify('slack', 'Queue under pressure')
  },
  onCritical: async (ctx) => {
    await ctx.spillToDisk()
    // NOT rejecting — this user chose to buffer instead
  },
  onRecovery: async (ctx) => {
    await ctx.restoreConcurrency({ stepUp: 0.25, cooldown: 30_000 })
  },

  // Recovery behavior
  recovery: {
    cooldown: 30_000,     // wait 30s after signals normalize before scaling back up
    stepUp: 0.25          // restore 25% of capacity at a time (no thundering herd)
  }
}))
```

**Available action primitives:**

| Action | What It Does |
|--------|-------------|
| `reduce-concurrency` | Halve active worker count |
| `throttle-enqueue` | Add configurable delay between accepting new jobs |
| `pause-producers` | Stop accepting new jobs entirely (returns 503 to producers) |
| `reject-low-priority` | Only accept jobs above a priority threshold |
| `spill-to-disk` | Overflow pending jobs to local SQLite (if using Redis/Postgres) |
| `emit-warning` | Fire `backpressure:pressure` event on the bus |
| `emit-critical` | Fire `backpressure:critical` event on the bus |

Users compose their own policy from these primitives. A user who never wants to reject jobs simply doesn't include `reject-low-priority` or `pause-producers`.

**Auto-scaling concurrency:**

The backpressure plugin continuously monitors throughput and latency to find the optimal concurrency level:

```
t=0    baseline: 50 jobs/sec at concurrency 10
t=60   throughput dropping, latency rising → reduce to concurrency 7
t=120  stabilized → hold at 7
t=180  queue draining, latency low → step up to 8
t=300  back to healthy → restore concurrency 10
```

### Circuit Breakers

Circuit breakers protect the system when external dependencies fail. They operate **per-dependency**, not globally — if Stripe is down, only payment jobs pause. Email jobs keep flowing.

**Configuration:**

```ts
q.use(circuitBreaker({
  breakers: {
    stripe: {
      timeout: 5000,             // ms before a call is considered failed
      failureThreshold: 5,       // failures in window to open circuit
      failureWindow: 60_000,     // 1 minute window
      resetTimeout: 30_000,      // wait 30s before testing recovery
      halfOpenRequests: 3,       // let 3 requests through in half-open

      // What happens when circuit opens — CONFIGURABLE
      onOpen: 'requeue',         // default: requeue with delay
      // OR
      onOpen: 'fail',            // immediately fail the job
      // OR
      onOpen: 'buffer',          // hold in memory, retry when closed
      // OR
      onOpen: async (ctx) => {   // fully custom
        await ctx.moveToQueue('payment.fallback')
      }
    },
    sendgrid: {
      timeout: 10_000,
      failureThreshold: 10,
      failureWindow: 120_000,
      resetTimeout: 60_000,
      halfOpenRequests: 5,
      onOpen: 'requeue'
    }
  }
}))
```

**Using circuit breakers in handlers:**

```ts
q.handle('payment.charge', async (ctx) => {
  const result = await ctx.breaker('stripe', () => {
    return stripe.charges.create(ctx.job.payload)
  })
  return result
})
```

**Circuit breaker state machine:**

```
CLOSED ──[failures exceed threshold]──→ OPEN
OPEN ──[resetTimeout expires]──→ HALF_OPEN
HALF_OPEN ──[halfOpenRequests succeed]──→ CLOSED
HALF_OPEN ──[any failure]──→ OPEN
```

| State | Behavior |
|-------|----------|
| `CLOSED` | Normal operation. Failures are counted. |
| `OPEN` | Calls are not attempted. Action determined by `onOpen` config. |
| `HALF_OPEN` | Limited requests pass through to test if dependency recovered. |

**Backpressure + circuit breaker interaction:**

These plugins communicate through the event bus:
1. When a circuit opens → event `circuit:open` fires
2. Backpressure plugin sees reduced effective capacity for that dependency
3. Concurrency for affected queues is automatically reduced
4. When circuit closes → `circuit:close` fires
5. Backpressure gradually restores concurrency using `stepUp` recovery (prevents thundering herd)

---

## 10. Exactly-Once & Idempotency

### The Problem

Every job queue says "at-least-once delivery — make your jobs idempotent." But:
- Making every job idempotent is expensive and error-prone
- Some operations can't easily be made idempotent (sending emails, charging credit cards)
- Developers are left to implement their own dedup logic every time

PsyQueue builds deduplication into the system at two levels: **enqueue-level** and **processing-level**.

### Enqueue-Level Deduplication (Idempotency Keys)

```ts
// First enqueue
const jobId = await q.enqueue('payment.charge', { orderId: 'ord_123', amount: 99 }, {
  idempotencyKey: 'charge_ord_123'
})
// → Creates the job, returns job ID

// Same key again (network retry, webhook duplicate, etc.)
const sameJobId = await q.enqueue('payment.charge', { orderId: 'ord_123', amount: 99 }, {
  idempotencyKey: 'charge_ord_123'
})
// → Returns the EXISTING job ID. No duplicate created.
```

**Configuration:**

```ts
q.use(exactlyOnce({
  // How long to remember idempotency keys
  window: '24h',

  // Where to store dedup keys
  // Default: uses the registered backend
  // Override for performance (e.g., Redis for dedup even with Postgres backend)
  store: 'backend',

  // What happens on duplicate detection — CONFIGURABLE
  onDuplicate: 'ignore',       // silently return existing job ID (default)
  // OR
  onDuplicate: 'reject',       // throw DuplicateJobError
  // OR
  onDuplicate: async (ctx, existingJob) => {
    // Custom: update existing job's payload
    await ctx.updateJob(existingJob.id, { payload: ctx.job.payload })
  },

  // Key cleanup
  cleanup: 'auto',
  cleanupInterval: '1h'
}))
```

### Processing-Level Deduplication (Completion Tokens)

Idempotency keys prevent duplicate **enqueue**. But what about duplicate **processing**? This happens when:
- Worker A picks up a job, processes it, but crashes before acking
- The job's lock expires
- Worker B picks up the same job and processes it again

PsyQueue uses **completion tokens** to prevent this:

```
1. Worker dequeues job → gets a unique completionToken
2. Worker processes job
3. Worker calls ack(jobId, completionToken)
4. Backend atomically: IF token matches stored token → mark complete
                       IF token doesn't match → job was already completed by another worker
                       → return { alreadyCompleted: true }
```

This is transparent to job handlers. They don't need to know about completion tokens.

### Workflow-Level Deduplication

In workflow DAGs, a completing step triggers downstream steps. If the triggering step is retried (e.g., crash after completion but before recording), it could enqueue children twice.

PsyQueue auto-generates idempotency keys for workflow transitions:

```
Key format: {workflowId}:{stepId}:{attempt}

Example: wf_01JARQ5Z:payment:1
```

This ensures each workflow step is enqueued exactly once per attempt, even under crash-recovery scenarios.

---

## 11. Deadline-Aware Dynamic Priority & Job Fusion

### Dynamic Priority

Static priority levels are insufficient for real-world systems. A "medium priority" job that was fine 2 hours ago might be critical now because its deadline is approaching.

The deadline-priority plugin continuously recalculates job priorities based on time remaining.

**Configuration:**

```ts
q.use(deadlinePriority({
  // How aggressively to boost priority as deadline approaches
  urgencyCurve: 'exponential',

  // When to start boosting (fraction of time remaining)
  boostThreshold: 0.5,           // start at 50% time remaining

  // Ceiling for auto-boosted priority (leave room for manual overrides)
  maxBoost: 95,

  // How often to recalculate priorities
  interval: 5000,                // every 5 seconds

  // What happens when a deadline is missed — CONFIGURABLE
  onDeadlineMiss: 'process-anyway',    // default: still run it, late is better than never
  // OR
  onDeadlineMiss: 'fail',             // mark as failed
  // OR
  onDeadlineMiss: 'move-to-dead-letter',
  // OR
  onDeadlineMiss: async (ctx) => {
    await ctx.enqueue('report.generate.fallback', ctx.job.payload)
  }
}))
```

**Built-in urgency curves:**

| Curve | Behavior |
|-------|----------|
| `linear` | Priority increases steadily as time runs out |
| `exponential` | Priority increases slowly at first, then rapidly near deadline |
| `step` | Priority jumps at fixed intervals (25% remaining, 10% remaining, etc.) |
| `custom` | User-provided function |

**Example timeline (exponential curve):**

```
Job: generate-report
  Created: 10:00 AM  |  Base Priority: 30  |  Deadline: 12:00 PM

  10:00  priority: 30   (2h remaining, no boost — above threshold)
  11:00  priority: 30   (1h remaining, 50% threshold reached, boost begins)
  11:30  priority: 55   (curve accelerating)
  11:45  priority: 78   (getting urgent)
  11:55  priority: 92   (almost out of time)
  12:00  priority: 95   |  status: DEADLINE_MISSED  |  configured action runs
```

**Custom urgency curve:**

```ts
deadlinePriority({
  urgencyCurve: (timeRemainingPct, basePriority) => {
    if (timeRemainingPct < 0.1) return 95    // last 10%: maximum urgency
    if (timeRemainingPct < 0.3) return basePriority * 2
    return basePriority
  }
})
```

### Job Fusion / Auto-Batching

When many identical or similar jobs are enqueued in a short window, PsyQueue can automatically merge them into a single batch operation. This reduces API calls, database writes, and processing overhead.

**Configuration:**

```ts
q.use(jobFusion({
  rules: [
    {
      // Which jobs can be fused
      match: 'notification.push',

      // Grouping key — jobs with the same group key can fuse together
      groupBy: (job) => job.payload.userId,

      // Time window to collect jobs before fusing
      window: 5000,              // 5 seconds

      // Maximum batch size
      maxBatch: 100,

      // How to merge multiple payloads into one
      fuse: (jobs) => ({
        userId: jobs[0].payload.userId,
        messages: jobs.map(j => j.payload.message),
        count: jobs.length
      })
    },
    {
      match: 'analytics.track',
      groupBy: (job) => job.payload.eventType,
      window: 10_000,
      maxBatch: 500,
      fuse: (jobs) => ({
        eventType: jobs[0].payload.eventType,
        events: jobs.map(j => j.payload),
        batchSize: jobs.length
      })
    }
  ]
}))
```

**How fusion works:**

1. Job enters the `enqueue` middleware pipeline
2. Job fusion plugin checks if a matching rule exists
3. If yes, the job is buffered in a pending batch (keyed by `groupBy` result)
4. A timer starts for the configured `window` duration
5. Additional matching jobs extend the batch (up to `maxBatch`)
6. When the timer fires OR `maxBatch` is reached, the plugin:
   - Calls the `fuse` function with all buffered jobs
   - Enqueues a single fused job with the merged payload
   - Links original job IDs to the fused job (for status tracking)
7. When the fused job completes, all original jobs are marked complete

**Before fusion:** 1000 `notification.push` jobs → 1000 individual API calls
**After fusion:** 1000 jobs → 10 batched calls of 100 notifications each

**Non-payload field merge strategy for fused jobs:**
- **priority:** Inherits the highest priority from all fused jobs
- **deadline:** Inherits the earliest (most urgent) deadline
- **tenantId:** Jobs can only fuse within the same tenant. Cross-tenant fusion is never applied.
- **idempotencyKey:** The fused job gets a new composite key: `fused:{groupKey}:{windowTimestamp}`
- **meta:** Merged, with later jobs overwriting conflicting keys

**Producers don't need to know about fusion.** They enqueue individual jobs normally. Fusion is transparent.

---

## 12. Observability — Dashboard, Tracing & Audit Log

### OpenTelemetry Distributed Tracing

Every job automatically carries trace context. The originating HTTP request, job enqueue, processing, and downstream effects are correlated under a single trace.

**Configuration:**

```ts
q.use(otelTracing({
  serviceName: 'psyqueue',
  exporter: 'otlp',                    // or 'jaeger', 'zipkin', 'console'
  endpoint: 'http://collector:4318',

  traceEnqueue: true,
  traceProcess: true,
  traceWorkflowSteps: true,

  attributes: (job) => ({
    'tenant.id': job.tenantId,
    'job.queue': job.queue,
    'job.priority': job.priority
  })
}))
```

**Trace waterfall for a workflow:**

```
HTTP POST /orders ─────────────────────────────────────────────
  └─ enqueue: order.process ──────────────────────────────────
       └─ step: validate ████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
       └─ step: payment  ░░░░░░░████████░░░░░░░░░░░░░░░░░░░░░
       └─ step: inventory░░░░░░░██████░░░░░░░░░░░░░░░░░░░░░░░
       └─ step: ship     ░░░░░░░░░░░░░░░████████░░░░░░░░░░░░░
       └─ step: notify   ░░░░░░░░░░░░░░░░░░░░░░░███░░░░░░░░░░
```

Viewable in Jaeger, Grafana Tempo, or any OTel-compatible backend.

### Prometheus Metrics

```ts
q.use(metrics({
  exporter: 'prometheus',     // or 'otlp', 'statsd', custom function
  port: 9090                  // serves /metrics endpoint
}))
```

**Auto-emitted metrics (all labeled by queue, tenant, job name):**

| Metric | Type | Description |
|--------|------|-------------|
| `psyqueue_jobs_enqueued_total` | Counter | Total jobs enqueued |
| `psyqueue_jobs_completed_total` | Counter | Total jobs completed |
| `psyqueue_jobs_failed_total` | Counter | Total jobs failed |
| `psyqueue_jobs_retried_total` | Counter | Total retry attempts |
| `psyqueue_jobs_dead_lettered_total` | Counter | Total dead-lettered |
| `psyqueue_job_duration_ms` | Histogram | Processing time distribution |
| `psyqueue_job_wait_time_ms` | Histogram | Time from enqueue to process start |
| `psyqueue_queue_depth` | Gauge | Pending jobs per queue |
| `psyqueue_active_workers` | Gauge | Currently processing jobs |
| `psyqueue_circuit_state` | Gauge | 0=closed, 1=open, 2=half-open |
| `psyqueue_backpressure_level` | Gauge | 0=healthy, 1=pressure, 2=critical |
| `psyqueue_fusion_ratio` | Gauge | Jobs fused / jobs received |
| `psyqueue_deadline_miss_total` | Counter | Deadline misses |
| `psyqueue_tenant_rate_limit_usage` | Gauge | Current rate / max rate per tenant |

### Immutable Audit Log

Every job state transition is recorded in an append-only log. The log uses hash chaining for tamper detection — each entry includes a hash of the previous entry.

**Configuration:**

```ts
q.use(auditLog({
  // Storage backend for the audit log
  store: 'backend',            // uses registered backend
  // OR
  store: postgres({ connectionString: '...' }),  // dedicated audit DB
  // OR
  store: 'file',               // append-only JSON lines
  filePath: './audit.jsonl',

  // Which events to log
  events: 'all',               // or specific: ['enqueued', 'started', 'completed', 'failed']

  // Privacy: include job payload in log?
  includePayload: false,       // default: false (PII protection)

  // Retention policy
  retention: '90d',            // auto-prune entries older than 90 days

  // Tamper detection
  hashChain: true              // each entry includes hash of previous entry
}))
```

**Audit log entry structure:**

```json
{
  "id": "01JARQ5ZXKM3JGFWZWHQE3XNHP",
  "timestamp": "2026-03-19T14:30:00.123Z",
  "event": "job:completed",
  "jobId": "01JARQ5ZXKM3JGFWZWHQE3XABC",
  "jobName": "payment.charge",
  "queue": "payments",
  "tenantId": "tenant_acme",
  "workerId": "worker-3",
  "attempt": 1,
  "duration": 234,
  "prevHash": "sha256:abc123def456...",
  "hash": "sha256:789ghi012jkl..."
}
```

**Hash chain verification:**

```bash
npx psyqueue audit verify --from 2026-03-01 --to 2026-03-19
# ✓ 142,857 entries verified. Chain intact.

npx psyqueue audit verify --from 2026-03-01 --to 2026-03-19
# ✗ Chain broken at entry #45,231. Entry hash does not match expected.
# Tampered entries: 45,231 through 45,235
```

**Querying the audit log:**

```ts
const entries = await q.audit.query({
  jobId: 'job_123',           // specific job
  tenantId: 'tenant_acme',   // specific tenant
  event: 'job:failed',       // specific event type
  from: '2026-03-18',
  to: '2026-03-19',
  limit: 100
})
```

### Dashboard (React + Vite)

The dashboard ships as `@psyqueue/dashboard` — a plugin that starts a web server from the queue process.

**Configuration:**

```ts
q.use(dashboard({
  port: 4000,
  basePath: '/dashboard',      // serve at custom path
  auth: {
    type: 'basic',             // simple username/password
    user: 'admin',
    pass: process.env.DASH_PASS
  }
  // Other auth options:
  // auth: { type: 'bearer', tokens: ['secret-1', 'secret-2'] }
  // auth: { type: 'custom', middleware: (req, res, next) => { /* your auth logic */ } }
  // OAuth/OIDC support is planned for a future version.
}))
```

**Dashboard pages:**

| Page | Purpose |
|------|---------|
| **Overview** | Real-time queue depths, throughput graph, error rate, backpressure gauge, system health |
| **Queues** | Per-queue stats. Drill into pending/active/failed/dead jobs. Pause/resume queues. |
| **Jobs** | Search and filter any job. View payload, error stack, trace link, retry history. One-click retry. |
| **Workflows** | Visual DAG for each workflow instance. Step status, timing, results. Compensation history. |
| **Tenants** | Per-tenant metrics: throughput, latency, queue depth, rate limit usage. Override controls. |
| **Circuits** | Circuit breaker states with failure history. Manual open/close/reset. |
| **Audit** | Searchable audit log. Integrity verification status. Export capability. |
| **Actions** | Bulk operations: retry all failed, replay from dead letter, drain queue, purge completed. |

---

## 13. Polyglot Workers

### Overview

The core PsyQueue engine runs in Node.js. But workers — the processes that execute jobs — can be written in any language. PsyQueue provides two transport protocols for remote workers.

### gRPC Protocol (Primary)

High-performance, typed, binary protocol. Best for production workloads.

**Service definition:**

```protobuf
syntax = "proto3";
package psyqueue.v1;

service PsyQueueWorker {
  // Worker pulls available jobs. The stream delivers up to `count` jobs
  // and then completes (one-shot). For continuous delivery, workers
  // reconnect with a new FetchJobs call after processing.
  rpc FetchJobs(FetchRequest) returns (stream Job);

  // Worker reports successful completion
  rpc Ack(AckRequest) returns (AckResponse);

  // Worker reports failure / requests requeue
  rpc Nack(NackRequest) returns (NackResponse);

  // Worker sends periodic heartbeat (prevents stale lock expiry)
  rpc Heartbeat(HeartbeatRequest) returns (HeartbeatResponse);

  // Worker registers its capabilities on connect
  rpc Register(WorkerInfo) returns (RegisterResponse);
}

message FetchRequest {
  string queue = 1;        // which queue to pull from
  int32 count = 2;         // max jobs to fetch
  string worker_id = 3;    // unique worker identifier
}

message Job {
  string id = 1;
  string queue = 2;
  string name = 3;
  bytes payload = 4;       // JSON-encoded payload
  int32 attempt = 5;
  int32 max_retries = 6;
  int32 timeout = 7;
  string trace_id = 8;
  string span_id = 9;
  map<string, string> meta = 10;
}

message AckRequest {
  string job_id = 1;
  string completion_token = 2;
  bytes result = 3;        // JSON-encoded result
}

message NackRequest {
  string job_id = 1;
  string reason = 2;
  bool requeue = 3;
  int32 delay = 4;         // ms
}

message HeartbeatRequest {
  string worker_id = 1;
  repeated string active_job_ids = 2;
}

message WorkerInfo {
  string worker_id = 1;
  repeated string queues = 2;      // which queues this worker handles
  int32 concurrency = 3;           // how many jobs it can process simultaneously
  string language = 4;             // "python", "go", "rust", etc.
  map<string, string> labels = 5;  // custom labels for routing
}
```

**Server-side configuration:**

```ts
q.use(grpcWorkers({
  port: 50051,
  auth: 'token',                 // or 'mtls', 'none'
  tokens: ['worker-secret-1'],
  queues: ['*']                  // which queues accept remote workers
}))
```

**Example: Python worker:**

```python
from psyqueue import Worker

worker = Worker("localhost:50051", token="worker-secret-1")

@worker.handle("ml.predict")
def predict(job):
    result = model.predict(job.payload["input"])
    return {"prediction": result, "confidence": 0.95}

worker.start(concurrency=4)
```

**Example: Go worker:**

```go
package main

import "github.com/psyqueue/worker-go"

func main() {
    w := worker.New("localhost:50051", worker.WithToken("worker-secret-1"))

    w.Handle("data.transform", func(ctx worker.Context) (any, error) {
        input := ctx.Payload()
        result := transform(input)
        return result, nil
    })

    w.Start(worker.WithConcurrency(8))
}
```

### HTTP Transport (Adapter)

For simplicity and maximum language compatibility. Any language with HTTP support can be a worker — no SDK required.

**Server-side configuration:**

```ts
q.use(httpWorkers({
  port: 8080,
  auth: { type: 'bearer', tokens: ['worker-secret-1'] },
  queues: ['*']
}))
```

**REST endpoints:**

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/workers/register` | Register a worker with capabilities |
| `GET` | `/jobs/fetch?queue=email.send&count=5` | Fetch available jobs |
| `POST` | `/jobs/{id}/ack` | Mark job as completed |
| `POST` | `/jobs/{id}/nack` | Report failure / request requeue |
| `POST` | `/jobs/{id}/heartbeat` | Extend job lock |

**Example: cURL worker (any language with HTTP):**

```bash
# Fetch a job
JOB=$(curl -s -H "Authorization: Bearer worker-secret-1" \
  "http://localhost:8080/jobs/fetch?queue=email.send&count=1")

# Process it (your logic here)
RESULT=$(process_job "$JOB")

# Ack completion
curl -s -X POST -H "Authorization: Bearer worker-secret-1" \
  -d "{\"result\": $RESULT}" \
  "http://localhost:8080/jobs/$(echo $JOB | jq -r '.id')/ack"
```

---

## 14. Chaos Testing

### Overview

Test job processing against real distributed system failures without deploying to production. The chaos plugin injects controlled failures into the middleware pipeline.

**Configuration:**

```ts
q.use(chaosMode({
  // Only enable in test environments
  enabled: process.env.NODE_ENV === 'test',

  scenarios: {
    // Simulate slow processing
    slowProcess: {
      probability: 0.1,            // 10% of jobs
      delay: [1000, 5000]          // random 1-5s delay
    },

    // Simulate worker crash mid-processing
    workerCrash: {
      probability: 0.05,
      timing: 'mid-process'        // crash after start, before ack
    },

    // Simulate duplicate delivery
    duplicateDelivery: {
      probability: 0.08
    },

    // Simulate network partition (workers can't reach backend)
    networkPartition: {
      probability: 0.03,
      duration: [5000, 15000]      // 5-15s partition
    },

    // Simulate backend outage
    backendOutage: {
      probability: 0.01,
      duration: [10000, 30000]
    },

    // Simulate clock skew between nodes
    clockSkew: {
      probability: 0.1,
      drift: [-5000, 5000]         // ±5s drift
    }
  }
}))
```

### Controlled Chaos Runs

Run a specific failure scenario deterministically and get a report:

```ts
import { chaosRun } from '@psyqueue/plugin-chaos'

const report = await chaosRun(q, {
  scenario: 'worker-crash-during-workflow',
  jobs: 100,
  duration: '60s'
})

console.log(report)
// {
//   jobsEnqueued: 100,
//   jobsCompleted: 97,
//   jobsRecovered: 3,        // crashed and auto-recovered
//   jobsLost: 0,             // zero data loss ✓
//   duplicateProcessing: 0,  // exactly-once held ✓
//   avgRecoveryTime: 2340,   // ms to recover crashed jobs
//   timeline: [...]          // detailed event log
// }
```

### Scenario Library

| Scenario | What It Tests |
|----------|--------------|
| `worker-crash-during-workflow` | Crash recovery + workflow resumption |
| `network-partition-during-ack` | Completion token handling, zombie prevention |
| `duplicate-delivery-storm` | Exactly-once guarantees under heavy duplication |
| `backend-outage-and-recovery` | WAL durability, job recovery after restart |
| `clock-skew-with-scheduling` | Scheduled jobs accuracy under time drift |
| `noisy-neighbor-burst` | Multi-tenant fair scheduling under load |
| `circuit-breaker-cascade` | Cascading failures across dependencies |
| `deadline-under-backpressure` | Priority boosting when system is overloaded |

---

## 15. Offline-First Sync

### Overview

For IoT devices, mobile backends, and regions with unreliable connectivity, PsyQueue can queue jobs locally and synchronize to a remote server when connectivity is available.

**Configuration:**

```ts
q.use(offlineSync({
  // Local buffer uses its own independent embedded SQLite instance.
  // This is NOT the registered backend — it is a dedicated local buffer
  // managed entirely by the offline-sync plugin, separate from any
  // SQLite/Redis/Postgres backend the queue is configured with.
  localPath: './psyqueue-offline.db',

  // Remote PsyQueue server (gRPC or HTTP)
  remote: 'grpc://queue.prod.example.com:50051',

  // Sync strategy
  sync: {
    mode: 'opportunistic',       // sync whenever connection is available
    // OR
    mode: 'scheduled',           // sync on interval
    interval: 30_000,            // every 30s
    // OR
    mode: 'manual'               // user triggers sync programmatically
  },

  // Conflict resolution when local and remote have the same idempotency key
  onConflict: 'remote-wins',     // or 'local-wins', 'merge', or custom function

  // Buffer limits
  maxLocalJobs: 10_000,
  onBufferFull: 'drop-lowest-priority'   // or 'reject', 'rotate'
}))
```

### Sync Flow

```
Device (offline)                        Server
  |                                       |
  ├─ enqueue job A ──→ local SQLite       |
  ├─ enqueue job B ──→ local SQLite       |
  ├─ enqueue job C ──→ local SQLite       |
  |                                       |
  | ── connection restored ──             |
  |                                       |
  ├─ sync batch [A, B, C] ──────────────→|
  |                                       ├─ dedup by idempotency keys
  |                                       ├─ enqueue A, B, C to remote queue
  |◄── ack [A, B, C] synced ────────────┤
  ├─ clear local buffer                   |
```

**Key behaviors:**
- Jobs enqueued offline automatically receive idempotency keys (if not provided), so retried syncs don't create duplicates
- Sync batches are sent in order (FIFO by creation time)
- If sync fails mid-batch, only successfully synced jobs are cleared from local buffer
- Connection health is monitored with exponential backoff on failures

### Manual Sync Trigger

```ts
// Programmatically trigger sync
const result = await q.sync.push()
// { synced: 47, failed: 0, remaining: 0 }

// Check sync status
const status = await q.sync.status()
// { connected: true, localBuffered: 0, lastSyncAt: '...', lastError: null }
```

---

## 16. Crash Recovery & Error Handling

### Write-Ahead Log (WAL)

The crash recovery plugin uses a write-ahead log to survive ungraceful shutdowns. Before any state change, the intended change is written to the WAL. On restart, the WAL is replayed to recover.

**Configuration:**

```ts
q.use(crashRecovery({
  walPath: './psyqueue.wal',
  flushInterval: 100,             // ms between WAL flushes
  autoRecover: true,              // automatically recover on startup

  // What to do with jobs that were mid-process when crash happened — CONFIGURABLE
  onRecoverActiveJob: 'requeue',   // default: put back in queue
  // OR
  onRecoverActiveJob: 'fail',     // mark as failed
  // OR
  onRecoverActiveJob: async (job) => {
    if (job.attempt >= job.maxRetries) return 'dead-letter'
    return 'requeue'
  },

  // Graceful shutdown behavior
  shutdownTimeout: 30_000,        // wait 30s for active jobs to finish
  onShutdownTimeout: 'requeue'    // or 'force-kill', 'wait-indefinitely'
}))
```

**Recovery flow:**

```
Normal operation:
  1. Dequeue job → WAL: { jobId, status: 'active', workerId, timestamp }
  2. Process job
  3. Ack job → WAL: { jobId, status: 'completed', timestamp }
  4. WAL flushes to backend periodically

Crash at step 2:
  1. Process restarts
  2. Kernel reads WAL
  3. Finds jobs with 'active' but no corresponding 'completed'
  4. Runs onRecoverActiveJob policy for each
  5. Emits event: job:recovered { jobId, attempt: N+1 }
  6. Dashboard shows recovery in job timeline
```

### Error Classification

PsyQueue classifies errors to determine the correct retry behavior. Users configure this per-handler.

```ts
q.handle('payment.charge', handler, {
  errors: {
    transient: {
      match: (err) => err.code === 'ECONNREFUSED' || err.status === 503,
      action: 'retry',
      backoff: 'exponential',
      maxRetries: 5
    },
    rateLimit: {
      match: (err) => err.status === 429,
      action: 'retry',
      backoff: (err) => parseInt(err.headers['retry-after']) * 1000,
      maxRetries: 10
    },
    validation: {
      match: (err) => err instanceof ValidationError,
      action: 'dead-letter',
      maxRetries: 0
    },
    fatal: {
      match: (err) => err.code === 'ACCOUNT_CLOSED',
      action: 'fail',
      notify: true
    },
    unknown: {
      action: 'retry',
      backoff: 'exponential',
      maxRetries: 3
    }
  }
})
```

### Dead Letter Queue

Jobs that exhaust retries or hit non-retryable errors enter the dead letter queue. PsyQueue's DLQ is queryable and actionable.

```ts
// Query dead-lettered jobs with filters
const deadJobs = await q.deadLetter.list({
  queue: 'payment.*',
  errorCode: 'SCHEMA_MISMATCH',
  tenantId: 'tenant_123',
  from: '2026-03-18',
  to: '2026-03-19'
})

// Replay a single job
await q.deadLetter.replay(jobId)

// Replay all matching jobs (e.g., after deploying a fix)
await q.deadLetter.replayAll({
  queue: 'payment.charge',
  errorCode: 'TIMEOUT',
  modifyPayload: (payload) => ({ ...payload, timeout: 60_000 })
})

// Purge old dead letters
await q.deadLetter.purge({ olderThan: '30d' })
```

### Graceful Shutdown

On `SIGTERM` / `SIGINT`:

1. Stop accepting new jobs
2. Wait for active jobs to complete (up to `shutdownTimeout`)
3. Jobs that don't finish within timeout → handled per `onShutdownTimeout` config
4. Flush WAL
5. Close backend connections
6. Emit `kernel:stopped` event
7. Process exits

---

## 17. Package Structure

### Monorepo Layout

```
psyqueue/
├── packages/
│   ├── core/                          # The micro-kernel
│   │   ├── src/
│   │   │   ├── kernel.ts              # Event bus, plugin registry, middleware pipeline
│   │   │   ├── context.ts             # JobContext implementation
│   │   │   ├── types.ts               # Shared type definitions
│   │   │   ├── errors.ts              # PsyQueueError hierarchy
│   │   │   ├── job.ts                 # Job creation, ULID generation
│   │   │   └── presets.ts             # lite, saas, enterprise presets
│   │   ├── package.json               # "psyqueue"
│   │   └── tsconfig.json
│   │
│   ├── backend-sqlite/                # @psyqueue/backend-sqlite
│   ├── backend-redis/                 # @psyqueue/backend-redis
│   ├── backend-postgres/              # @psyqueue/backend-postgres
│   │
│   ├── plugin-scheduler/              # @psyqueue/plugin-scheduler
│   ├── plugin-deadline-priority/      # @psyqueue/plugin-deadline-priority
│   ├── plugin-workflows/              # @psyqueue/plugin-workflows
│   ├── plugin-saga/                   # @psyqueue/plugin-saga
│   ├── plugin-job-fusion/             # @psyqueue/plugin-job-fusion
│   ├── plugin-tenancy/                # @psyqueue/plugin-tenancy
│   ├── plugin-rate-limiter/           # @psyqueue/plugin-rate-limiter
│   ├── plugin-circuit-breaker/        # @psyqueue/plugin-circuit-breaker
│   ├── plugin-backpressure/           # @psyqueue/plugin-backpressure
│   ├── plugin-exactly-once/           # @psyqueue/plugin-exactly-once
│   ├── plugin-crash-recovery/         # @psyqueue/plugin-crash-recovery
│   ├── plugin-otel-tracing/           # @psyqueue/plugin-otel-tracing
│   ├── plugin-metrics/                # @psyqueue/plugin-metrics
│   ├── plugin-audit-log/              # @psyqueue/plugin-audit-log
│   ├── plugin-schema-versioning/      # @psyqueue/plugin-schema-versioning
│   ├── plugin-grpc-workers/           # @psyqueue/plugin-grpc-workers
│   ├── plugin-http-workers/           # @psyqueue/plugin-http-workers
│   ├── plugin-chaos/                  # @psyqueue/plugin-chaos
│   ├── plugin-offline-sync/           # @psyqueue/plugin-offline-sync
│   │
│   ├── dashboard/                     # @psyqueue/dashboard (React + Vite)
│   │   ├── src/
│   │   │   ├── pages/                 # Overview, Queues, Jobs, Workflows, Tenants, etc.
│   │   │   ├── components/            # Shared UI components
│   │   │   └── api/                   # Dashboard API client
│   │   └── package.json
│   │
│   └── cli/                           # @psyqueue/cli
│       ├── src/
│       │   ├── commands/
│       │   │   ├── migrate.ts         # Backend migration
│       │   │   ├── audit.ts           # Audit log verification
│       │   │   └── replay.ts          # Dead letter replay
│       └── package.json
│
├── proto/                             # gRPC protocol definitions
│   └── psyqueue/v1/worker.proto
│
├── examples/                          # Usage examples
│   ├── basic/                         # Minimal setup
│   ├── saas-multi-tenant/             # Multi-tenant SaaS
│   ├── workflow-saga/                 # Order processing workflow
│   ├── polyglot/                      # Python + Go workers
│   └── offline-sync/                  # IoT offline-first
│
├── docker-compose.yml                 # Redis + Postgres + Jaeger for local dev
├── turbo.json                         # Turborepo config for monorepo
├── package.json                       # Root workspace config
└── tsconfig.base.json                 # Shared TypeScript config
```

### npm Package Names

| Package | Description |
|---------|-------------|
| `psyqueue` | Core kernel — the only required package |
| `@psyqueue/backend-sqlite` | SQLite storage backend |
| `@psyqueue/backend-redis` | Redis storage backend |
| `@psyqueue/backend-postgres` | PostgreSQL storage backend |
| `@psyqueue/plugin-scheduler` | Delayed and cron job scheduling |
| `@psyqueue/plugin-deadline-priority` | Dynamic priority based on deadlines |
| `@psyqueue/plugin-workflows` | DAG workflow orchestration |
| `@psyqueue/plugin-saga` | Compensation logic for workflows |
| `@psyqueue/plugin-job-fusion` | Auto-batching identical jobs |
| `@psyqueue/plugin-tenancy` | Multi-tenant isolation and fair scheduling |
| `@psyqueue/plugin-rate-limiter` | Per-tenant/queue rate limiting |
| `@psyqueue/plugin-circuit-breaker` | Per-dependency circuit breakers |
| `@psyqueue/plugin-backpressure` | Adaptive concurrency and load shedding |
| `@psyqueue/plugin-exactly-once` | Idempotency keys and dedup |
| `@psyqueue/plugin-crash-recovery` | WAL-based crash recovery |
| `@psyqueue/plugin-otel-tracing` | OpenTelemetry distributed tracing |
| `@psyqueue/plugin-metrics` | Prometheus/OTLP metrics |
| `@psyqueue/plugin-audit-log` | Hash-chained immutable audit log |
| `@psyqueue/plugin-schema-versioning` | Versioned job payloads with Zod |
| `@psyqueue/plugin-grpc-workers` | gRPC transport for remote workers |
| `@psyqueue/plugin-http-workers` | HTTP/REST transport for remote workers |
| `@psyqueue/plugin-chaos` | Chaos testing and failure simulation |
| `@psyqueue/plugin-offline-sync` | Offline-first with sync |
| `@psyqueue/dashboard` | React + Vite monitoring dashboard |
| `@psyqueue/cli` | CLI tools (migrate, audit, replay) |

---

## 18. Standards & Non-Functional Requirements

These standards apply to every package in the PsyQueue monorepo.

### Code Quality

- **Language:** TypeScript (strict mode)
- **Module System:** ESM only (Node.js 20+)
- **Linting:** ESLint with strict TypeScript rules
- **Formatting:** Prettier
- **Type Coverage:** 100% — no `any` types except at system boundaries

### Testing

- **Unit Tests:** Every function, every middleware, every plugin
- **Integration Tests:** Backend adapters against real SQLite/Redis/Postgres (Docker)
- **Workflow Tests:** End-to-end DAG execution, Saga compensation
- **Chaos Tests:** Built-in chaos mode validates crash recovery, exactly-once, etc.
- **Test Runner:** Node.js native test runner (`node:test`)
- **Coverage Target:** >90% line coverage

### Infrastructure

- **Docker Compose:** Local development with Redis, Postgres, Jaeger, Prometheus
- **CI/CD:** GitHub Actions — lint, test, build, publish
- **Monorepo Tooling:** Turborepo for task orchestration, pnpm workspaces

### Documentation

- **README:** Architecture overview, quick start, API reference links
- **Per-Package README:** Each plugin has its own README with usage examples
- **Examples Directory:** Complete working examples for common use cases

### Security

- **No eval, no dynamic requires**
- **Input validation** at all system boundaries (enqueue payloads, API inputs, config)
- **Auth support** on all transport layers (gRPC: token/mTLS, HTTP: bearer, Dashboard: basic auth)
- **Audit log** for compliance-sensitive environments
- **No secrets in logs** — payload redaction is configurable

### Error Handling

- **Custom error hierarchy:** `PsyQueueError` base class with codes
- **Structured errors:** Every error has `code`, `message`, `context`
- **No uncaught exceptions** — all async operations are properly caught
- **Graceful degradation** — the kernel stays up even if individual plugins fail

### Performance Targets

| Metric | SQLite | Redis | Postgres |
|--------|--------|-------|----------|
| Enqueue throughput | ~1K/sec | ~100K/sec | ~10K/sec |
| Dequeue latency (p50) | <5ms | <1ms | <10ms |
| Kernel overhead per job | <0.5ms | <0.5ms | <0.5ms |
| Memory (kernel + 1 backend) | <50MB | <50MB | <50MB |

### Versioning & Compatibility

- **Kernel API** follows semver. Breaking changes to `PsyPlugin`, `BackendAdapter`, `JobContext`, or `Middleware` types increment the major version.
- **Plugin contract** includes a `version` field. Plugins declare which kernel version range they support via `peerDependencies` in their `package.json`.
- **Backend adapters** are versioned independently of the kernel and of each other.
- **gRPC protocol** uses package versioning (`psyqueue.v1`). Breaking protocol changes publish a new version (`psyqueue.v2`) while maintaining backward compatibility for at least one major release.
- **Presets** pin specific plugin version ranges to ensure tested combinations.

### Deployment

- **Environment Config:** `.env.example` with all configurable values
- **Docker:** Multi-stage Dockerfile for production builds
- **Health Check Endpoint:** `/health` via dashboard or standalone
- **Signals:** Graceful shutdown on SIGTERM/SIGINT
