# PsyQueue Examples

Comprehensive usage examples covering every major feature of PsyQueue and its plugin ecosystem.

Each example is a standalone TypeScript file runnable with:

```sh
npx tsx examples/<folder>/index.ts
```

---

## Index

| # | Folder | Title | What it covers |
|---|--------|-------|----------------|
| 01 | `01-basic-queue` | Basic Queue | Core enqueue/process loop, priority, named queues, `enqueueBulk`, lifecycle events |
| 02 | `02-delayed-and-cron` | Delayed Jobs & Cron | `runAt` future scheduling, cron expressions, scheduler plugin polling |
| 03 | `03-retry-and-dead-letter` | Retry & Dead Letter | Exponential/fixed/linear backoff, dead letter listing, replay, replayAll, purge |
| 04 | `04-workflow-dag` | Workflow DAG | Multi-step DAG with parallel branches, fan-in dependencies, conditional steps, `ctx.results` |
| 05 | `05-saga-compensation` | Saga Compensation | Automatic reverse-order compensation when a workflow step fails |
| 06 | `06-multi-tenant-saas` | Multi-Tenant SaaS | Three-tier tenancy, sliding-window rate limits, weighted fair scheduling, runtime tier upgrade |
| 07 | `07-circuit-breaker` | Circuit Breaker | CLOSED → OPEN → HALF_OPEN → CLOSED transitions, `ctx.breaker()`, requeue on open |
| 08 | `08-schema-versioning` | Schema Versioning | Versioned handlers, v1→v2 payload migration, Zod validation, dead-lettering invalid schemas |
| 09 | `09-exactly-once` | Exactly-Once | Idempotency keys, ignore vs reject modes, `DuplicateJobError`, dedup window |
| 10 | `10-backpressure` | Backpressure | Queue depth & error-rate signals, PRESSURE/CRITICAL states, concurrency throttling, recovery |
| 11 | `11-audit-log` | Audit Log | Hash-chained audit trail, tamper detection, event/jobId/time-range queries, `verify()` |
| 12 | `12-job-fusion` | Job Fusion | Auto-batching 100 notification jobs into 10 batches, window & size-based flushing, groupBy |
| 13 | `13-deadline-priority` | Deadline Priority | Urgency curves (linear/exponential/step), priority boost events, deadline-miss dead-lettering |
| 14 | `14-http-workers` | HTTP Workers | External worker HTTP API (dequeue/ack/nack), bearer auth, curl commands, `fetch()` simulation |
| 15 | `15-chaos-testing` | Chaos Testing | slowProcess, workerCrash, duplicateDelivery scenarios; verifying retry and idempotency hold up |
| 16 | `16-full-production` | Full Production | Kitchen-sink: all plugins composed, multi-tenant workflows, circuit breaker, audit, metrics |

---

## Prerequisites

All examples use the in-memory SQLite backend so they work out of the box without any external services.

```sh
# From the repo root
npm install

# Run any example
npx tsx examples/01-basic-queue/index.ts
npx tsx examples/16-full-production/index.ts
```

---

## Plugin Quick Reference

| Plugin | Import | What it provides |
|--------|--------|-----------------|
| SQLite backend | `@psyqueue/backend-sqlite` | In-process durable storage |
| Scheduler | `@psyqueue/plugin-scheduler` | `runAt` delayed jobs and cron |
| Crash recovery | `@psyqueue/plugin-crash-recovery` | WAL-based restart recovery |
| Tenancy | `@psyqueue/plugin-tenancy` | Per-tenant rate limits and fair scheduling |
| Workflows | `@psyqueue/plugin-workflows` | DAG workflow orchestration |
| Saga | `@psyqueue/plugin-saga` | Automatic saga compensation |
| Circuit breaker | `@psyqueue/plugin-circuit-breaker` | External service protection |
| Schema versioning | `@psyqueue/plugin-schema-versioning` | Versioned payload handlers with migration |
| Exactly-once | `@psyqueue/plugin-exactly-once` | Idempotency key deduplication |
| Backpressure | `@psyqueue/plugin-backpressure` | Dynamic concurrency throttling |
| Audit log | `@psyqueue/plugin-audit-log` | Hash-chained tamper-evident event log |
| Metrics | `@psyqueue/plugin-metrics` | Prometheus-compatible counters and histograms |
| Deadline priority | `@psyqueue/plugin-deadline-priority` | Urgency-based priority boosting |
| Job fusion | `@psyqueue/plugin-job-fusion` | Auto-batching of similar jobs |
| HTTP workers | `@psyqueue/plugin-http-workers` | External worker HTTP polling API |
| Chaos | `@psyqueue/plugin-chaos` | Fault injection for resilience testing |

---

## Key Concepts

### Enqueue options

```ts
await q.enqueue('job-name', payload, {
  queue: 'high-priority',          // Named queue (default: 'default')
  priority: 10,                    // Higher = processed first
  tenantId: 'tenant-acme',        // Enables multi-tenant rate limiting
  idempotencyKey: 'unique-key',   // Prevents duplicate processing
  maxRetries: 3,                   // Retry attempts on failure
  backoff: 'exponential',          // 'fixed' | 'exponential' | 'linear' | fn
  backoffBase: 1000,               // Base delay in ms
  backoffCap: 60_000,              // Maximum delay cap in ms
  deadline: new Date(Date.now() + 60_000), // SLA deadline
  runAt: new Date(Date.now() + 5_000),     // Delayed execution
  cron: '0 * * * *',              // Recurring cron expression
  meta: { source: 'api' },        // Arbitrary metadata
})
```

### Job handler

```ts
q.handle('job-name', async (ctx) => {
  // ctx.job       — full job object (id, payload, attempt, meta, …)
  // ctx.results   — results from prior workflow steps
  // ctx.tenant    — tenant info (id, tier) if tenancy plugin is loaded
  // ctx.breaker() — circuit-breaker-wrapped async call
  // ctx.requeue() — manually requeue this job
  // ctx.deadLetter('reason') — manually move to dead letter
  // ctx.enqueue() — enqueue child jobs
  // ctx.log       — structured logger

  return { result: 'value' }  // Return value stored as job.result
})
```

### Dead letter management

```ts
const list = await q.deadLetter.list({ queue: 'default' })
await q.deadLetter.replay(jobId)       // Replay a single dead job
const count = await q.deadLetter.replayAll({ queue: 'payments' })
const purged = await q.deadLetter.purge({ before: new Date() })
```

### Lifecycle events

```
job:enqueued   job:started   job:completed
job:failed     job:retry     job:dead
job:requeued   job:replayed
workflow:completed   workflow:failed   workflow:compensated
circuit:open   circuit:half-open   circuit:close
backpressure:pressure   backpressure:critical   backpressure:healthy
tenancy:rate-limited
job:fused      job:priority-boosted   job:deadline-missed
chaos:enabled  http:listening
kernel:started kernel:stopped
```
