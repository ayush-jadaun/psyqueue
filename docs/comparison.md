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

Measured with 5,000 jobs, a no-op handler and concurrency 10, timed from enqueue until every `job:completed` event has fired (so ack overhead is included). PsyQueue uses `startWorker()` with a 1 ms poll interval; BullMQ uses its native `Worker`.

| Metric | PsyQueue (Redis) | BullMQ (Redis) |
|--------|-------------------|----------------|
| **Processing throughput** | **7,989 jobs/sec** | 6,187 jobs/sec |
| Ratio | **1.29x** | baseline |

**How to read this:** it is a micro-benchmark of queue overhead. With no-op handlers, the gap comes entirely from Redis round-trips and bookkeeping. With real handlers that do I/O for tens of milliseconds, both queues spend most of their time in your code and the difference shrinks. PsyQueue's 1 ms polling also costs some idle CPU, while BullMQ's blocking commands do not. Run it on your own hardware: `npx tsx benchmarks/comparison.ts`.

### Where the lower overhead comes from

1. **ackAndFetch fusion** -- acks the current job and dequeues the next one in a single Lua script call (2 Redis round-trips per job instead of 3).
2. **Hybrid list + sorted set** -- default-priority jobs use RPUSH/RPOP lists (O(1)); only prioritized jobs use sorted sets.
3. **Hash field packing** -- hot fields (id, status, priority, attempt) are individual hash fields; cold fields are packed into one `_ext` JSON blob, cutting per-job hash fields from ~30 to 13.
4. **Single dequeue loop** -- one loop with semaphore-controlled concurrency and a local job buffer.
5. **Active set uses SADD/SREM** -- plain set operations instead of ZADD/ZREM for tracking active jobs.

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
