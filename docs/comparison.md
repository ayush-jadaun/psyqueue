# PsyQueue vs Alternatives

## Feature Matrix

| Feature | PsyQueue | BullMQ | Celery | Temporal | pg-boss |
|---------|----------|--------|--------|----------|---------|
| **Language** | TypeScript | TypeScript | Python | Go/Java/TS | TypeScript |
| **Storage** | SQLite/Redis/Postgres | Redis only | Redis/RabbitMQ | Custom (Cassandra/SQL) | Postgres only |
| **Zero-infra start** | SQLite, no server needed | Requires Redis | Requires broker | Requires Temporal server | Requires Postgres |
| **Plugin architecture** | Micro-kernel, everything pluggable | Monolithic with hooks | Monolithic | Monolithic | Monolithic |
| **Delayed jobs** | Plugin | Built-in | Built-in | Built-in | Built-in |
| **Cron scheduling** | Plugin | Built-in | Built-in (celery beat) | Built-in | Built-in |
| **Priority queues** | Built-in + deadline boost plugin | Built-in | Built-in (limited) | N/A (different model) | Built-in |
| **DAG workflows** | Plugin | Flows (limited) | Canvas/chains | First-class | N/A |
| **Saga compensation** | Plugin | N/A | N/A | Built-in (sagas) | N/A |
| **Multi-tenancy** | Plugin (tiers, fair scheduling) | N/A (manual) | N/A (manual) | Namespaces | N/A |
| **Rate limiting** | Plugin (per-tenant) | Rate limiter | celery rate_limit | N/A | N/A |
| **Circuit breaker** | Plugin | N/A | N/A | N/A (use activity timeouts) | N/A |
| **Backpressure** | Plugin (adaptive) | Concurrency limits | Prefetch limits | Built-in | N/A |
| **Exactly-once** | Plugin (idempotency keys) | Job dedup by ID | N/A | Built-in | Singleton jobs |
| **Crash recovery** | Plugin (WAL) | Redis persistence | Ack-based | Built-in | Postgres ACID |
| **Distributed tracing** | Plugin (OTel) | N/A (manual) | Built-in (limited) | Built-in | N/A |
| **Prometheus metrics** | Plugin | Built-in events | Built-in | Built-in | N/A |
| **Audit log** | Plugin (hash-chained) | N/A | N/A | Event history | N/A |
| **Dashboard** | Plugin | Bull Board | Flower | Temporal UI | pg-boss UI |
| **Schema versioning** | Plugin (Zod + migration) | N/A | N/A | N/A (use versioned APIs) | N/A |
| **Remote workers** | Plugin (gRPC + HTTP) | Redis-based | Celery workers | Activity workers | N/A |
| **Chaos testing** | Plugin | N/A | N/A | N/A | N/A |
| **Offline sync** | Plugin | N/A | N/A | N/A | N/A |
| **Job fusion** | Plugin | N/A | N/A | N/A | N/A |

## When to Choose PsyQueue

**Choose PsyQueue when:**

- You want to start simple (SQLite) and grow to production (Redis/Postgres) without rewriting code.
- You need a modular system where you only pay for what you use.
- You're building a multi-tenant SaaS and need built-in fair scheduling and rate limiting.
- You want DAG workflows with Saga compensation in your job queue.
- You need enterprise features (audit logs, circuit breakers, schema versioning) that aren't available in simpler queues.
- You prefer TypeScript-first tooling with full type safety.

**Choose BullMQ when:**

- You already have Redis and want a battle-tested, widely-used queue.
- You need simple job processing without many advanced features.
- You want a large community and ecosystem of tools.
- Performance is critical and you don't need multi-backend support.

**Choose Celery when:**

- Your stack is Python.
- You need mature tooling (Flower dashboard, celery beat).
- You're running in a well-established Python/Django/Flask ecosystem.

**Choose Temporal when:**

- You're building complex, long-running workflows (hours/days).
- You need deterministic workflow replay.
- You have the infrastructure budget for the Temporal server.
- Workflow correctness is more important than simplicity.

**Choose pg-boss when:**

- You already use Postgres and want zero additional infrastructure.
- You need simple job processing with ACID guarantees.
- Your volume is moderate (pg-boss is not designed for very high throughput).

## Migration from BullMQ

BullMQ and PsyQueue share similar concepts. Here's a mapping:

| BullMQ | PsyQueue |
|--------|----------|
| `new Queue('name')` | `new PsyQueue()` |
| `queue.add('job', data)` | `q.enqueue('job', data)` |
| `new Worker('name', handler)` | `q.handle('name', handler)` |
| `worker.on('completed', ...)` | `q.events.on('job:completed', ...)` |
| `FlowProducer` | `workflow()` builder |
| `queue.addBulk([...])` | `q.enqueueBulk([...])` |
| `{ delay: 5000 }` | `{ runAt: new Date(Date.now() + 5000) }` |
| `{ repeat: { cron: '...' } }` | `{ cron: '...' }` |
| `{ jobId: 'unique' }` | `{ idempotencyKey: 'unique' }` |

### Key Differences

1. **Backend**: BullMQ is Redis-only. PsyQueue supports SQLite, Redis, and Postgres.
2. **Worker model**: BullMQ has a separate `Worker` class with built-in polling. PsyQueue uses `q.handle()` + `q.processNext()`. You control the polling loop.
3. **Plugins**: BullMQ features are built-in. PsyQueue features are opt-in plugins.
4. **Multi-tenancy**: BullMQ has no native multi-tenancy. PsyQueue has a dedicated tenancy plugin.

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
2. **Polling**: pg-boss handles polling internally. With PsyQueue you call `processNext()` or use the scheduler plugin.
3. **Features**: PsyQueue offers workflows, tenancy, circuit breakers, and many other features not available in pg-boss.
