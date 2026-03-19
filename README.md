# PsyQueue

> The psychic job queue that adapts to your needs. A micro-kernel distributed job queue platform where everything is a plugin.

[![npm version](https://img.shields.io/npm/v/@psyqueue/core.svg)](https://www.npmjs.com/package/@psyqueue/core)
[![CI](https://github.com/ayush-jadaun/psyqueue/actions/workflows/ci.yml/badge.svg)](https://github.com/ayush-jadaun/psyqueue/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![GitHub](https://img.shields.io/github/stars/ayush-jadaun/psyqueue?style=social)](https://github.com/ayush-jadaun/psyqueue)

## Why PsyQueue?

- **Zero-infra start** -- `npm install @psyqueue/core @psyqueue/backend-sqlite` and go. No Redis, no Docker.
- **Everything is a plugin** -- Use only what you need. The kernel is ~500 lines.
- **Scales with you** -- Start with SQLite, graduate to Redis/Postgres without rewriting code.
- **Faster than BullMQ** -- 7,989 jobs/sec vs BullMQ's 6,187 jobs/sec (1.29x faster) on Redis with concurrency:10.
- **Built for SaaS** -- Multi-tenant fair scheduling, per-tenant rate limits, noisy-neighbor protection.
- **Workflow orchestration** -- DAG workflows with conditional branching and Saga compensation.
- **Enterprise-ready** -- Circuit breakers, adaptive backpressure, exactly-once delivery, audit logs.

## Quick Start

```bash
npm install @psyqueue/core @psyqueue/backend-sqlite
```

```typescript
import { PsyQueue } from '@psyqueue/core'
import { sqlite } from '@psyqueue/backend-sqlite'

const q = new PsyQueue()
q.use(sqlite({ path: ':memory:' }))

// Register a handler
q.handle('email.send', async (ctx) => {
  const { to, subject, body } = ctx.job.payload as any
  await sendEmail(to, subject, body)
  return { sent: true }
})

// Start the queue
await q.start()

// Enqueue a job
const jobId = await q.enqueue('email.send', {
  to: 'user@example.com',
  subject: 'Welcome',
  body: 'Hello from PsyQueue!',
})

// Option A: Process one job at a time (simple / testing)
await q.processNext('email.send')

// Option B: Start a continuous worker pool (production)
q.startWorker('email.send', { concurrency: 10 })

// Stop the queue (also stops all workers)
await q.stop()
```

## Features at a Glance

| Feature | Plugin | Description |
|---------|--------|-------------|
| SQLite Backend | `@psyqueue/backend-sqlite` | Zero-config embedded storage |
| Redis Backend | `@psyqueue/backend-redis` | High-throughput production backend |
| Postgres Backend | `@psyqueue/backend-postgres` | ACID-compliant relational backend |
| Scheduling | `@psyqueue/plugin-scheduler` | Delayed jobs, cron scheduling |
| Deadline Priority | `@psyqueue/plugin-deadline-priority` | Dynamic priority boosting near deadlines |
| Workflows | `@psyqueue/plugin-workflows` | DAG-based workflow orchestration |
| Saga Compensation | `@psyqueue/plugin-saga` | Automatic rollback on workflow failure |
| Multi-Tenancy | `@psyqueue/plugin-tenancy` | Per-tenant rate limits and fair scheduling |
| Circuit Breaker | `@psyqueue/plugin-circuit-breaker` | Protect downstream services |
| Backpressure | `@psyqueue/plugin-backpressure` | Adaptive load shedding |
| Exactly-Once | `@psyqueue/plugin-exactly-once` | Idempotency key deduplication |
| Crash Recovery | `@psyqueue/plugin-crash-recovery` | WAL-based recovery of orphaned jobs |
| OTel Tracing | `@psyqueue/plugin-otel-tracing` | OpenTelemetry distributed tracing |
| Metrics | `@psyqueue/plugin-metrics` | Prometheus metrics (prom-client) |
| Audit Log | `@psyqueue/plugin-audit-log` | Tamper-evident hash-chained audit trail |
| Dashboard | `@psyqueue/dashboard` | Web UI for monitoring and management |
| Schema Versioning | `@psyqueue/plugin-schema-versioning` | Payload migration and Zod validation |
| gRPC Workers | `@psyqueue/plugin-grpc-workers` | Distribute work to remote gRPC workers |
| HTTP Workers | `@psyqueue/plugin-http-workers` | Distribute work to remote HTTP workers |
| Chaos Testing | `@psyqueue/plugin-chaos` | Inject failures for resilience testing |
| Offline Sync | `@psyqueue/plugin-offline-sync` | Local-first with background sync |
| Job Fusion | `@psyqueue/plugin-job-fusion` | Batch similar jobs into one |
| CLI | `@psyqueue/cli` | Migration, replay, and audit commands |

## Benchmark Results

Measured with 5,000 jobs, concurrency:10, timing from enqueue to `job:completed` event (after ack):

| System | Processing Throughput |
|--------|---------------------|
| **PsyQueue (Redis)** | **7,989 jobs/sec** |
| BullMQ (Redis) | 6,187 jobs/sec |

PsyQueue is **1.29x faster** than BullMQ thanks to its fused `ackAndFetch` Lua script (ack + dequeue in one Redis call), hybrid list + sorted-set model, and single dequeue loop with semaphore-controlled concurrency.

Run the benchmark yourself:

```bash
npx tsx benchmarks/comparison.ts
```

## Architecture

```
                        +-----------------------+
                        |      PsyQueue         |
                        |      (Kernel)         |
                        +-----------+-----------+
                                    |
                  +-----------------+-----------------+
                  |                 |                 |
           +------+------+  +------+------+  +------+------+
           | Event Bus   |  | Middleware   |  | Plugin      |
           | (wildcards) |  | Pipeline     |  | Registry    |
           +------+------+  +------+------+  +------+------+
                  |                 |                 |
                  |     +-----------+-----------+     |
                  |     |  Lifecycle Phases     |     |
                  |     |  guard -> validate -> |     |
                  |     |  transform -> observe |     |
                  |     |  -> execute -> final  |     |
                  |     +-----------+-----------+     |
                  |                 |                 |
     +------------+-----------------+-----------------+-----------+
     |            |            |            |            |        |
  +--+---+   +---+---+   +---+---+   +---+---+   +---+---+  +--+---+
  |SQLite|   |Redis  |   |Sched- |   |Work-  |   |Tenant |  | ...  |
  |Back- |   |Back-  |   |uler   |   |flows  |   |cy     |  |Plug- |
  |end   |   |end    |   |       |   |       |   |       |  |ins   |
  +------+   +-------+   +-------+   +-------+   +-------+  +------+
```

The kernel provides four core services:

1. **Plugin Registry** -- Dependency resolution (topological sort), lifecycle management (init/start/stop/destroy).
2. **Event Bus** -- Pub/sub with wildcard support (`job:*` matches `job:completed`, `job:failed`, etc.).
3. **Middleware Pipeline** -- Ordered execution across 6 phases: `guard`, `validate`, `transform`, `observe`, `execute`, `finalize`.
4. **Backend Adapter** -- Pluggable storage with a unified interface (enqueue, dequeue, ack/nack, scheduling, locking).

## Presets

PsyQueue ships with three presets that list recommended plugin combinations.

### Lite -- Get started fast

```typescript
const { queue, config } = PsyQueue.from('lite')
// config.plugins: ['backend-sqlite', 'scheduler', 'crash-recovery']

queue
  .use(sqlite({ path: './jobs.db' }))
  .use(scheduler())
  .use(crashRecovery())
```

### SaaS -- Multi-tenant applications

```typescript
const { queue, config } = PsyQueue.from('saas')
// config.plugins: ['backend-redis', 'tenancy', 'workflows', 'saga',
//   'circuit-breaker', 'backpressure', 'dashboard', 'metrics']

queue
  .use(redis({ host: 'localhost' }))
  .use(tenancy({ tiers: { free: { ... }, pro: { ... } }, ... }))
  .use(workflows())
  .use(saga())
  .use(circuitBreaker({ breakers: { ... } }))
  .use(backpressure({ signals: { ... } }))
  .use(dashboard({ port: 3001 }))
  .use(metrics())
```

### Enterprise -- Full-featured deployment

```typescript
const { queue, config } = PsyQueue.from('enterprise')
// config.plugins: ['backend-postgres', 'tenancy', 'workflows', 'saga',
//   'exactly-once', 'audit-log', 'otel-tracing', 'schema-versioning',
//   'circuit-breaker', 'backpressure', 'dashboard', 'metrics']
```

## Documentation

- [Getting Started](docs/getting-started.md) -- Installation, first job, and step-by-step guide
- [Architecture](docs/architecture.md) -- Kernel design, plugin system, middleware pipeline
- [API Reference](docs/api-reference.md) -- Full API documentation for the core package
- [Comparison](docs/comparison.md) -- PsyQueue vs BullMQ vs Celery vs Temporal vs pg-boss

### Plugin Guides

- [Backends](docs/plugins/backends.md) -- SQLite, Redis, Postgres
- [Scheduling](docs/plugins/scheduling.md) -- Delayed jobs, cron, deadline priority
- [Workflows](docs/plugins/workflows.md) -- DAG workflows and Saga compensation
- [Multi-Tenancy](docs/plugins/tenancy.md) -- Tiers, fair scheduling, rate limiting
- [Reliability](docs/plugins/reliability.md) -- Circuit breaker, backpressure, exactly-once, crash recovery
- [Observability](docs/plugins/observability.md) -- OTel tracing, Prometheus metrics, audit log, dashboard
- [Transport](docs/plugins/transport.md) -- gRPC and HTTP remote workers
- [Advanced](docs/plugins/advanced.md) -- Chaos testing, offline sync, job fusion, schema versioning

## Contributing

Contributions are welcome. Please open an issue or pull request on GitHub.

```bash
git clone https://github.com/ayush-jadaun/psyqueue.git
cd psyqueue
pnpm install
pnpm build
pnpm test
```

## License

[MIT](LICENSE)
