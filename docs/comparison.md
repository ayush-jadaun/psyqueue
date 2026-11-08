# PsyQueue vs Alternatives

## What category PsyQueue is in

PsyQueue is a **job queue library for Node.js/TypeScript**: you enqueue named jobs, workers process them with retries, backoff, scheduling and priorities, and you can inspect, replay or purge jobs afterwards. On top of that core, plugins add workflow-engine features (DAG workflows, saga compensation) and multi-tenant controls.

That puts it between two groups of tools, and it is only compared against tools that do the same job:

| Group | Tools | Compare on |
|-------|-------|-----------|
| **Job queues** | BullMQ, pg-boss, Graphile Worker | Setup cost, backend choice, throughput, job features |
| **Workflow engines** | Temporal, Inngest | Workflows, compensation, durability, infra cost |

### Why RabbitMQ (and Kafka, NATS, SQS) is not in the matrix

RabbitMQ is a **message broker**, not a job queue. It is a standalone server that routes messages between services in any language (exchanges, routing keys, fan-out, pub/sub). It has no concept of a job: no retry-with-backoff policy, no cron, no job status, no "replay failed job". PsyQueue has no broker features: no exchanges, no cross-language routing, no general pub/sub (its event bus only broadcasts job lifecycle events).

The one real overlap: if you use RabbitMQ *only* as a work queue for background jobs from a Node app, PsyQueue gives you job semantics out of the box without running a broker. If you need inter-service messaging, use a broker — PsyQueue is not a replacement.

Celery (Python) is a job queue, but for a different language ecosystem, so it is not compared here.

## Job queues: PsyQueue vs BullMQ vs pg-boss vs Graphile Worker

| Feature | PsyQueue | BullMQ | pg-boss | Graphile Worker |
|---------|----------|--------|---------|-----------------|
| **Storage** | SQLite / Redis / Postgres | Redis | Postgres | Postgres |
| **Zero-infra start** | Yes (embedded SQLite) | No (needs Redis) | No (needs Postgres) | No (needs Postgres) |
| **Architecture** | Micro-kernel, features are opt-in plugins | Batteries included | Batteries included | Batteries included |
| **Delayed jobs** | Plugin | Built-in | Built-in | Built-in |
| **Cron scheduling** | Plugin | Built-in (job schedulers) | Built-in | Built-in |
| **Priority** | Built-in + deadline-boost plugin | Built-in | Built-in | Built-in |
| **Deduplication** | Plugin (idempotency keys) | Built-in (job ID, deduplication option) | Built-in (singleton keys) | Built-in (job keys) |
| **Rate limiting** | Plugin (per tenant) | Built-in (per queue; per group in BullMQ Pro) | Built-in (throttling) | Manual |
| **Parent/child jobs** | Plugin (DAG workflows, conditional branches) | Built-in (Flows: parent/child trees) | No | No |
| **Saga compensation** | Plugin | No | No | No |
| **Multi-tenant fair scheduling** | Plugin (tiers, per-tenant limits) | BullMQ Pro groups (paid) | No | No |
| **Circuit breaker** | Plugin | No | No | No |
| **Adaptive backpressure** | Plugin | Concurrency + rate limits | Concurrency | Concurrency |
| **OpenTelemetry tracing** | Plugin | Built-in telemetry interface (`bullmq-otel`) | No | No |
| **Metrics** | Plugin (Prometheus) | Built-in metrics API | No | No |
| **Tamper-evident audit log** | Plugin (hash-chained) | No | No | No |
| **Payload schema versioning** | Plugin (Zod + migrations) | No | No | No |
| **Remote workers in other runtimes** | Plugin (gRPC, HTTP) | Workers share Redis (Node, Python, Elixir, PHP clients) | No | No |
| **Dashboard** | Package (`@psyqueue/dashboard`) | Third-party (Bull Board) / paid (Taskforce.sh) | No | No |
| **Maturity / community** | New | Large, widely used in production | Established | Established |

Features that are **unique to PsyQueue** among job queues: saga compensation, circuit breaker, adaptive backpressure, hash-chained audit log, schema versioning, job fusion, chaos testing and offline sync.

## Workflow features: PsyQueue vs Temporal vs Inngest

PsyQueue's workflow plugins cover part of what workflow engines do. They are a lighter option, not a full replacement.

| | PsyQueue (workflows + saga plugins) | Temporal | Inngest |
|---|---|---|---|
| **Model** | DAG of jobs declared with a builder | Durable execution of workflow code | Durable step functions triggered by events |
| **Infra** | Your existing backend (SQLite/Redis/Postgres) | Temporal server cluster or Temporal Cloud | Inngest server (self-host) or Inngest Cloud |
| **Compensation / rollback** | Saga plugin | Saga pattern in workflow code | Manual in step code |
| **Deterministic replay of workflow code** | No | Yes | Partial (step memoization) |
| **Long-running workflows (days/months)** | Possible, not the design focus | Core strength | Core strength |
| **Languages** | TypeScript | Go, Java, TS, Python, .NET, PHP | TS, Python, Go |

If you need Temporal-grade durability for long-running business processes, use Temporal. If you want DAG workflows with rollback inside the job queue you already run, PsyQueue covers that without extra infrastructure.

