# Installation Guide

## Prerequisites

- **Node.js** 20+ ([download](https://nodejs.org/))
- **pnpm** 9+ (`corepack enable` or `npm install -g pnpm`)
- **Docker** (optional — for Redis/Postgres backends)

---

## Quick Install (npm)

### Core Only (zero dependencies)

```bash
npm install psyqueue @psyqueue/backend-sqlite
```

This gets you a fully working job queue with SQLite — no Redis, no Docker, nothing else needed.

### With Redis Backend

```bash
npm install psyqueue @psyqueue/backend-redis
# Requires Redis running (Docker or native)
docker run -d -p 6379:6379 redis:7-alpine
```

### With Postgres Backend

```bash
npm install psyqueue @psyqueue/backend-postgres
# Requires PostgreSQL running
docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=psyqueue postgres:16-alpine
```

---

## Plugin Installation

Install only what you need. Every plugin is a separate npm package:

### Scheduling & Priority

```bash
npm install @psyqueue/plugin-scheduler          # Delayed jobs + cron
npm install @psyqueue/plugin-deadline-priority   # Auto-boost priority near deadline
```

### Workflows & Orchestration

```bash
npm install @psyqueue/plugin-workflows           # DAG workflow engine
npm install @psyqueue/plugin-saga                # Saga compensation (undo on failure)
npm install @psyqueue/plugin-job-fusion          # Auto-batch identical jobs
```

### Reliability

```bash
npm install @psyqueue/plugin-crash-recovery      # Write-ahead log + recovery
npm install @psyqueue/plugin-exactly-once        # Idempotency key dedup
npm install @psyqueue/plugin-circuit-breaker     # Per-dependency circuit breakers
npm install @psyqueue/plugin-backpressure        # Adaptive load shedding
```

### Multi-Tenancy

```bash
npm install @psyqueue/plugin-tenancy             # Fair scheduling + rate limiting
```

### Observability

```bash
npm install @psyqueue/plugin-otel-tracing        # OpenTelemetry distributed tracing
npm install @psyqueue/plugin-metrics             # Prometheus metrics
npm install @psyqueue/plugin-audit-log           # Hash-chained audit log
npm install @psyqueue/dashboard                  # Web dashboard (API + React UI)
```

### Schema & Data

```bash
npm install @psyqueue/plugin-schema-versioning   # Versioned payloads with Zod migration
```

### Transport (Polyglot Workers)

```bash
npm install @psyqueue/plugin-grpc-workers        # gRPC transport
npm install @psyqueue/plugin-http-workers        # HTTP/REST transport
```

### Testing

```bash
npm install @psyqueue/plugin-chaos               # Chaos testing / failure injection
```

### Sync

```bash
npm install @psyqueue/plugin-offline-sync        # Offline-first with sync
```

### CLI Tools

```bash
npm install -g @psyqueue/cli                     # psyqueue migrate/audit/replay
```

---

## Preset Bundles

Instead of picking plugins one by one, use presets:

### Lite (single server, zero infra)

```bash
npm install psyqueue @psyqueue/backend-sqlite @psyqueue/plugin-scheduler @psyqueue/plugin-crash-recovery
```

```ts
import { PsyQueue, presets } from 'psyqueue'
const q = PsyQueue.from(presets.lite)
```

### SaaS (multi-tenant production)

```bash
npm install psyqueue @psyqueue/backend-redis @psyqueue/plugin-tenancy @psyqueue/plugin-workflows @psyqueue/plugin-saga @psyqueue/plugin-circuit-breaker @psyqueue/plugin-backpressure @psyqueue/dashboard @psyqueue/plugin-metrics
```

```ts
const q = PsyQueue.from(presets.saas)
```

### Enterprise (compliance-ready)

```bash
npm install psyqueue @psyqueue/backend-postgres @psyqueue/plugin-tenancy @psyqueue/plugin-workflows @psyqueue/plugin-saga @psyqueue/plugin-exactly-once @psyqueue/plugin-audit-log @psyqueue/plugin-otel-tracing @psyqueue/plugin-schema-versioning @psyqueue/plugin-circuit-breaker @psyqueue/plugin-backpressure @psyqueue/dashboard @psyqueue/plugin-metrics
```

```ts
const q = PsyQueue.from(presets.enterprise)
```

---

## Development Setup (Contributing)

Clone and set up the monorepo:

```bash
git clone https://github.com/ayush-jadaun/psyqueue.git
cd psyqueue
pnpm install
pnpm build
pnpm test
```

### With Docker (for Redis + Postgres tests)

```bash
docker-compose up -d
pnpm test                    # all tests including Redis/Postgres integration
```

### Without Docker (SQLite only)

```bash
pnpm test                    # Redis/Postgres tests auto-skip
```

### Run Benchmarks

```bash
docker-compose up -d         # need Redis for comparison
cd benchmarks
npx tsx run.ts               # full benchmark suite
npx tsx _perf.ts             # quick PsyQueue vs BullMQ
npx tsx feature-comparison.ts # feature-by-feature comparison
npx tsx unique-features-test.ts # test all unique features
```

### Run Dashboard Demo

```bash
cd examples/dashboard-demo
npx tsx index.ts
# Open http://localhost:4000
```

### Run Any Example

```bash
cd examples/01-basic-queue
npx tsx index.ts
```

---

## Docker Production Deployment

```bash
# Build production image
docker build -t psyqueue .

# Run with Redis
docker run -d --name psyqueue \
  -e REDIS_URL=redis://redis:6379 \
  -e DASHBOARD_PORT=4000 \
  -p 4000:4000 \
  psyqueue
```

### Docker Compose (full stack)

```yaml
services:
  redis:
    image: redis:7-alpine
    ports: ["6379:6379"]

  postgres:
    image: postgres:16-alpine
    ports: ["5432:5432"]
    environment:
      POSTGRES_DB: psyqueue
      POSTGRES_USER: psyqueue
      POSTGRES_PASSWORD: psyqueue

  psyqueue:
    build: .
    ports: ["4000:4000"]
    environment:
      REDIS_URL: redis://redis:6379
      DATABASE_URL: postgres://psyqueue:psyqueue@postgres:5432/psyqueue
      DASHBOARD_PORT: 4000
    depends_on: [redis, postgres]
```

---

## Verify Installation

```ts
import { PsyQueue } from 'psyqueue'
import { sqlite } from '@psyqueue/backend-sqlite'

const q = new PsyQueue()
q.use(sqlite({ path: ':memory:' }))
q.handle('test', async () => ({ working: true }))
await q.start()

const id = await q.enqueue('test', { hello: 'world' })
console.log('Enqueued:', id)

const ok = await q.processNext('test')
console.log('Processed:', ok) // true

await q.stop()
console.log('PsyQueue is working!')
```

---

## All Packages Reference

| Package | Description | Install |
|---------|-------------|---------|
| `psyqueue` | Core kernel | `npm i psyqueue` |
| `@psyqueue/backend-sqlite` | SQLite backend | `npm i @psyqueue/backend-sqlite` |
| `@psyqueue/backend-redis` | Redis backend | `npm i @psyqueue/backend-redis` |
| `@psyqueue/backend-postgres` | PostgreSQL backend | `npm i @psyqueue/backend-postgres` |
| `@psyqueue/plugin-scheduler` | Delayed + cron | `npm i @psyqueue/plugin-scheduler` |
| `@psyqueue/plugin-deadline-priority` | Dynamic priority | `npm i @psyqueue/plugin-deadline-priority` |
| `@psyqueue/plugin-workflows` | DAG workflows | `npm i @psyqueue/plugin-workflows` |
| `@psyqueue/plugin-saga` | Saga compensation | `npm i @psyqueue/plugin-saga` |
| `@psyqueue/plugin-job-fusion` | Auto-batching | `npm i @psyqueue/plugin-job-fusion` |
| `@psyqueue/plugin-tenancy` | Multi-tenant | `npm i @psyqueue/plugin-tenancy` |
| `@psyqueue/plugin-circuit-breaker` | Circuit breakers | `npm i @psyqueue/plugin-circuit-breaker` |
| `@psyqueue/plugin-backpressure` | Backpressure | `npm i @psyqueue/plugin-backpressure` |
| `@psyqueue/plugin-exactly-once` | Idempotency | `npm i @psyqueue/plugin-exactly-once` |
| `@psyqueue/plugin-crash-recovery` | WAL recovery | `npm i @psyqueue/plugin-crash-recovery` |
| `@psyqueue/plugin-otel-tracing` | OTel tracing | `npm i @psyqueue/plugin-otel-tracing` |
| `@psyqueue/plugin-metrics` | Prometheus | `npm i @psyqueue/plugin-metrics` |
| `@psyqueue/plugin-audit-log` | Audit log | `npm i @psyqueue/plugin-audit-log` |
| `@psyqueue/plugin-schema-versioning` | Schema versions | `npm i @psyqueue/plugin-schema-versioning` |
| `@psyqueue/plugin-grpc-workers` | gRPC transport | `npm i @psyqueue/plugin-grpc-workers` |
| `@psyqueue/plugin-http-workers` | HTTP transport | `npm i @psyqueue/plugin-http-workers` |
| `@psyqueue/plugin-chaos` | Chaos testing | `npm i @psyqueue/plugin-chaos` |
| `@psyqueue/plugin-offline-sync` | Offline sync | `npm i @psyqueue/plugin-offline-sync` |
| `@psyqueue/dashboard` | Dashboard | `npm i @psyqueue/dashboard` |
| `@psyqueue/cli` | CLI tools | `npm i -g @psyqueue/cli` |