## Benchmark Results

Run it yourself: `npx tsx benchmarks/fair-vs-bullmq.ts` (needs Redis; set `REDIS_URL` if not on `localhost:6379`).

Method: both libraries use their default worker settings. All jobs are enqueued first, then timed from worker start until every job has completed (after ack). Each run uses its own key prefix so leftovers can't inflate counts. The median of 3 runs is reported, alternating which library runs first.

Measured on Windows 11 with Redis 7 in Docker:

| Scenario | PsyQueue | BullMQ | Ratio |
|----------|----------|--------|-------|
| No-op handler, 10k jobs, concurrency 10 | 5,273 jobs/s | 4,478 jobs/s | 1.18x |
| 5 ms async work, 4k jobs, concurrency 50 | 3,188 jobs/s | 3,131 jobs/s | 1.02x |
| 20 ms async work, 2k jobs, concurrency 50 | 1,603 jobs/s | 1,553 jobs/s | 1.03x |

**How to read this:**

- The no-op row measures pure queue overhead and is noisy: individual runs ranged 4,240–6,124 (PsyQueue) and 4,190–5,464 (BullMQ).
- With real handler work, both queues are within a few percent of each other. Your handler dominates, not the queue.
- Both libraries make the same core design choices: a fused "ack + fetch next job" Lua script, a list for normal jobs and a sorted set for priority jobs. Neither has a structural speed advantage.
- PsyQueue's guarantee against duplicate runs costs nothing per job. It uses one lease-renewal call per worker every `leaseMs / 4` (15 s by default), not a lock per job.

**Bottom line:** performance is on par with BullMQ. Choose PsyQueue for its features and zero-infra start, not for raw speed.

## When to Choose What

**Choose PsyQueue when:**

- You want to start with zero infrastructure (SQLite) and move to Redis or Postgres later without rewriting job code.
- You are building multi-tenant SaaS and need fair scheduling and per-tenant limits without paying for BullMQ Pro.
- You want DAG workflows with saga rollback inside your job queue, without running a Temporal or Inngest server.
- You need audit logs, circuit breakers or payload schema versioning built into the queue.

**Choose BullMQ when:**

- You already run Redis and want a battle-tested queue with a large community.
- You need workers in several languages sharing one queue.
- Production track record matters more to you than extra features.

**Choose pg-boss or Graphile Worker when:**

- You already use Postgres, want jobs enqueued in the same transaction as your data, and need moderate throughput.

**Choose Temporal or Inngest when:**

- Workflows run for days or months, need deterministic replay, or workflow correctness is worth running extra infrastructure.

**Choose RabbitMQ (or another broker) when:**

- You need messaging between services: routing, fan-out, pub/sub, or many languages talking over one broker. That is a different problem from a job queue.

## Migration from BullMQ

BullMQ and PsyQueue share similar concepts. Here's a mapping:

| BullMQ | PsyQueue |
|--------|----------|
| `new Queue('name')` | `new PsyQueue()` |
| `queue.add('job', data)` | `q.enqueue('job', data)` |
| `new Worker('name', handler, { concurrency: 10 })` | `q.handle('name', handler)` + `q.startWorker('name', { concurrency: 10 })` |
| `worker.on('completed', ...)` | `q.events.on('job:completed', ...)` |
| `FlowProducer` | `workflow()` builder |
| `queue.addBulk([...])` | `q.enqueueBulk([...])` |
| `{ delay: 5000 }` | `{ runAt: new Date(Date.now() + 5000) }` |
| `{ repeat: { cron: '...' } }` | `{ cron: '...' }` |
| `{ jobId: 'unique' }` | `{ idempotencyKey: 'unique' }` |

### Key Differences

1. **Backend**: BullMQ is Redis-only. PsyQueue supports SQLite, Redis and Postgres.
2. **Worker model**: BullMQ has a separate `Worker` class. PsyQueue uses `q.handle()` + `q.startWorker()` for production, or `q.processNext()` for simple cases.
3. **Plugins**: BullMQ features are built in. PsyQueue features are opt-in plugins.
4. **Multi-tenancy**: open-source BullMQ has no tenant fairness (groups are in BullMQ Pro). PsyQueue has a tenancy plugin.

## Migration from pg-boss

| pg-boss | PsyQueue |
|---------|----------|
| `new PgBoss(config)` | `new PsyQueue()` + `q.use(postgres(config))` |
| `boss.send('queue', data)` | `q.enqueue('queue', data)` |
| `boss.work('queue', handler)` | `q.handle('queue', handler)` |
| `boss.schedule('queue', '* * * * *')` | `q.enqueue('queue', {}, { cron: '* * * * *' })` |
| `boss.getJobById(id)` | `backend.getJob(id)` |

### Key Differences

1. **Storage**: pg-boss is Postgres-only. PsyQueue supports multiple backends.
2. **Polling**: pg-boss handles polling internally. With PsyQueue you use `startWorker()` for continuous processing or `processNext()` for simple cases.
3. **Features**: PsyQueue adds workflows, tenancy, circuit breakers and other plugins that pg-boss does not have.
