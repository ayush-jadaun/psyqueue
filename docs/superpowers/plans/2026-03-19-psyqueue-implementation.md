# PsyQueue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build PsyQueue — a micro-kernel distributed job queue platform with pluggable backends, workflow orchestration, multi-tenancy, and 20+ composable plugins.

**Architecture:** Micro-kernel pattern where a tiny core (~500 LOC) provides an event bus, plugin registry, and middleware pipeline. Every feature (storage, scheduling, workflows, tenancy, etc.) is an opt-in plugin. Monorepo managed by pnpm workspaces + Turborepo.

**Tech Stack:** TypeScript (strict, ESM-only), Node.js 20+, pnpm workspaces, Turborepo, Vitest (spec says node:test but Vitest provides better DX for monorepo + watch mode + coverage), better-sqlite3, ioredis, pg, Zod, React + Vite (dashboard), gRPC (@grpc/grpc-js), Protobuf

**Spec:** `docs/superpowers/specs/2026-03-19-psyqueue-design.md`

---

## File Structure

```
psyqueue/
├── package.json                          # Root workspace config
├── pnpm-workspace.yaml                   # pnpm workspace definition
├── turbo.json                            # Turborepo task config
├── tsconfig.base.json                    # Shared TS config (strict, ESM)
├── vitest.workspace.ts                   # Vitest workspace config
├── docker-compose.yml                    # Redis + Postgres + Jaeger
├── .github/workflows/ci.yml             # GitHub Actions CI
├── .env.example                          # Env template
│
├── packages/
│   ├── core/                             # "psyqueue" — the kernel
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── src/
│   │   │   ├── index.ts                  # Public exports
│   │   │   ├── kernel.ts                 # PsyQueue class — use(), start(), stop()
│   │   │   ├── event-bus.ts              # Typed event emitter with wildcards
│   │   │   ├── plugin-registry.ts        # Registration, dependency resolution, lifecycle
│   │   │   ├── middleware-pipeline.ts     # Phase-ordered middleware chains per event
│   │   │   ├── context.ts                # JobContext factory
│   │   │   ├── job.ts                    # Job creation, ULID generation, defaults
│   │   │   ├── types.ts                  # All shared interfaces (Job, PsyPlugin, BackendAdapter, etc.)
│   │   │   ├── errors.ts                 # PsyQueueError hierarchy
│   │   │   └── presets.ts                # lite, saas, enterprise preset definitions
│   │   └── tests/
│   │       ├── event-bus.test.ts
│   │       ├── plugin-registry.test.ts
│   │       ├── middleware-pipeline.test.ts
│   │       ├── context.test.ts
│   │       ├── job.test.ts
│   │       ├── kernel.test.ts
│   │       └── presets.test.ts
│   │
│   ├── backend-sqlite/                   # "@psyqueue/backend-sqlite"
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── src/
│   │   │   ├── index.ts                  # Public export: sqlite(opts) => PsyPlugin
│   │   │   ├── adapter.ts                # SQLiteBackendAdapter implements BackendAdapter
│   │   │   ├── schema.ts                 # CREATE TABLE statements, migrations
│   │   │   └── queries.ts                # Parameterized SQL query builders
│   │   └── tests/
│   │       ├── adapter.test.ts
│   │       └── queries.test.ts
│   │
│   ├── backend-redis/                    # "@psyqueue/backend-redis"
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── adapter.ts                # RedisBackendAdapter
│   │   │   └── lua/                      # Lua scripts for atomic ops
│   │   │       ├── dequeue.lua
│   │   │       └── ack.lua
│   │   └── tests/
│   │       └── adapter.test.ts
│   │
│   ├── backend-postgres/                 # "@psyqueue/backend-postgres"
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── adapter.ts                # PostgresBackendAdapter
│   │   │   └── schema.sql               # DDL
│   │   └── tests/
│   │       └── adapter.test.ts
│   │
│   ├── plugin-scheduler/                 # "@psyqueue/plugin-scheduler"
│   │   ├── package.json
│   │   ├── src/
│   │   │   ├── index.ts                  # scheduler(opts) => PsyPlugin
│   │   │   ├── delayed.ts               # runAt scheduling
│   │   │   └── cron.ts                  # Cron with leader election
│   │   └── tests/
│   │       ├── delayed.test.ts
│   │       └── cron.test.ts
│   │
│   ├── plugin-crash-recovery/            # "@psyqueue/plugin-crash-recovery"
│   │   ├── package.json
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── wal.ts                   # Write-ahead log
│   │   │   └── recovery.ts             # Startup recovery logic
│   │   └── tests/
│   │       ├── wal.test.ts
│   │       └── recovery.test.ts
│   │
│   ├── plugin-exactly-once/              # "@psyqueue/plugin-exactly-once"
│   │   ├── package.json
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── dedup.ts                 # Idempotency key store
│   │   │   └── completion-token.ts      # Token generation + verification
│   │   └── tests/
│   │       └── exactly-once.test.ts
│   │
│   ├── plugin-schema-versioning/         # "@psyqueue/plugin-schema-versioning"
│   │   ├── package.json
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── registry.ts             # Version registry + migration chains
│   │   │   └── validator.ts            # Zod validation wrapper
│   │   └── tests/
│   │       └── schema-versioning.test.ts
│   │
│   ├── plugin-workflows/                 # "@psyqueue/plugin-workflows"
│   │   ├── package.json
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── builder.ts              # workflow().step().build() fluent API
│   │   │   ├── engine.ts               # DAG execution engine
│   │   │   └── state.ts                # Workflow state machine
│   │   └── tests/
│   │       ├── builder.test.ts
│   │       ├── engine.test.ts
│   │       └── state.test.ts
│   │
│   ├── plugin-saga/                      # "@psyqueue/plugin-saga"
│   │   ├── package.json
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   └── compensator.ts          # Reverse-order compensation runner
│   │   └── tests/
│   │       └── compensator.test.ts
│   │
│   ├── plugin-tenancy/                   # "@psyqueue/plugin-tenancy"
│   │   ├── package.json
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── tiers.ts                # Tier config + resolution
│   │   │   ├── fair-scheduler.ts       # Weighted fair queue, round robin, strict
│   │   │   └── rate-limiter.ts         # Sliding window rate limiter
│   │   └── tests/
│   │       ├── fair-scheduler.test.ts
│   │       └── rate-limiter.test.ts
│   │
│   ├── plugin-circuit-breaker/           # "@psyqueue/plugin-circuit-breaker"
│   │   ├── package.json
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   └── breaker.ts              # State machine: closed/open/half-open
│   │   └── tests/
│   │       └── breaker.test.ts
│   │
│   ├── plugin-backpressure/              # "@psyqueue/plugin-backpressure"
│   │   ├── package.json
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── signals.ts              # Health signal monitors
│   │   │   └── actions.ts              # Configurable action runners
│   │   └── tests/
│   │       └── backpressure.test.ts
│   │
│   ├── plugin-deadline-priority/         # "@psyqueue/plugin-deadline-priority"
│   │   ├── package.json
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   └── curves.ts               # linear, exponential, step, custom
│   │   └── tests/
│   │       └── deadline-priority.test.ts
│   │
│   ├── plugin-job-fusion/                # "@psyqueue/plugin-job-fusion"
│   │   ├── package.json
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   └── batcher.ts              # Windowed batch collector + fuse logic
│   │   └── tests/
│   │       └── job-fusion.test.ts
│   │
│   ├── plugin-otel-tracing/              # "@psyqueue/plugin-otel-tracing"
│   │   ├── package.json
│   │   ├── src/
│   │   │   └── index.ts
│   │   └── tests/
│   │       └── otel-tracing.test.ts
│   │
│   ├── plugin-metrics/                   # "@psyqueue/plugin-metrics"
│   │   ├── package.json
│   │   ├── src/
│   │   │   └── index.ts
│   │   └── tests/
│   │       └── metrics.test.ts
│   │
│   ├── plugin-audit-log/                 # "@psyqueue/plugin-audit-log"
│   │   ├── package.json
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   └── hash-chain.ts           # SHA-256 hash chaining
│   │   └── tests/
│   │       └── audit-log.test.ts
│   │
│   ├── plugin-grpc-workers/              # "@psyqueue/plugin-grpc-workers"
│   │   ├── package.json
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   └── server.ts               # gRPC server impl
│   │   └── tests/
│   │       └── grpc-workers.test.ts
│   │
│   ├── plugin-http-workers/              # "@psyqueue/plugin-http-workers"
│   │   ├── package.json
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   └── server.ts               # HTTP REST server
│   │   └── tests/
│   │       └── http-workers.test.ts
│   │
│   ├── plugin-chaos/                     # "@psyqueue/plugin-chaos"
│   │   ├── package.json
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   └── scenarios.ts            # Failure scenario definitions
│   │   └── tests/
│   │       └── chaos.test.ts
│   │
│   ├── plugin-offline-sync/              # "@psyqueue/plugin-offline-sync"
│   │   ├── package.json
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   └── sync-engine.ts          # Local buffer + remote sync
│   │   └── tests/
│   │       └── offline-sync.test.ts
│   │
│   ├── dashboard/                        # "@psyqueue/dashboard"
│   │   ├── package.json
│   │   ├── vite.config.ts
│   │   ├── src/
│   │   │   ├── server.ts               # Express server serving dashboard + API
│   │   │   ├── plugin.ts               # PsyPlugin wrapper
│   │   │   ├── api/
│   │   │   │   └── routes.ts           # REST API for dashboard data
│   │   │   └── ui/
│   │   │       ├── index.html
│   │   │       ├── main.tsx
│   │   │       ├── App.tsx
│   │   │       └── pages/
│   │   │           ├── Overview.tsx
│   │   │           ├── Queues.tsx
│   │   │           ├── Jobs.tsx
│   │   │           ├── Workflows.tsx
│   │   │           ├── Tenants.tsx
│   │   │           ├── Circuits.tsx
│   │   │           ├── Audit.tsx
│   │   │           └── Actions.tsx
│   │   └── tests/
│   │       └── api.test.ts
│   │
│   └── cli/                              # "@psyqueue/cli"
│       ├── package.json
│       ├── src/
│       │   ├── index.ts                  # CLI entrypoint
│       │   └── commands/
│       │       ├── migrate.ts
│       │       ├── audit.ts
│       │       └── replay.ts
│       └── tests/
│           └── cli.test.ts
│
├── proto/
│   └── psyqueue/v1/worker.proto          # gRPC service definition
│
└── examples/
    ├── basic/                            # Minimal SQLite setup
    │   └── index.ts
    ├── saas-multi-tenant/                # Multi-tenant with Redis
    │   └── index.ts
    ├── workflow-saga/                    # Order processing workflow
    │   └── index.ts
    └── polyglot/                         # Python + Go workers
        ├── server.ts
        └── worker.py
```

---

## Phase 1: Project Setup & Core Kernel

### Task 1: Monorepo Scaffolding

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `turbo.json`
- Create: `tsconfig.base.json`
- Create: `vitest.workspace.ts`
- Create: `.gitignore`
- Create: `packages/core/package.json`
- Create: `packages/core/tsconfig.json`

- [ ] **Step 1: Initialize pnpm workspace root**

```json
// package.json
{
  "name": "psyqueue-monorepo",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20.0.0" },
  "packageManager": "pnpm@9.15.4",
  "scripts": {
    "build": "turbo run build",
    "test": "turbo run test",
    "lint": "turbo run lint",
    "clean": "turbo run clean"
  },
  "devDependencies": {
    "turbo": "^2.4.0",
    "typescript": "^5.7.0",
    "vitest": "^3.0.0",
    "eslint": "^9.0.0",
    "@typescript-eslint/eslint-plugin": "^8.0.0",
    "@typescript-eslint/parser": "^8.0.0",
    "prettier": "^3.4.0"
  }
}
```

```yaml
# pnpm-workspace.yaml
packages:
  - "packages/*"
  - "examples/*"
```

```json
// turbo.json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**"]
    },
    "test": {
      "dependsOn": ["build"]
    },
    "lint": {},
    "clean": {
      "cache": false
    }
  }
}
```

- [ ] **Step 2: Create shared TypeScript config**

```json
// tsconfig.base.json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "outDir": "dist",
    "rootDir": "src",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noUncheckedIndexedAccess": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "exactOptionalPropertyTypes": false
  }
}
```

- [ ] **Step 3: Create vitest workspace config**

```ts
// vitest.workspace.ts
import { defineWorkspace } from 'vitest/config'

export default defineWorkspace([
  'packages/*/vitest.config.ts',
])
```

- [ ] **Step 4: Create core package scaffolding**

```json
// packages/core/package.json
{
  "name": "psyqueue",
  "version": "0.1.0",
  "type": "module",
  "description": "Micro-kernel distributed job queue platform",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "eslint src/",
    "clean": "rm -rf dist"
  },
  "engines": { "node": ">=20.0.0" },
  "files": ["dist"],
  "license": "MIT"
}
```

```json
// packages/core/tsconfig.json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

```ts
// packages/core/vitest.config.ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
  },
})
```

- [ ] **Step 5: Create .gitignore and commit**

```gitignore
# .gitignore
node_modules/
dist/
*.tgz
.turbo/
coverage/
.env
*.db
*.wal
```

Run: `pnpm install && git add -A && git commit -m "feat: scaffold monorepo with pnpm workspaces + turborepo"`

---

### Task 2: Core Types & Errors

**Files:**
- Create: `packages/core/src/types.ts`
- Create: `packages/core/src/errors.ts`
- Test: `packages/core/tests/errors.test.ts`

- [ ] **Step 1: Write the error test**

```ts
// packages/core/tests/errors.test.ts
import { describe, it, expect } from 'vitest'
import {
  PsyQueueError,
  PluginError,
  DependencyError,
  RateLimitError,
  DuplicateJobError,
  SchemaError,
} from '../src/errors.js'

describe('PsyQueueError', () => {
  it('has code, message, and context', () => {
    const err = new PsyQueueError('UNKNOWN', 'something broke', { jobId: '123' })
    expect(err.code).toBe('UNKNOWN')
    expect(err.message).toBe('something broke')
    expect(err.context).toEqual({ jobId: '123' })
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('PsyQueueError')
  })

  it('is instanceof Error', () => {
    const err = new PsyQueueError('UNKNOWN', 'test')
    expect(err).toBeInstanceOf(Error)
  })
})

describe('PluginError', () => {
  it('includes plugin name', () => {
    const err = new PluginError('my-plugin', 'failed to start')
    expect(err.code).toBe('PLUGIN_ERROR')
    expect(err.pluginName).toBe('my-plugin')
    expect(err.message).toBe('[my-plugin] failed to start')
  })
})

describe('DependencyError', () => {
  it('lists missing dependency', () => {
    const err = new DependencyError('workflows', 'backend')
    expect(err.code).toBe('MISSING_DEPENDENCY')
    expect(err.message).toContain('workflows')
    expect(err.message).toContain('backend')
  })
})

describe('RateLimitError', () => {
  it('includes retryAfter', () => {
    const err = new RateLimitError('tenant_123', 4200)
    expect(err.code).toBe('RATE_LIMIT_EXCEEDED')
    expect(err.retryAfter).toBe(4200)
  })
})

describe('DuplicateJobError', () => {
  it('includes existing job ID', () => {
    const err = new DuplicateJobError('key_123', 'job_456')
    expect(err.code).toBe('DUPLICATE_JOB')
    expect(err.existingJobId).toBe('job_456')
  })
})

describe('SchemaError', () => {
  it('includes version info', () => {
    const err = new SchemaError('email.send', 1, 3, ['field "to" expected array'])
    expect(err.code).toBe('SCHEMA_MISMATCH')
    expect(err.jobName).toBe('email.send')
    expect(err.foundVersion).toBe(1)
    expect(err.expectedVersion).toBe(3)
    expect(err.validationErrors).toEqual(['field "to" expected array'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && npx vitest run tests/errors.test.ts`
Expected: FAIL — modules not found

- [ ] **Step 3: Implement types and errors**

```ts
// packages/core/src/types.ts

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
```

```ts
// packages/core/src/errors.ts

export class PsyQueueError extends Error {
  public readonly code: string
  public readonly context?: Record<string, unknown>

  constructor(code: string, message: string, context?: Record<string, unknown>) {
    super(message)
    this.name = 'PsyQueueError'
    this.code = code
    this.context = context
  }
}

export class PluginError extends PsyQueueError {
  public readonly pluginName: string

  constructor(pluginName: string, message: string, context?: Record<string, unknown>) {
    super('PLUGIN_ERROR', `[${pluginName}] ${message}`, context)
    this.pluginName = pluginName
  }
}

export class DependencyError extends PsyQueueError {
  constructor(pluginName: string, missingDep: string) {
    super(
      'MISSING_DEPENDENCY',
      `Plugin "${pluginName}" requires "${missingDep}" but none is registered. Install a backend: @psyqueue/backend-sqlite, @psyqueue/backend-redis, or @psyqueue/backend-postgres`,
      { pluginName, missingDep }
    )
  }
}

export class CircularDependencyError extends PsyQueueError {
  constructor(chain: string[]) {
    super(
      'CIRCULAR_DEPENDENCY',
      `Circular dependency detected: ${chain.join(' → ')}`,
      { chain }
    )
  }
}

export class RateLimitError extends PsyQueueError {
  public readonly retryAfter: number

  constructor(tenantId: string, retryAfter: number) {
    super('RATE_LIMIT_EXCEEDED', `Tenant ${tenantId} exceeded rate limit`, { tenantId, retryAfter })
    this.retryAfter = retryAfter
  }
}

export class DuplicateJobError extends PsyQueueError {
  public readonly existingJobId: string

  constructor(idempotencyKey: string, existingJobId: string) {
    super('DUPLICATE_JOB', `Duplicate job with idempotency key "${idempotencyKey}"`, {
      idempotencyKey,
      existingJobId,
    })
    this.existingJobId = existingJobId
  }
}

export class SchemaError extends PsyQueueError {
  public readonly jobName: string
  public readonly foundVersion: number
  public readonly expectedVersion: number
  public readonly validationErrors: string[]

  constructor(jobName: string, foundVersion: number, expectedVersion: number, validationErrors: string[]) {
    super('SCHEMA_MISMATCH', `Schema mismatch for "${jobName}": found v${foundVersion}, expected v${expectedVersion}`, {
      jobName,
      foundVersion,
      expectedVersion,
      validationErrors,
    })
    this.jobName = jobName
    this.foundVersion = foundVersion
    this.expectedVersion = expectedVersion
    this.validationErrors = validationErrors
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/core && npx vitest run tests/errors.test.ts`
Expected: All 6 test suites PASS

- [ ] **Step 5: Commit**

Run: `git add packages/core/src/types.ts packages/core/src/errors.ts packages/core/tests/errors.test.ts packages/core/vitest.config.ts && git commit -m "feat(core): add type definitions and error hierarchy"`

---

### Task 3: Event Bus

**Files:**
- Create: `packages/core/src/event-bus.ts`
- Test: `packages/core/tests/event-bus.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/tests/event-bus.test.ts
import { describe, it, expect, vi } from 'vitest'
import { EventBus } from '../src/event-bus.js'

describe('EventBus', () => {
  it('emits events to subscribers', () => {
    const bus = new EventBus()
    const handler = vi.fn()
    bus.on('job:completed', handler)
    bus.emit('job:completed', { jobId: '123' }, 'test')

    expect(handler).toHaveBeenCalledOnce()
    expect(handler.mock.calls[0]![0]).toMatchObject({
      type: 'job:completed',
      source: 'test',
      data: { jobId: '123' },
    })
    expect(handler.mock.calls[0]![0].timestamp).toBeInstanceOf(Date)
  })

  it('supports wildcard subscriptions matching one segment', () => {
    const bus = new EventBus()
    const handler = vi.fn()
    bus.on('workflow:*', handler)

    bus.emit('workflow:started', {}, 'test')
    bus.emit('workflow:completed', {}, 'test')
    bus.emit('circuit:open', {}, 'test') // should NOT match

    expect(handler).toHaveBeenCalledTimes(2)
  })

  it('wildcard does not match nested segments', () => {
    const bus = new EventBus()
    const handler = vi.fn()
    bus.on('a:*', handler)

    bus.emit('a:b', {}, 'test')
    bus.emit('a:b:c', {}, 'test') // should NOT match

    expect(handler).toHaveBeenCalledOnce()
  })

  it('unsubscribes with off()', () => {
    const bus = new EventBus()
    const handler = vi.fn()
    bus.on('job:failed', handler)
    bus.off('job:failed', handler)
    bus.emit('job:failed', {}, 'test')

    expect(handler).not.toHaveBeenCalled()
  })

  it('handles multiple subscribers for same event', () => {
    const bus = new EventBus()
    const h1 = vi.fn()
    const h2 = vi.fn()
    bus.on('job:completed', h1)
    bus.on('job:completed', h2)
    bus.emit('job:completed', {}, 'test')

    expect(h1).toHaveBeenCalledOnce()
    expect(h2).toHaveBeenCalledOnce()
  })

  it('does not throw when emitting with no subscribers', () => {
    const bus = new EventBus()
    expect(() => bus.emit('no:subscribers', {}, 'test')).not.toThrow()
  })

  it('catches and logs handler errors without breaking other subscribers', () => {
    const bus = new EventBus()
    const errorHandler = vi.fn(() => { throw new Error('handler error') })
    const goodHandler = vi.fn()

    bus.on('test:event', errorHandler)
    bus.on('test:event', goodHandler)
    bus.emit('test:event', {}, 'test')

    expect(goodHandler).toHaveBeenCalledOnce()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && npx vitest run tests/event-bus.test.ts`
Expected: FAIL — EventBus not found

- [ ] **Step 3: Implement EventBus**

```ts
// packages/core/src/event-bus.ts
import type { EventBusInterface, EventHandler, PsyEvent } from './types.js'

export class EventBus implements EventBusInterface {
  private handlers = new Map<string, Set<EventHandler>>()
  private wildcardHandlers = new Map<string, Set<EventHandler>>()

  on(event: string, handler: EventHandler): void {
    if (event.includes('*')) {
      const prefix = event.replace(':*', '')
      if (!this.wildcardHandlers.has(prefix)) {
        this.wildcardHandlers.set(prefix, new Set())
      }
      this.wildcardHandlers.get(prefix)!.add(handler)
    } else {
      if (!this.handlers.has(event)) {
        this.handlers.set(event, new Set())
      }
      this.handlers.get(event)!.add(handler)
    }
  }

  off(event: string, handler: EventHandler): void {
    if (event.includes('*')) {
      const prefix = event.replace(':*', '')
      this.wildcardHandlers.get(prefix)?.delete(handler)
    } else {
      this.handlers.get(event)?.delete(handler)
    }
  }

  emit(event: string, data: unknown, source: string = 'kernel'): void {
    const psyEvent: PsyEvent = {
      type: event,
      timestamp: new Date(),
      source,
      data,
    }

    // Exact match handlers
    const exact = this.handlers.get(event)
    if (exact) {
      for (const handler of exact) {
        this.safeCall(handler, psyEvent)
      }
    }

    // Wildcard match: event "workflow:started" matches wildcard "workflow:*"
    // Only if event has exactly one segment after prefix (no nested colons)
    const parts = event.split(':')
    if (parts.length === 2) {
      const prefix = parts[0]!
      const wildcards = this.wildcardHandlers.get(prefix)
      if (wildcards) {
        for (const handler of wildcards) {
          this.safeCall(handler, psyEvent)
        }
      }
    }
  }

  private safeCall(handler: EventHandler, event: PsyEvent): void {
    try {
      const result = handler(event)
      if (result instanceof Promise) {
        result.catch(() => {
          // Async handler errors are silently caught
        })
      }
    } catch {
      // Sync handler errors are silently caught — one bad handler must not break others
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/core && npx vitest run tests/event-bus.test.ts`
Expected: All 7 tests PASS

- [ ] **Step 5: Commit**

Run: `git add packages/core/src/event-bus.ts packages/core/tests/event-bus.test.ts && git commit -m "feat(core): add event bus with wildcard subscriptions"`

---

### Task 4: Plugin Registry

**Files:**
- Create: `packages/core/src/plugin-registry.ts`
- Test: `packages/core/tests/plugin-registry.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/tests/plugin-registry.test.ts
import { describe, it, expect, vi } from 'vitest'
import { PluginRegistry } from '../src/plugin-registry.js'
import type { PsyPlugin, Kernel } from '../src/types.js'
import { EventBus } from '../src/event-bus.js'

function makeKernel(): Kernel {
  return {
    events: new EventBus(),
    pipeline: vi.fn(),
    getBackend: vi.fn(),
    expose: vi.fn(),
  }
}

function makePlugin(overrides: Partial<PsyPlugin> = {}): PsyPlugin {
  return {
    name: 'test-plugin',
    version: '1.0.0',
    init: vi.fn(),
    ...overrides,
  }
}

describe('PluginRegistry', () => {
  it('registers and initializes a plugin', () => {
    const kernel = makeKernel()
    const registry = new PluginRegistry(kernel)
    const plugin = makePlugin({ name: 'my-plugin' })

    registry.register(plugin)
    expect(plugin.init).toHaveBeenCalledWith(kernel)
  })

  it('prevents duplicate registration', () => {
    const kernel = makeKernel()
    const registry = new PluginRegistry(kernel)
    registry.register(makePlugin({ name: 'dup' }))
    expect(() => registry.register(makePlugin({ name: 'dup' }))).toThrow('already registered')
  })

  it('resolves dependencies in correct start order', async () => {
    const kernel = makeKernel()
    const registry = new PluginRegistry(kernel)
    const order: string[] = []

    const backend = makePlugin({
      name: 'sqlite',
      provides: 'backend',
      start: vi.fn(async () => { order.push('sqlite') }),
    })
    const workflows = makePlugin({
      name: 'workflows',
      depends: ['backend'],
      start: vi.fn(async () => { order.push('workflows') }),
    })

    registry.register(workflows) // registered first but depends on backend
    registry.register(backend)

    await registry.startAll()
    expect(order).toEqual(['sqlite', 'workflows'])
  })

  it('throws on missing dependency', async () => {
    const kernel = makeKernel()
    const registry = new PluginRegistry(kernel)
    registry.register(makePlugin({ name: 'workflows', depends: ['backend'] }))

    await expect(registry.startAll()).rejects.toThrow('requires "backend"')
  })

  it('throws on circular dependency', async () => {
    const kernel = makeKernel()
    const registry = new PluginRegistry(kernel)
    registry.register(makePlugin({ name: 'a', depends: ['b'], provides: 'a' }))
    registry.register(makePlugin({ name: 'b', depends: ['a'], provides: 'b' }))

    await expect(registry.startAll()).rejects.toThrow('Circular dependency')
  })

  it('stops plugins in reverse dependency order', async () => {
    const kernel = makeKernel()
    const registry = new PluginRegistry(kernel)
    const order: string[] = []

    registry.register(makePlugin({
      name: 'sqlite',
      provides: 'backend',
      start: vi.fn(),
      stop: vi.fn(async () => { order.push('sqlite') }),
    }))
    registry.register(makePlugin({
      name: 'workflows',
      depends: ['backend'],
      start: vi.fn(),
      stop: vi.fn(async () => { order.push('workflows') }),
    }))

    await registry.startAll()
    await registry.stopAll()
    expect(order).toEqual(['workflows', 'sqlite'])
  })

  it('supports provides as array', async () => {
    const kernel = makeKernel()
    const registry = new PluginRegistry(kernel)
    const order: string[] = []

    registry.register(makePlugin({
      name: 'super-plugin',
      provides: ['backend', 'scheduler'],
      start: vi.fn(async () => { order.push('super') }),
    }))
    registry.register(makePlugin({
      name: 'needs-both',
      depends: ['backend', 'scheduler'],
      start: vi.fn(async () => { order.push('needs-both') }),
    }))

    await registry.startAll()
    expect(order).toEqual(['super', 'needs-both'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && npx vitest run tests/plugin-registry.test.ts`
Expected: FAIL — PluginRegistry not found

- [ ] **Step 3: Implement PluginRegistry**

```ts
// packages/core/src/plugin-registry.ts
import type { PsyPlugin, Kernel } from './types.js'
import { DependencyError, CircularDependencyError, PsyQueueError } from './errors.js'

export class PluginRegistry {
  private plugins = new Map<string, PsyPlugin>()
  private provides = new Map<string, string>() // capability → plugin name
  private startOrder: string[] = []

  constructor(private kernel: Kernel) {}

  register(plugin: PsyPlugin): void {
    if (this.plugins.has(plugin.name)) {
      throw new PsyQueueError(
        'DUPLICATE_PLUGIN',
        `Plugin "${plugin.name}" is already registered`
      )
    }

    this.plugins.set(plugin.name, plugin)

    // Register provided capabilities
    const caps = plugin.provides
      ? Array.isArray(plugin.provides) ? plugin.provides : [plugin.provides]
      : []
    for (const cap of caps) {
      this.provides.set(cap, plugin.name)
    }

    // Init synchronously
    plugin.init(this.kernel)
  }

  async startAll(): Promise<void> {
    this.startOrder = this.resolveOrder()
    for (const name of this.startOrder) {
      const plugin = this.plugins.get(name)!
      if (plugin.start) {
        await plugin.start()
      }
    }
  }

  async stopAll(): Promise<void> {
    const reversed = [...this.startOrder].reverse()
    for (const name of reversed) {
      const plugin = this.plugins.get(name)!
      if (plugin.stop) {
        await plugin.stop()
      }
    }
    for (const name of reversed) {
      const plugin = this.plugins.get(name)!
      if (plugin.destroy) {
        await plugin.destroy()
      }
    }
  }

  getPlugin(name: string): PsyPlugin | undefined {
    return this.plugins.get(name)
  }

  private resolveOrder(): string[] {
    // Build adjacency: plugin → [plugins it depends on]
    const depGraph = new Map<string, string[]>()

    for (const [name, plugin] of this.plugins) {
      const deps: string[] = []
      if (plugin.depends) {
        for (const dep of plugin.depends) {
          // dep can be a plugin name or a capability
          const resolvedName = this.plugins.has(dep)
            ? dep
            : this.provides.get(dep)

          if (!resolvedName) {
            throw new DependencyError(name, dep)
          }
          deps.push(resolvedName)
        }
      }
      depGraph.set(name, deps)
    }

    // Topological sort (Kahn's algorithm)
    // inDeg[node] = number of unresolved dependencies
    const inDeg = new Map<string, number>()
    for (const [name, deps] of depGraph) {
      inDeg.set(name, deps.length)
    }

    const queue: string[] = []
    for (const [name, deg] of inDeg) {
      if (deg === 0) queue.push(name)
    }

    const order: string[] = []
    while (queue.length > 0) {
      const current = queue.shift()!
      order.push(current)

      // Find plugins that depend on current and decrement their inDegree
      for (const [name, deps] of depGraph) {
        if (deps.includes(current)) {
          const newDeg = inDeg.get(name)! - 1
          inDeg.set(name, newDeg)
          if (newDeg === 0) {
            queue.push(name)
          }
        }
      }
    }

    if (order.length !== this.plugins.size) {
      // Find the cycle
      const remaining = [...this.plugins.keys()].filter(n => !order.includes(n))
      throw new CircularDependencyError(remaining)
    }

    return order
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/core && npx vitest run tests/plugin-registry.test.ts`
Expected: All 7 tests PASS

- [ ] **Step 5: Commit**

Run: `git add packages/core/src/plugin-registry.ts packages/core/tests/plugin-registry.test.ts && git commit -m "feat(core): add plugin registry with dependency resolution"`

---

### Task 5: Middleware Pipeline

**Files:**
- Create: `packages/core/src/middleware-pipeline.ts`
- Test: `packages/core/tests/middleware-pipeline.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/tests/middleware-pipeline.test.ts
import { describe, it, expect, vi } from 'vitest'
import { MiddlewarePipeline } from '../src/middleware-pipeline.js'
import type { JobContext, Middleware, LifecycleEvent } from '../src/types.js'

function mockCtx(overrides: Partial<JobContext> = {}): JobContext {
  return {
    job: { id: 'test', queue: 'test', name: 'test', payload: {}, priority: 0, maxRetries: 3, attempt: 1, backoff: 'exponential', timeout: 30000, status: 'pending', createdAt: new Date(), meta: {} } as any,
    event: 'process',
    state: {},
    requeue: vi.fn(),
    deadLetter: vi.fn(),
    breaker: vi.fn(),
    updateJob: vi.fn(),
    enqueue: vi.fn(),
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ...overrides,
  }
}

describe('MiddlewarePipeline', () => {
  it('executes middleware in phase order', async () => {
    const pipeline = new MiddlewarePipeline()
    const order: string[] = []

    pipeline.add('process', async (_ctx, next) => { order.push('execute'); await next() }, { phase: 'execute', pluginName: 'a' })
    pipeline.add('process', async (_ctx, next) => { order.push('guard'); await next() }, { phase: 'guard', pluginName: 'b' })
    pipeline.add('process', async (_ctx, next) => { order.push('finalize'); await next() }, { phase: 'finalize', pluginName: 'c' })

    await pipeline.run('process', mockCtx())
    expect(order).toEqual(['guard', 'execute', 'finalize'])
  })

  it('allows middleware to short-circuit by not calling next', async () => {
    const pipeline = new MiddlewarePipeline()
    const reached = vi.fn()

    pipeline.add('enqueue', async (_ctx, _next) => { /* no next() */ }, { phase: 'guard', pluginName: 'a' })
    pipeline.add('enqueue', async (_ctx, next) => { reached(); await next() }, { phase: 'execute', pluginName: 'b' })

    await pipeline.run('enqueue', mockCtx())
    expect(reached).not.toHaveBeenCalled()
  })

  it('allows wrapping next() for before/after logic', async () => {
    const pipeline = new MiddlewarePipeline()
    const log: string[] = []

    pipeline.add('process', async (_ctx, next) => {
      log.push('before')
      await next()
      log.push('after')
    }, { phase: 'observe', pluginName: 'a' })

    pipeline.add('process', async (_ctx, next) => {
      log.push('handler')
      await next()
    }, { phase: 'execute', pluginName: 'b' })

    await pipeline.run('process', mockCtx())
    expect(log).toEqual(['before', 'handler', 'after'])
  })

  it('propagates errors from middleware', async () => {
    const pipeline = new MiddlewarePipeline()
    pipeline.add('process', async () => { throw new Error('boom') }, { phase: 'execute', pluginName: 'a' })

    await expect(pipeline.run('process', mockCtx())).rejects.toThrow('boom')
  })

  it('defaults to execute phase when none specified', async () => {
    const pipeline = new MiddlewarePipeline()
    const order: string[] = []

    pipeline.add('process', async (_ctx, next) => { order.push('guard'); await next() }, { phase: 'guard', pluginName: 'a' })
    pipeline.add('process', async (_ctx, next) => { order.push('default'); await next() }, { pluginName: 'b' })

    await pipeline.run('process', mockCtx())
    expect(order).toEqual(['guard', 'default'])
  })

  it('handles empty pipeline gracefully', async () => {
    const pipeline = new MiddlewarePipeline()
    await expect(pipeline.run('process', mockCtx())).resolves.toBeUndefined()
  })

  it('maintains separate chains per lifecycle event', async () => {
    const pipeline = new MiddlewarePipeline()
    const enqueueHandler = vi.fn(async (_c: JobContext, next: () => Promise<void>) => { await next() })
    const processHandler = vi.fn(async (_c: JobContext, next: () => Promise<void>) => { await next() })

    pipeline.add('enqueue', enqueueHandler, { phase: 'execute', pluginName: 'a' })
    pipeline.add('process', processHandler, { phase: 'execute', pluginName: 'b' })

    await pipeline.run('enqueue', mockCtx())
    expect(enqueueHandler).toHaveBeenCalledOnce()
    expect(processHandler).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && npx vitest run tests/middleware-pipeline.test.ts`
Expected: FAIL — MiddlewarePipeline not found

- [ ] **Step 3: Implement MiddlewarePipeline**

```ts
// packages/core/src/middleware-pipeline.ts
import type { Middleware, MiddlewarePhase, LifecycleEvent, JobContext } from './types.js'

const PHASE_ORDER: MiddlewarePhase[] = ['guard', 'validate', 'transform', 'observe', 'execute', 'finalize']

interface StoredMiddleware {
  phase: MiddlewarePhase
  fn: Middleware
  pluginName: string
  index: number // registration order for stable sort within phase
}

export class MiddlewarePipeline {
  private chains = new Map<LifecycleEvent, StoredMiddleware[]>()
  private counter = 0

  add(
    event: LifecycleEvent,
    fn: Middleware,
    opts: { phase?: MiddlewarePhase; pluginName: string }
  ): void {
    if (!this.chains.has(event)) {
      this.chains.set(event, [])
    }
    this.chains.get(event)!.push({
      phase: opts.phase ?? 'execute',
      fn,
      pluginName: opts.pluginName,
      index: this.counter++,
    })
  }

  async run(event: LifecycleEvent, ctx: JobContext): Promise<void> {
    const chain = this.chains.get(event)
    if (!chain || chain.length === 0) return

    // Sort: by phase order first, then by registration index within same phase
    const sorted = [...chain].sort((a, b) => {
      const phaseA = PHASE_ORDER.indexOf(a.phase)
      const phaseB = PHASE_ORDER.indexOf(b.phase)
      if (phaseA !== phaseB) return phaseA - phaseB
      return a.index - b.index
    })

    // Build the Koa-style composed middleware chain
    const dispatch = (i: number): Promise<void> => {
      if (i >= sorted.length) return Promise.resolve()
      const mw = sorted[i]!
      return mw.fn(ctx, () => dispatch(i + 1))
    }

    await dispatch(0)
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/core && npx vitest run tests/middleware-pipeline.test.ts`
Expected: All 7 tests PASS

- [ ] **Step 5: Commit**

Run: `git add packages/core/src/middleware-pipeline.ts packages/core/tests/middleware-pipeline.test.ts && git commit -m "feat(core): add phase-ordered middleware pipeline"`

---

### Task 6: Job Creation & ULID

**Files:**
- Create: `packages/core/src/job.ts`
- Test: `packages/core/tests/job.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/tests/job.test.ts
import { describe, it, expect } from 'vitest'
import { createJob, generateId } from '../src/job.js'

describe('generateId', () => {
  it('returns a 26-character ULID string', () => {
    const id = generateId()
    expect(id).toHaveLength(26)
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
  })

  it('generates unique IDs', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateId()))
    expect(ids.size).toBe(100)
  })

  it('generates sortable IDs (later IDs sort higher)', () => {
    const id1 = generateId()
    const id2 = generateId()
    expect(id2 > id1).toBe(true)
  })
})

describe('createJob', () => {
  it('creates a job with defaults', () => {
    const job = createJob('email.send', { to: 'a@b.com' })
    expect(job.id).toHaveLength(26)
    expect(job.queue).toBe('email.send')
    expect(job.name).toBe('email.send')
    expect(job.payload).toEqual({ to: 'a@b.com' })
    expect(job.priority).toBe(0)
    expect(job.maxRetries).toBe(3)
    expect(job.attempt).toBe(1)
    expect(job.backoff).toBe('exponential')
    expect(job.timeout).toBe(30000)
    expect(job.status).toBe('pending')
    expect(job.meta).toEqual({})
    expect(job.createdAt).toBeInstanceOf(Date)
  })

  it('applies options overrides', () => {
    const deadline = new Date('2026-03-20')
    const job = createJob('payment.charge', { amount: 99 }, {
      queue: 'payments',
      priority: 80,
      deadline,
      tenantId: 'tenant_123',
      idempotencyKey: 'key_123',
      maxRetries: 5,
      timeout: 60000,
      backoff: 'fixed',
      meta: { source: 'api' },
    })
    expect(job.queue).toBe('payments')
    expect(job.priority).toBe(80)
    expect(job.deadline).toBe(deadline)
    expect(job.tenantId).toBe('tenant_123')
    expect(job.idempotencyKey).toBe('key_123')
    expect(job.maxRetries).toBe(5)
    expect(job.timeout).toBe(60000)
    expect(job.backoff).toBe('fixed')
    expect(job.meta).toEqual({ source: 'api' })
  })

  it('defaults queue to job name', () => {
    const job = createJob('email.send', {})
    expect(job.queue).toBe('email.send')
  })

  it('sets status to scheduled when runAt is provided', () => {
    const runAt = new Date(Date.now() + 60000)
    const job = createJob('test', {}, { runAt })
    expect(job.status).toBe('scheduled')
    expect(job.runAt).toBe(runAt)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && npx vitest run tests/job.test.ts`
Expected: FAIL — modules not found

- [ ] **Step 3: Implement job.ts**

First add `ulidx` dependency:
Run: `cd packages/core && pnpm add ulidx`

```ts
// packages/core/src/job.ts
import { ulid } from 'ulidx'
import type { Job, EnqueueOpts } from './types.js'

export function generateId(): string {
  return ulid()
}

export function createJob(name: string, payload: unknown, opts: EnqueueOpts = {}): Job {
  const hasRunAt = opts.runAt != null && opts.runAt > new Date()

  return {
    id: generateId(),
    queue: opts.queue ?? name,
    name,
    payload,

    priority: opts.priority ?? 0,
    deadline: opts.deadline,
    runAt: opts.runAt,
    cron: opts.cron,

    tenantId: opts.tenantId,

    idempotencyKey: opts.idempotencyKey,
    maxRetries: opts.maxRetries ?? 3,
    attempt: 1,
    backoff: opts.backoff ?? 'exponential',
    backoffBase: opts.backoffBase,
    backoffCap: opts.backoffCap,
    backoffJitter: opts.backoffJitter,
    timeout: opts.timeout ?? 30_000,

    status: hasRunAt ? 'scheduled' : 'pending',

    createdAt: new Date(),
    meta: opts.meta ? { ...opts.meta } : {},
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/core && npx vitest run tests/job.test.ts`
Expected: All 7 tests PASS

- [ ] **Step 5: Commit**

Run: `git add packages/core/src/job.ts packages/core/tests/job.test.ts packages/core/package.json && git commit -m "feat(core): add job creation with ULID generation"`

---

### Task 7: PsyQueue Kernel Class

**Files:**
- Create: `packages/core/src/kernel.ts`
- Create: `packages/core/src/context.ts`
- Create: `packages/core/src/index.ts`
- Test: `packages/core/tests/kernel.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/tests/kernel.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { PsyQueue } from '../src/kernel.js'
import type { PsyPlugin, BackendAdapter, Job, DequeuedJob, AckResult } from '../src/types.js'

function makeMockBackend(): BackendAdapter {
  const jobs = new Map<string, Job>()
  return {
    name: 'mock',
    type: 'mock',
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    healthCheck: vi.fn(async () => true),
    enqueue: vi.fn(async (job: Job) => { jobs.set(job.id, job); return job.id }),
    enqueueBulk: vi.fn(async (bulk: Job[]) => { bulk.forEach(j => jobs.set(j.id, j)); return bulk.map(j => j.id) }),
    dequeue: vi.fn(async () => []),
    ack: vi.fn(async () => ({ alreadyCompleted: false })),
    nack: vi.fn(async () => {}),
    getJob: vi.fn(async (id: string) => jobs.get(id) ?? null),
    listJobs: vi.fn(async () => ({ data: [], total: 0, limit: 50, offset: 0, hasMore: false })),
    scheduleAt: vi.fn(async (job: Job) => job.id),
    pollScheduled: vi.fn(async () => []),
    acquireLock: vi.fn(async () => true),
    releaseLock: vi.fn(async () => {}),
    atomic: vi.fn(async () => {}),
  }
}

function mockBackendPlugin(backend: BackendAdapter): PsyPlugin {
  return {
    name: 'mock-backend',
    version: '1.0.0',
    provides: 'backend',
    init(kernel) {
      kernel.expose('backend', backend)
    },
    start: async () => { await backend.connect() },
    stop: async () => { await backend.disconnect() },
  }
}

describe('PsyQueue', () => {
  let q: PsyQueue

  afterEach(async () => {
    if (q) await q.stop().catch(() => {})
  })

  it('registers plugins with use()', () => {
    q = new PsyQueue()
    const plugin = mockBackendPlugin(makeMockBackend())
    q.use(plugin)
    // No error = success
  })

  it('starts and stops cleanly', async () => {
    q = new PsyQueue()
    const backend = makeMockBackend()
    q.use(mockBackendPlugin(backend))
    await q.start()
    expect(backend.connect).toHaveBeenCalled()
    await q.stop()
    expect(backend.disconnect).toHaveBeenCalled()
  })

  it('enqueues a job through the middleware pipeline', async () => {
    q = new PsyQueue()
    const backend = makeMockBackend()
    q.use(mockBackendPlugin(backend))
    await q.start()

    const jobId = await q.enqueue('email.send', { to: 'test@example.com' })
    expect(jobId).toBeTruthy()
    expect(backend.enqueue).toHaveBeenCalled()
  })

  it('registers and calls job handlers', async () => {
    q = new PsyQueue()
    const backend = makeMockBackend()
    q.use(mockBackendPlugin(backend))

    const handler = vi.fn(async () => ({ sent: true }))
    q.handle('email.send', handler)

    await q.start()
    // Handler is registered — actual processing tested in integration
    expect(handler).not.toHaveBeenCalled() // not called until dequeue
  })

  it('exposes events bus for subscriptions', async () => {
    q = new PsyQueue()
    const backend = makeMockBackend()
    q.use(mockBackendPlugin(backend))

    const handler = vi.fn()
    q.events.on('job:enqueued', handler)
    await q.start()

    await q.enqueue('test.job', {})
    expect(handler).toHaveBeenCalled()
  })

  it('allows pipeline middleware registration', async () => {
    q = new PsyQueue()
    const backend = makeMockBackend()
    q.use(mockBackendPlugin(backend))

    const order: string[] = []
    q.pipeline('enqueue', async (ctx, next) => {
      order.push('user-middleware')
      await next()
    }, { phase: 'observe' })

    await q.start()
    await q.enqueue('test', {})
    expect(order).toContain('user-middleware')
  })

  it('throws if started without a backend', async () => {
    q = new PsyQueue()
    await expect(q.start()).rejects.toThrow()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && npx vitest run tests/kernel.test.ts`
Expected: FAIL — PsyQueue not found

- [ ] **Step 3: Implement context.ts and kernel.ts**

```ts
// packages/core/src/context.ts
import type { Job, JobContext, LifecycleEvent, EnqueueOpts, Logger } from './types.js'

export function createContext(
  job: Job,
  event: LifecycleEvent,
  internals: {
    enqueue: (name: string, payload: unknown, opts?: EnqueueOpts) => Promise<string>
    updateJob: (jobId: string, updates: Partial<Job>) => Promise<void>
  }
): JobContext {
  const log: Logger = {
    debug: (msg, data) => console.debug(`[${job.id}] ${msg}`, data ?? ''),
    info: (msg, data) => console.info(`[${job.id}] ${msg}`, data ?? ''),
    warn: (msg, data) => console.warn(`[${job.id}] ${msg}`, data ?? ''),
    error: (msg, data) => console.error(`[${job.id}] ${msg}`, data ?? ''),
  }

  let requeueRequested = false
  let deadLetterReason: string | undefined

  const ctx: JobContext = {
    job,
    event,
    state: {},
    log,

    requeue(opts) {
      requeueRequested = true
      ctx.state['_requeue'] = opts
    },

    deadLetter(reason) {
      deadLetterReason = reason
      ctx.state['_deadLetter'] = reason
    },

    async breaker(_name, fn) {
      // Default: just call the function. Circuit breaker plugin overrides this.
      return fn()
    },

    async updateJob(updates) {
      await internals.updateJob(job.id, updates)
      Object.assign(job, updates)
    },

    async enqueue(name, payload, opts) {
      return internals.enqueue(name, payload, opts)
    },
  }

  return ctx
}
```

```ts
// packages/core/src/kernel.ts
import { EventBus } from './event-bus.js'
import { PluginRegistry } from './plugin-registry.js'
import { MiddlewarePipeline } from './middleware-pipeline.js'
import { createJob } from './job.js'
import { createContext } from './context.js'
import { PsyQueueError } from './errors.js'
import type {
  PsyPlugin,
  Kernel,
  BackendAdapter,
  LifecycleEvent,
  Middleware,
  MiddlewarePhase,
  EnqueueOpts,
  JobHandler,
  HandlerOpts,
  Job,
  EventBusInterface,
} from './types.js'

export class PsyQueue {
  public readonly events: EventBusInterface
  private readonly eventBus: EventBus
  private readonly pipeline_: MiddlewarePipeline
  private readonly registry: PluginRegistry
  private readonly exposed = new Map<string, Record<string, unknown>>()
  private readonly handlers = new Map<string, { handler: JobHandler; opts: HandlerOpts }>()
  private backend: BackendAdapter | null = null
  private started = false

  constructor() {
    this.eventBus = new EventBus()
    this.events = this.eventBus
    this.pipeline_ = new MiddlewarePipeline()

    const kernel: Kernel = {
      events: this.eventBus,
      pipeline: (event, fn, opts) => this.pipeline_.add(event, fn, {
        phase: opts?.phase ?? 'execute',
        pluginName: 'kernel',
      }),
      getBackend: () => {
        if (!this.backend) throw new PsyQueueError('NO_BACKEND', 'No backend registered')
        return this.backend
      },
      expose: (namespace, api) => {
        this.exposed.set(namespace, api)
        if (namespace === 'backend') {
          this.backend = api as unknown as BackendAdapter
        }
      },
    }

    this.registry = new PluginRegistry(kernel)

    // Register core enqueue middleware that persists to backend
    this.pipeline_.add('enqueue', async (ctx, next) => {
      if (!this.backend) throw new PsyQueueError('NO_BACKEND', 'No backend registered')
      const jobId = await this.backend.enqueue(ctx.job)
      ctx.job.id = jobId
      await next()
    }, { phase: 'execute', pluginName: 'kernel' })
  }

  use(plugin: PsyPlugin): this {
    this.registry.register(plugin)
    return this
  }

  pipeline(
    event: LifecycleEvent,
    fn: Middleware,
    opts?: { phase?: MiddlewarePhase }
  ): this {
    this.pipeline_.add(event, fn, {
      phase: opts?.phase ?? 'execute',
      pluginName: 'user',
    })
    return this
  }

  handle(name: string, handler: JobHandler, opts: HandlerOpts = {}): this {
    this.handlers.set(name, { handler, opts })
    return this
  }

  async start(): Promise<void> {
    if (!this.backend) {
      throw new PsyQueueError('NO_BACKEND', 'No backend plugin registered. Install @psyqueue/backend-sqlite, @psyqueue/backend-redis, or @psyqueue/backend-postgres')
    }
    this.eventBus.emit('kernel:starting', {}, 'kernel')
    await this.registry.startAll()
    this.started = true
    this.eventBus.emit('kernel:started', {}, 'kernel')
  }

  async stop(): Promise<void> {
    this.eventBus.emit('kernel:stopping', {}, 'kernel')
    await this.registry.stopAll()
    this.started = false
    this.eventBus.emit('kernel:stopped', {}, 'kernel')
  }

  async enqueue(name: string, payload: unknown, opts?: EnqueueOpts): Promise<string> {
    const job = createJob(name, payload, opts)
    const ctx = createContext(job, 'enqueue', {
      enqueue: (n, p, o) => this.enqueue(n, p, o),
      updateJob: async (id, updates) => {
        if (this.backend) await this.backend.atomic([{ type: 'update', jobId: id, updates }])
      },
    })
    await this.pipeline_.run('enqueue', ctx)
    this.eventBus.emit('job:enqueued', { jobId: job.id, queue: job.queue, name: job.name }, 'kernel')
    return job.id
  }

  async enqueueBulk(items: Array<{ name: string; payload: unknown; opts?: EnqueueOpts }>): Promise<string[]> {
    if (!this.backend) throw new PsyQueueError('NO_BACKEND', 'No backend registered')
    const jobs = items.map(({ name, payload, opts }) => createJob(name, payload, opts))
    const ids = await this.backend.enqueueBulk(jobs)
    for (const job of jobs) {
      this.eventBus.emit('job:enqueued', { jobId: job.id, queue: job.queue, name: job.name }, 'kernel')
    }
    return ids
  }

  getHandler(name: string): { handler: JobHandler; opts: HandlerOpts } | undefined {
    return this.handlers.get(name)
  }
}
```

```ts
// packages/core/src/index.ts
export { PsyQueue } from './kernel.js'
export { EventBus } from './event-bus.js'
export { PluginRegistry } from './plugin-registry.js'
export { MiddlewarePipeline } from './middleware-pipeline.js'
export { createJob, generateId } from './job.js'
export { createContext } from './context.js'
export * from './types.js'
export * from './errors.js'
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/core && npx vitest run tests/kernel.test.ts`
Expected: All 7 tests PASS

- [ ] **Step 5: Run all core tests and commit**

Run: `cd packages/core && npx vitest run`
Expected: All tests PASS across all test files

Run: `git add packages/core/src/ packages/core/tests/ && git commit -m "feat(core): add PsyQueue kernel with enqueue, handlers, events, and pipeline"`

---

## Phase 2: SQLite Backend

### Task 8: SQLite Backend Adapter

**Files:**
- Create: `packages/backend-sqlite/package.json`
- Create: `packages/backend-sqlite/tsconfig.json`
- Create: `packages/backend-sqlite/vitest.config.ts`
- Create: `packages/backend-sqlite/src/schema.ts`
- Create: `packages/backend-sqlite/src/queries.ts`
- Create: `packages/backend-sqlite/src/adapter.ts`
- Create: `packages/backend-sqlite/src/index.ts`
- Test: `packages/backend-sqlite/tests/adapter.test.ts`

- [ ] **Step 1: Scaffold backend-sqlite package**

```json
// packages/backend-sqlite/package.json
{
  "name": "@psyqueue/backend-sqlite",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } },
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "clean": "rm -rf dist"
  },
  "dependencies": {
    "better-sqlite3": "^11.0.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.0",
    "vitest": "^3.0.0"
  },
  "peerDependencies": {
    "psyqueue": "workspace:*"
  }
}
```

Run: `cd packages/backend-sqlite && pnpm install`

- [ ] **Step 2: Write the failing test**

```ts
// packages/backend-sqlite/tests/adapter.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { SQLiteBackendAdapter } from '../src/adapter.js'
import { createJob } from 'psyqueue'

describe('SQLiteBackendAdapter', () => {
  let adapter: SQLiteBackendAdapter

  beforeEach(async () => {
    adapter = new SQLiteBackendAdapter({ path: ':memory:' })
    await adapter.connect()
  })

  afterEach(async () => {
    await adapter.disconnect()
  })

  it('connects and passes health check', async () => {
    expect(await adapter.healthCheck()).toBe(true)
  })

  it('enqueues and retrieves a job', async () => {
    const job = createJob('email.send', { to: 'a@b.com' })
    const id = await adapter.enqueue(job)
    expect(id).toBe(job.id)

    const retrieved = await adapter.getJob(id)
    expect(retrieved).not.toBeNull()
    expect(retrieved!.name).toBe('email.send')
    expect(retrieved!.payload).toEqual({ to: 'a@b.com' })
  })

  it('dequeues jobs atomically with completion token', async () => {
    const job = createJob('test', { n: 1 })
    await adapter.enqueue(job)

    const dequeued = await adapter.dequeue('test', 1)
    expect(dequeued).toHaveLength(1)
    expect(dequeued[0]!.id).toBe(job.id)
    expect(dequeued[0]!.status).toBe('active')
    expect(dequeued[0]!.completionToken).toBeTruthy()

    // Second dequeue returns empty — job is locked
    const second = await adapter.dequeue('test', 1)
    expect(second).toHaveLength(0)
  })

  it('acks a job', async () => {
    const job = createJob('test', {})
    await adapter.enqueue(job)
    const [dequeued] = await adapter.dequeue('test', 1)

    const result = await adapter.ack(dequeued!.id, dequeued!.completionToken)
    expect(result.alreadyCompleted).toBe(false)

    const completed = await adapter.getJob(job.id)
    expect(completed!.status).toBe('completed')
  })

  it('ack returns alreadyCompleted for wrong token', async () => {
    const job = createJob('test', {})
    await adapter.enqueue(job)
    const [dequeued] = await adapter.dequeue('test', 1)
    await adapter.ack(dequeued!.id, dequeued!.completionToken)

    const result = await adapter.ack(dequeued!.id, 'wrong-token')
    expect(result.alreadyCompleted).toBe(true)
  })

  it('nacks and requeues a job', async () => {
    const job = createJob('test', {})
    await adapter.enqueue(job)
    const [dequeued] = await adapter.dequeue('test', 1)
    await adapter.nack(dequeued!.id, { requeue: true })

    const requeued = await adapter.getJob(job.id)
    expect(requeued!.status).toBe('pending')
  })

  it('enqueueBulk inserts multiple jobs atomically', async () => {
    const jobs = [createJob('a', {}), createJob('b', {}), createJob('c', {})]
    const ids = await adapter.enqueueBulk(jobs)
    expect(ids).toHaveLength(3)

    for (const id of ids) {
      const j = await adapter.getJob(id)
      expect(j).not.toBeNull()
    }
  })

  it('listJobs with filters', async () => {
    await adapter.enqueue(createJob('email.send', {}, { tenantId: 'a' }))
    await adapter.enqueue(createJob('email.send', {}, { tenantId: 'b' }))
    await adapter.enqueue(createJob('sms.send', {}, { tenantId: 'a' }))

    const result = await adapter.listJobs({ tenantId: 'a' })
    expect(result.data).toHaveLength(2)
    expect(result.total).toBe(2)
  })

  it('scheduleAt and pollScheduled', async () => {
    const job = createJob('scheduled', {})
    const past = new Date(Date.now() - 1000)
    await adapter.scheduleAt(job, past)

    const due = await adapter.pollScheduled(new Date(), 10)
    expect(due).toHaveLength(1)
    expect(due[0]!.id).toBe(job.id)
    expect(due[0]!.status).toBe('pending')
  })

  it('acquireLock and releaseLock', async () => {
    const acquired = await adapter.acquireLock('my-lock', 5000)
    expect(acquired).toBe(true)

    const second = await adapter.acquireLock('my-lock', 5000)
    expect(second).toBe(false)

    await adapter.releaseLock('my-lock')
    const third = await adapter.acquireLock('my-lock', 5000)
    expect(third).toBe(true)
  })

  it('respects priority ordering on dequeue', async () => {
    await adapter.enqueue(createJob('q', { n: 1 }, { priority: 10 }))
    await adapter.enqueue(createJob('q', { n: 2 }, { priority: 50 }))
    await adapter.enqueue(createJob('q', { n: 3 }, { priority: 30 }))

    const dequeued = await adapter.dequeue('q', 3)
    expect(dequeued.map(j => (j.payload as any).n)).toEqual([2, 3, 1])
  })
})
```

- [ ] **Step 3: Implement schema.ts, queries.ts, adapter.ts, index.ts**

The implementation should:
- `schema.ts`: Export `initSchema(db)` — runs CREATE TABLE + CREATE INDEX statements from the spec (Section 5, SQLite schema)
- `queries.ts`: Export parameterized query builders for enqueue, dequeue (UPDATE...RETURNING with priority DESC ordering), ack, nack, getJob, listJobs, scheduleAt, pollScheduled, acquireLock, releaseLock
- `adapter.ts`: `SQLiteBackendAdapter` class implementing `BackendAdapter`. Uses `better-sqlite3` synchronous API wrapped in async signatures. `dequeue` generates a UUID `completionToken` and stores it in a `completion_token` column. `ack` verifies token match atomically.
- `index.ts`: Export `sqlite(opts)` function returning a `PsyPlugin` that exposes the adapter as the backend

Key implementation details:
- Dequeue: `UPDATE jobs SET status='active', started_at=?, completion_token=? WHERE id IN (SELECT id FROM jobs WHERE queue=? AND status='pending' ORDER BY priority DESC, created_at ASC LIMIT ?) RETURNING *`
- Ack: `UPDATE jobs SET status='completed', completed_at=? WHERE id=? AND completion_token=?` — check `changes === 0` to detect already-completed
- Lock table: `CREATE TABLE locks (key TEXT PRIMARY KEY, expires_at TEXT)`
- All mutations in transactions for atomicity

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/backend-sqlite && npx vitest run`
Expected: All tests PASS

- [ ] **Step 5: Commit**

Run: `git add packages/backend-sqlite/ && git commit -m "feat(backend-sqlite): implement SQLite backend adapter with full test suite"`

---

## Phase 3: Integration — Working Queue

### Task 9: End-to-End Job Processing Integration Test

**Files:**
- Create: `packages/core/tests/integration.test.ts`
- Modify: `packages/core/src/kernel.ts` (add worker loop)

- [ ] **Step 1: Write the integration test**

```ts
// packages/core/tests/integration.test.ts
import { describe, it, expect, vi } from 'vitest'
import { PsyQueue } from '../src/kernel.js'
import { sqlite } from '@psyqueue/backend-sqlite'

describe('PsyQueue Integration', () => {
  it('enqueues, dequeues, and processes a job end-to-end', async () => {
    const q = new PsyQueue()
    q.use(sqlite({ path: ':memory:' }))

    const results: unknown[] = []
    q.handle('email.send', async (ctx) => {
      results.push(ctx.job.payload)
      return { sent: true }
    })

    await q.start()

    await q.enqueue('email.send', { to: 'test@example.com' })

    // Trigger processing manually (worker loop)
    await q.processNext('email.send')

    expect(results).toEqual([{ to: 'test@example.com' }])

    await q.stop()
  })

  it('retries failed jobs with exponential backoff', async () => {
    const q = new PsyQueue()
    q.use(sqlite({ path: ':memory:' }))

    let attempts = 0
    q.handle('flaky', async () => {
      attempts++
      if (attempts < 3) throw new Error('temporary failure')
      return { ok: true }
    })

    await q.start()
    await q.enqueue('flaky', {}, { maxRetries: 5 })

    // Process until success
    await q.processNext('flaky') // attempt 1 - fails
    await q.processNext('flaky') // attempt 2 - fails
    await q.processNext('flaky') // attempt 3 - succeeds

    expect(attempts).toBe(3)
    await q.stop()
  })

  it('moves exhausted jobs to dead letter', async () => {
    const q = new PsyQueue()
    q.use(sqlite({ path: ':memory:' }))

    q.handle('always-fails', async () => {
      throw new Error('permanent failure')
    })

    await q.start()
    await q.enqueue('always-fails', {}, { maxRetries: 1 })

    await q.processNext('always-fails') // attempt 1
    await q.processNext('always-fails') // attempt 2 (last retry) → dead letter

    const dead = await q.deadLetter.list({ queue: 'always-fails' })
    expect(dead.data).toHaveLength(1)

    await q.stop()
  })

  it('emits lifecycle events', async () => {
    const q = new PsyQueue()
    q.use(sqlite({ path: ':memory:' }))
    q.handle('test', async () => ({ done: true }))

    const events: string[] = []
    q.events.on('job:enqueued', () => events.push('enqueued'))
    q.events.on('job:started', () => events.push('started'))
    q.events.on('job:completed', () => events.push('completed'))

    await q.start()
    await q.enqueue('test', {})
    await q.processNext('test')

    expect(events).toEqual(['enqueued', 'started', 'completed'])
    await q.stop()
  })
})
```

- [ ] **Step 2: Add `processNext()`, `deadLetter`, error classification, and graceful shutdown to kernel**

Add to `kernel.ts`:
- `processNext(queue)`: Dequeues one job, runs it through `process` middleware pipeline with the registered handler. On success: acks job, emits `job:completed`. On failure: classifies error using handler's `errors` config (match function determines category), applies category action (`retry` with backoff / `dead-letter` / `fail`). If retry: increment attempt, compute backoff delay (`exponential`: `base * 2^attempt` capped at `backoffCap`, with optional jitter), nack with delay. If attempts exhausted: move to dead letter.
- `deadLetter.list(filter)`: Queries backend for jobs with status `'dead'` using `JobFilter`
- `deadLetter.replay(jobId)`: Resets a dead job to `pending` with attempt=1
- `deadLetter.replayAll(filter, opts?)`: Replays all dead jobs matching filter. Optional `modifyPayload: (payload) => newPayload` to transform payloads before replay.
- `deadLetter.purge(opts)`: Deletes dead jobs matching `{ olderThan: '30d' }` duration string
- Signal handling: Listen for `SIGTERM`/`SIGINT`, call `stop()`. `stop()` sets `stopping=true`, waits for active jobs to finish (up to `shutdownTimeout`), requeues jobs that don't finish in time, flushes WAL if crash-recovery plugin is active, closes backend.

```ts
// Error classification config on handlers:
q.handle('payment.charge', handler, {
  errors: {
    transient: {
      match: (err: Error) => (err as any).code === 'ECONNREFUSED',
      action: 'retry',
      backoff: 'exponential',
      maxRetries: 5,
    },
    validation: {
      match: (err: Error) => err.name === 'ValidationError',
      action: 'dead-letter',
    },
    unknown: { action: 'retry', backoff: 'exponential', maxRetries: 3 },
  },
})
```

- [ ] **Step 3: Run integration tests**

Run: `cd packages/core && npx vitest run tests/integration.test.ts`
Expected: All 4 tests PASS

- [ ] **Step 4: Run full test suite**

Run: `pnpm test`
Expected: All tests PASS across core + backend-sqlite

- [ ] **Step 5: Commit**

Run: `git add packages/core/ && git commit -m "feat(core): add job processing, retry logic, dead letter queue, and integration tests"`

---

## Plugin Implementation Pattern

**Every plugin from Phase 4 onward follows this exact pattern.** Use this as a template.

### Package Scaffolding

Every plugin package has this structure (replace `plugin-name` and `@psyqueue/plugin-name`):

```json
// packages/plugin-name/package.json
{
  "name": "@psyqueue/plugin-name",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } },
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "clean": "rm -rf dist"
  },
  "peerDependencies": { "psyqueue": "workspace:*" }
}
```

```json
// packages/plugin-name/tsconfig.json
{ "extends": "../../tsconfig.base.json", "compilerOptions": { "outDir": "dist", "rootDir": "src" }, "include": ["src"] }
```

```ts
// packages/plugin-name/vitest.config.ts
import { defineConfig } from 'vitest/config'
export default defineConfig({ test: { include: ['tests/**/*.test.ts'] } })
```

### Plugin Entry Point Pattern

```ts
// packages/plugin-name/src/index.ts
import type { PsyPlugin, Kernel } from 'psyqueue'

export interface PluginNameOpts {
  // plugin-specific config
}

export function pluginName(opts: PluginNameOpts = {}): PsyPlugin {
  return {
    name: 'plugin-name',
    version: '0.1.0',
    provides: 'capability-name',  // if applicable
    depends: ['backend'],          // if applicable

    init(kernel: Kernel) {
      // Register middleware
      kernel.pipeline('process', async (ctx, next) => {
        // pre-processing logic
        await next()
        // post-processing logic
      }, { phase: 'guard' })  // or validate, transform, observe, execute, finalize

      // Subscribe to events
      kernel.events.on('job:completed', (event) => { /* ... */ })
    },

    async start() { /* async setup */ },
    async stop() { /* cleanup */ },
  }
}
```

### Test Pattern

```ts
// packages/plugin-name/tests/plugin-name.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { PsyQueue } from 'psyqueue'
import { sqlite } from '@psyqueue/backend-sqlite'
import { pluginName } from '../src/index.js'

describe('pluginName', () => {
  let q: PsyQueue

  beforeEach(async () => {
    q = new PsyQueue()
    q.use(sqlite({ path: ':memory:' }))
    q.use(pluginName({ /* test config */ }))
    await q.start()
  })

  afterEach(async () => {
    await q.stop()
  })

  it('does the thing', async () => {
    // Arrange → Act → Assert
  })
})
```

### TDD Flow Per Task

Each task follows:
1. Create package scaffolding (package.json, tsconfig, vitest.config)
2. Write failing tests (all key behaviors)
3. Run tests — verify they fail
4. Implement plugin
5. Run tests — verify they pass
6. Commit

**Note:** `pnpm install` at workspace root after creating each new package.

---

## Phase 4: Essential Plugins

### Task 10: Scheduler Plugin (delayed + cron)

**Files:**
- Create: `packages/plugin-scheduler/` (full package, use Plugin Implementation Pattern)
- Create: `packages/plugin-scheduler/src/index.ts`
- Create: `packages/plugin-scheduler/src/delayed.ts`
- Create: `packages/plugin-scheduler/src/cron.ts`
- Test: `packages/plugin-scheduler/tests/delayed.test.ts`
- Test: `packages/plugin-scheduler/tests/cron.test.ts`

**Dependencies:** `cron-parser`

**Public API:**

```ts
export interface SchedulerOpts {
  pollInterval?: number      // ms between polling for due jobs (default: 1000)
  cronLockTtl?: number       // ms lock TTL for cron leader election (default: 60000)
}
export function scheduler(opts?: SchedulerOpts): PsyPlugin
```

- [ ] **Step 1: Scaffold package and write failing tests**

```ts
// packages/plugin-scheduler/tests/delayed.test.ts
describe('Delayed Jobs', () => {
  it('does not process job before runAt', async () => {
    const future = new Date(Date.now() + 60_000)
    await q.enqueue('test', {}, { runAt: future })
    const processed = await q.processNext('test')
    expect(processed).toBe(false) // no job available yet
  })

  it('processes job after runAt has passed', async () => {
    const past = new Date(Date.now() - 1000)
    await q.enqueue('test', {}, { runAt: past })
    // Scheduler polls and moves to pending
    await scheduler.pollOnce() // exposed for testing
    const processed = await q.processNext('test')
    expect(processed).toBe(true)
  })
})

// packages/plugin-scheduler/tests/cron.test.ts
describe('Cron Jobs', () => {
  it('creates next occurrence after completion', async () => {
    await q.enqueue('cleanup', {}, { cron: '*/5 * * * *' })
    await scheduler.pollOnce()
    await q.processNext('cleanup')
    // After processing, a new scheduled job should exist for next 5-min mark
    const jobs = await q.backend.listJobs({ name: 'cleanup', status: 'scheduled' })
    expect(jobs.data).toHaveLength(1)
  })

  it('uses leader election — only one instance polls cron', async () => {
    // acquireLock returns false → this instance should skip
    const lockSpy = vi.spyOn(backend, 'acquireLock').mockResolvedValue(false)
    await scheduler.pollOnce()
    expect(backend.pollScheduled).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run to verify failure**
- [ ] **Step 3: Implement** — `delayed.ts` polls `backend.pollScheduled()` on interval. `cron.ts` parses cron expressions, uses `backend.acquireLock('psyqueue:cron-leader', ttl)` for leader election. Plugin registers `enqueue` transform middleware to route `runAt`/`cron` jobs through `backend.scheduleAt()`.
- [ ] **Step 4: Run tests to verify pass**
- [ ] **Step 5: Commit**

Run: `git commit -m "feat(plugin-scheduler): add delayed jobs and cron with leader election"`

---

### Task 11: Crash Recovery Plugin (WAL)

**Files:**
- Create: `packages/plugin-crash-recovery/` (full package, use Plugin Implementation Pattern)
- Create: `packages/plugin-crash-recovery/src/wal.ts`
- Create: `packages/plugin-crash-recovery/src/recovery.ts`
- Test: `packages/plugin-crash-recovery/tests/wal.test.ts`
- Test: `packages/plugin-crash-recovery/tests/recovery.test.ts`

**Public API:**

```ts
export interface CrashRecoveryOpts {
  walPath?: string              // default: './psyqueue.wal'
  flushInterval?: number        // ms (default: 100)
  autoRecover?: boolean         // default: true
  onRecoverActiveJob?: 'requeue' | 'fail' | ((job: Job) => Promise<'requeue' | 'fail' | 'dead-letter'>)
  shutdownTimeout?: number      // ms (default: 30000)
  onShutdownTimeout?: 'requeue' | 'force-kill' | 'wait-indefinitely'
}
export function crashRecovery(opts?: CrashRecoveryOpts): PsyPlugin
```

- [ ] **Step 1: Write failing tests**

```ts
// tests/wal.test.ts
describe('WriteAheadLog', () => {
  it('writes and reads entries', () => {
    const wal = new WriteAheadLog(tmpPath)
    wal.writeEntry({ jobId: 'j1', status: 'active', timestamp: Date.now() })
    wal.writeEntry({ jobId: 'j1', status: 'completed', timestamp: Date.now() })
    const entries = wal.readEntries()
    expect(entries).toHaveLength(2)
  })

  it('survives crash (entries persist to disk)', () => {
    const wal = new WriteAheadLog(tmpPath)
    wal.writeEntry({ jobId: 'j1', status: 'active', timestamp: Date.now() })
    wal.close()
    const wal2 = new WriteAheadLog(tmpPath)
    expect(wal2.readEntries()).toHaveLength(1)
  })
})

// tests/recovery.test.ts
describe('Recovery', () => {
  it('detects orphaned active jobs and requeues them', async () => {
    // Write WAL entries simulating crash: active but no completed
    wal.writeEntry({ jobId: 'j1', status: 'active', timestamp: Date.now() })
    const recovered = await recoverFromWal(wal, backend, { onRecoverActiveJob: 'requeue' })
    expect(recovered).toEqual(['j1'])
    expect(backend.nack).toHaveBeenCalledWith('j1', { requeue: true })
  })

  it('respects onRecoverActiveJob: fail', async () => {
    wal.writeEntry({ jobId: 'j1', status: 'active', timestamp: Date.now() })
    await recoverFromWal(wal, backend, { onRecoverActiveJob: 'fail' })
    expect(backend.nack).toHaveBeenCalledWith('j1', { requeue: false })
  })
})
```

- [ ] **Step 2: Run to verify failure**
- [ ] **Step 3: Implement** — `wal.ts`: append-only JSONL file writer using `fs.appendFileSync` + `fs.fsyncSync`. `recovery.ts`: reads WAL, groups by jobId, finds active without completed, applies recovery action. Plugin registers `guard` phase on `process` (write active entry) and `finalize` phase (write completed entry). On `start()`, runs auto-recovery. On `stop()`, handles graceful shutdown with SIGTERM/SIGINT listeners.
- [ ] **Step 4: Run tests to verify pass**
- [ ] **Step 5: Commit**

Run: `git commit -m "feat(plugin-crash-recovery): add write-ahead log, recovery, and graceful shutdown"`

---

### Task 12: Exactly-Once Plugin

**Files:**
- Create: `packages/plugin-exactly-once/` (full package, use Plugin Implementation Pattern)
- Create: `packages/plugin-exactly-once/src/dedup.ts`
- Create: `packages/plugin-exactly-once/src/completion-token.ts`
- Test: `packages/plugin-exactly-once/tests/exactly-once.test.ts`

**Public API:**

```ts
export interface ExactlyOnceOpts {
  window?: string              // dedup window (default: '24h')
  store?: 'backend'            // where to store dedup keys
  onDuplicate?: 'ignore' | 'reject' | ((ctx: JobContext, existingJob: Job) => Promise<void>)
  cleanup?: 'auto'
  cleanupInterval?: string     // default: '1h'
}
export function exactlyOnce(opts?: ExactlyOnceOpts): PsyPlugin
```

- [ ] **Step 1: Write failing tests**

```ts
describe('Exactly Once', () => {
  it('deduplicates enqueue with same idempotency key', async () => {
    const id1 = await q.enqueue('test', {}, { idempotencyKey: 'key1' })
    const id2 = await q.enqueue('test', {}, { idempotencyKey: 'key1' })
    expect(id1).toBe(id2) // same job returned
  })

  it('allows re-enqueue after dedup window expires', async () => {
    // Use short window for testing
    q.use(exactlyOnce({ window: '1ms' }))
    const id1 = await q.enqueue('test', {}, { idempotencyKey: 'key2' })
    await new Promise(r => setTimeout(r, 10))
    const id2 = await q.enqueue('test', {}, { idempotencyKey: 'key2' })
    expect(id1).not.toBe(id2)
  })

  it('throws on duplicate when onDuplicate is reject', async () => {
    q.use(exactlyOnce({ onDuplicate: 'reject' }))
    await q.enqueue('test', {}, { idempotencyKey: 'key3' })
    await expect(q.enqueue('test', {}, { idempotencyKey: 'key3' }))
      .rejects.toThrow('DUPLICATE_JOB')
  })

  it('jobs without idempotencyKey are not deduped', async () => {
    const id1 = await q.enqueue('test', { n: 1 })
    const id2 = await q.enqueue('test', { n: 2 })
    expect(id1).not.toBe(id2)
  })
})
```

- [ ] **Step 2: Run to verify failure**
- [ ] **Step 3: Implement** — `dedup.ts`: adds `psyqueue_dedup_keys` table (key TEXT PK, job_id TEXT, expires_at TEXT). `check()` queries by key where not expired. `store()` inserts. `cleanup()` deletes expired on interval. `completion-token.ts`: `crypto.randomUUID()` for token gen, used by backend adapter wrapper. Plugin registers `guard` phase on `enqueue` for dedup check.
- [ ] **Step 4: Run tests to verify pass**
- [ ] **Step 5: Commit**

Run: `git commit -m "feat(plugin-exactly-once): add idempotency keys and completion tokens"`

---

### Task 13: Schema Versioning Plugin

**Files:**
- Create: `packages/plugin-schema-versioning/` (full package, use Plugin Implementation Pattern)
- Create: `packages/plugin-schema-versioning/src/registry.ts`
- Create: `packages/plugin-schema-versioning/src/validator.ts`
- Test: `packages/plugin-schema-versioning/tests/schema-versioning.test.ts`

**Dependencies:** `zod`

**Public API:**

```ts
export interface VersionedHandler {
  versions: Record<number, {
    schema: ZodSchema
    process: JobHandler
    migrate?: (prevPayload: unknown) => unknown
  }>
  current: number
}
export function schemaVersioning(): PsyPlugin
```

- [ ] **Step 1: Write failing tests**

```ts
describe('Schema Versioning', () => {
  it('migrates v1 payload to v2 automatically', async () => {
    q.handle('email.send', {
      versions: {
        1: { schema: z.object({ to: z.string() }), process: handler1 },
        2: {
          schema: z.object({ to: z.array(z.string()) }),
          process: handler2,
          migrate: (v1: any) => ({ to: [v1.to] }),
        },
      },
      current: 2,
    })
    // Enqueue a v1 job directly (simulating old job in queue)
    await backend.enqueue(createJob('email.send', { to: 'a@b.com' }, { schemaVersion: 1 }))
    await q.processNext('email.send')
    expect(handler2).toHaveBeenCalled()
    expect(handler2.mock.calls[0][0].job.payload).toEqual({ to: ['a@b.com'] })
  })

  it('chains migrations v1 → v2 → v3', async () => { /* similar */ })

  it('dead-letters on schema validation failure', async () => {
    // Enqueue job with invalid payload for v2
    await backend.enqueue(createJob('email.send', { invalid: true }, { schemaVersion: 2 }))
    await q.processNext('email.send')
    const dead = await q.deadLetter.list({ name: 'email.send' })
    expect(dead.data).toHaveLength(1)
    expect(dead.data[0].error.code).toBe('SCHEMA_MISMATCH')
  })
})
```

- [ ] **Step 2: Run to verify failure**
- [ ] **Step 3: Implement** — `registry.ts`: stores versioned configs, builds migration chain between any two versions. `validator.ts`: wraps `schema.safeParse()`. Plugin registers `validate` phase on `process`: reads `job.schemaVersion`, finds migration path to `current`, applies chain, validates, updates job payload in place. On failure: `ctx.deadLetter('SCHEMA_MISMATCH')`.
- [ ] **Step 4: Run tests to verify pass**
- [ ] **Step 5: Commit**

Run: `git commit -m "feat(plugin-schema-versioning): add versioned handlers with Zod validation and auto-migration"`

---

## Phase 5: Workflow Engine

### Task 14: Workflow Builder

**Files:**
- Create: `packages/plugin-workflows/` (full package, use Plugin Implementation Pattern)
- Create: `packages/plugin-workflows/src/builder.ts`
- Create: `packages/plugin-workflows/src/engine.ts`
- Create: `packages/plugin-workflows/src/state.ts`
- Test: `packages/plugin-workflows/tests/builder.test.ts`

**Public API:**

```ts
export interface StepOpts {
  after?: string | string[]
  when?: (ctx: { results: Record<string, unknown> }) => boolean
  compensate?: JobHandler
}
export function workflow(name: string): WorkflowBuilder
// WorkflowBuilder.step(name, handler, opts?).build() => WorkflowDefinition
export function workflows(): PsyPlugin
```

- [ ] **Step 1: Write failing tests**

```ts
describe('WorkflowBuilder', () => {
  it('builds a linear DAG', () => {
    const wf = workflow('test').step('a', handlerA).step('b', handlerB, { after: 'a' }).build()
    expect(wf.steps).toHaveLength(2)
    expect(wf.steps[1].dependencies).toEqual(['a'])
  })

  it('builds parallel branches', () => {
    const wf = workflow('test')
      .step('root', h)
      .step('left', h, { after: 'root' })
      .step('right', h, { after: 'root' })
      .step('join', h, { after: ['left', 'right'] })
      .build()
    expect(wf.steps.find(s => s.name === 'join')!.dependencies).toEqual(['left', 'right'])
  })

  it('throws on cycle', () => {
    expect(() =>
      workflow('test').step('a', h, { after: 'b' }).step('b', h, { after: 'a' }).build()
    ).toThrow('cycle')
  })

  it('stores conditional when function', () => {
    const when = (ctx: any) => ctx.results.a.tier === 'premium'
    const wf = workflow('test').step('a', h).step('b', h, { after: 'a', when }).build()
    expect(wf.steps[1].when).toBe(when)
  })
})
```

- [ ] **Step 2: Run to verify failure**
- [ ] **Step 3: Implement** — `builder.ts`: fluent API that collects steps, validates DAG on `build()` using topological sort (error on cycle), returns `WorkflowDefinition` containing step names, handlers, deps, when, compensate.
- [ ] **Step 4: Run tests to verify pass**
- [ ] **Step 5: Commit**

Run: `git commit -m "feat(plugin-workflows): add fluent workflow builder with DAG validation"`

---

### Task 15: Workflow Execution Engine

**Files:**
- Modify: `packages/plugin-workflows/src/engine.ts`
- Modify: `packages/plugin-workflows/src/state.ts`
- Test: `packages/plugin-workflows/tests/engine.test.ts`
- Test: `packages/plugin-workflows/tests/state.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
describe('Workflow Engine', () => {
  it('executes sequential steps in order', async () => {
    const order: string[] = []
    const wf = workflow('seq')
      .step('a', async () => { order.push('a') })
      .step('b', async () => { order.push('b') }, { after: 'a' })
      .build()
    await q.enqueue(wf, {})
    await q.processNext('seq') // step a
    await q.processNext('seq') // step b
    expect(order).toEqual(['a', 'b'])
  })

  it('executes parallel branches concurrently', async () => {
    const wf = workflow('par')
      .step('root', async () => 'ok')
      .step('left', async () => 'L', { after: 'root' })
      .step('right', async () => 'R', { after: 'root' })
      .build()
    await q.enqueue(wf, {})
    await q.processNext('par') // root
    // Both left and right should now be pending
    const pending = await backend.listJobs({ status: 'pending', queue: 'par' })
    expect(pending.data).toHaveLength(2)
  })

  it('skips conditional step when condition is false', async () => {
    const skipped = vi.fn()
    const wf = workflow('cond')
      .step('check', async () => ({ tier: 'basic' }))
      .step('premium', skipped, { after: 'check', when: ctx => ctx.results.check.tier === 'premium' })
      .step('done', async () => 'ok', { after: ['premium'] })
      .build()
    await q.enqueue(wf, {})
    await q.processNext('cond') // check
    await q.processNext('cond') // done (premium skipped, done runs immediately)
    expect(skipped).not.toHaveBeenCalled()
  })

  it('provides prior step results in context', async () => {
    let receivedResults: any
    const wf = workflow('res')
      .step('a', async () => ({ value: 42 }))
      .step('b', async (ctx) => { receivedResults = ctx.results }, { after: 'a' })
      .build()
    await q.enqueue(wf, {})
    await q.processNext('res')
    await q.processNext('res')
    expect(receivedResults.a).toEqual({ value: 42 })
  })
})

describe('Workflow State', () => {
  it('transitions PENDING → RUNNING → COMPLETED', async () => { /* verify state at each stage */ })
  it('transitions to CANCELLED when cancel() is called', async () => { /* verify */ })
  it('resumes from last completed step after restart', async () => { /* verify persistence */ })
})
```

- [ ] **Step 2: Run to verify failure**
- [ ] **Step 3: Implement** — `state.ts`: `WorkflowInstance` class storing per-step status (pending/active/completed/skipped/failed) and results. Persisted to backend via a `psyqueue_workflows` table/key. `engine.ts`: on `job:completed` event, checks `job.workflowId`. If present: updates step status, stores result, evaluates downstream steps' `when` conditions, enqueues ready steps with auto-generated idempotency keys (`{workflowId}:{stepId}`). On `job:failed`: emits `workflow:failed`.
- [ ] **Step 4: Run tests to verify pass**
- [ ] **Step 5: Commit**

Run: `git commit -m "feat(plugin-workflows): add DAG execution engine with state machine"`

---

### Task 16: Saga Compensation

**Files:**
- Create: `packages/plugin-saga/` (full package, use Plugin Implementation Pattern)
- Create: `packages/plugin-saga/src/compensator.ts`
- Test: `packages/plugin-saga/tests/compensator.test.ts`

**Public API:**

```ts
export function saga(): PsyPlugin  // depends on 'workflows'
```

- [ ] **Step 1: Write failing tests**

```ts
describe('Saga Compensation', () => {
  it('runs compensation in reverse order on failure', async () => {
    const compensations: string[] = []
    const wf = workflow('saga')
      .step('flight', async () => ({ id: 'FL1' }), { compensate: async () => { compensations.push('cancel-flight') } })
      .step('hotel', async () => ({ id: 'HT1' }), { after: 'flight', compensate: async () => { compensations.push('cancel-hotel') } })
      .step('pay', async () => { throw new Error('declined') }, { after: 'hotel' })
      .build()
    await q.enqueue(wf, {})
    await q.processNext('saga') // flight ✓
    await q.processNext('saga') // hotel ✓
    await q.processNext('saga') // pay ✗ → triggers compensation
    // Process compensation jobs
    await q.processNext('saga') // cancel-hotel
    await q.processNext('saga') // cancel-flight
    expect(compensations).toEqual(['cancel-hotel', 'cancel-flight'])
  })

  it('sets workflow status to COMPENSATION_FAILED if compensation throws', async () => { /* ... */ })
  it('compensation receives original step results', async () => { /* ... */ })
})
```

- [ ] **Step 2: Run to verify failure**
- [ ] **Step 3: Implement** — `compensator.ts`: listens to `workflow:failed` event. Gets workflow instance, collects completed steps with `compensate` handlers, enqueues compensation jobs in reverse order (each depending on the previous compensation). On all compensations complete: set workflow status `COMPENSATED`. On compensation failure: `COMPENSATION_FAILED`. Exposes `q.workflows.retryCompensation(id)`.
- [ ] **Step 4: Run tests to verify pass**
- [ ] **Step 5: Commit**

Run: `git commit -m "feat(plugin-saga): add reverse-order saga compensation"`

---

## Phase 6: Multi-Tenancy

### Task 17: Tenancy Plugin (includes rate limiting)

**Note:** The spec lists `@psyqueue/plugin-rate-limiter` as a separate package. For v1, rate limiting is bundled within the tenancy plugin since it shares tenant tier state. It can be extracted later if standalone rate limiting is needed.

**Files:**
- Create: `packages/plugin-tenancy/` (full package, use Plugin Implementation Pattern)
- Create: `packages/plugin-tenancy/src/tiers.ts`
- Create: `packages/plugin-tenancy/src/fair-scheduler.ts`
- Create: `packages/plugin-tenancy/src/rate-limiter.ts`
- Test: `packages/plugin-tenancy/tests/fair-scheduler.test.ts`
- Test: `packages/plugin-tenancy/tests/rate-limiter.test.ts`

**Public API:**

```ts
export interface TenancyOpts {
  tiers: Record<string, { rateLimit: { max: number; window: '1s' | '1m' | '1h' }; concurrency: number; weight: number }>
  resolveTier: (tenantId: string) => Promise<string>
  scheduling: 'weighted-fair-queue' | 'round-robin' | 'strict-priority'
}
export function tenancy(opts: TenancyOpts): PsyPlugin
```

- [ ] **Step 1: Write failing tests**

```ts
// tests/fair-scheduler.test.ts
describe('Weighted Fair Queue', () => {
  it('distributes processing proportional to weight', async () => {
    // Enqueue 10 jobs for tenant A (weight 1) and 10 for tenant B (weight 10)
    for (let i = 0; i < 10; i++) {
      await q.enqueue('task', {}, { tenantId: 'a' })
      await q.enqueue('task', {}, { tenantId: 'b' })
    }
    const processed: string[] = []
    for (let i = 0; i < 10; i++) {
      const job = await q.dequeueNext('task') // uses fair scheduler
      processed.push(job.tenantId!)
    }
    // Tenant B (weight 10) should get ~10x more slots than A (weight 1)
    const bCount = processed.filter(t => t === 'b').length
    expect(bCount).toBeGreaterThanOrEqual(8) // ~90% of slots
  })
})

// tests/rate-limiter.test.ts
describe('Rate Limiter', () => {
  it('blocks enqueue when rate limit exceeded', async () => {
    // Tier free: max 2 per minute
    for (let i = 0; i < 2; i++) {
      await q.enqueue('task', {}, { tenantId: 'free-tenant' })
    }
    await expect(q.enqueue('task', {}, { tenantId: 'free-tenant' }))
      .rejects.toThrow('RATE_LIMIT_EXCEEDED')
  })

  it('includes retryAfter in error', async () => {
    // Fill rate limit
    try { /* exceed limit */ } catch (e) {
      expect(e.retryAfter).toBeGreaterThan(0)
    }
  })

  it('allows enqueue after window slides', async () => { /* ... */ })
})
```

- [ ] **Step 2: Run to verify failure**
- [ ] **Step 3: Implement** — `tiers.ts`: config storage with `resolveTier()` caching (LRU). Runtime `setTier()`, `override()`, `removeOverride()`. `fair-scheduler.ts`: deficit-weighted round robin — each dequeue cycle adds weight to tenant deficit, picks highest deficit tenant. `rate-limiter.ts`: sliding window using sub-windows (6 per period). Plugin registers `guard` on `enqueue` (rate limit check) and `transform` on `dequeue` (fair scheduling selection). Exposes `q.tenancy.*` API.
- [ ] **Step 4: Run tests to verify pass**
- [ ] **Step 5: Commit**

Run: `git commit -m "feat(plugin-tenancy): add multi-tenant fair scheduling and sliding window rate limiting"`

---

## Phase 7: Reliability Plugins

### Task 18: Circuit Breaker Plugin

**Files:**
- Create: `packages/plugin-circuit-breaker/` (full package, use Plugin Implementation Pattern)
- Create: `packages/plugin-circuit-breaker/src/breaker.ts`
- Test: `packages/plugin-circuit-breaker/tests/breaker.test.ts`

**Public API:**

```ts
export interface BreakerConfig {
  timeout: number
  failureThreshold: number
  failureWindow: number
  resetTimeout: number
  halfOpenRequests: number
  onOpen: 'requeue' | 'fail' | 'buffer' | ((ctx: JobContext) => Promise<void>)
}
export interface CircuitBreakerOpts {
  breakers: Record<string, BreakerConfig>
}
export function circuitBreaker(opts: CircuitBreakerOpts): PsyPlugin
```

- [ ] **Step 1: Write failing tests**

```ts
describe('Circuit Breaker', () => {
  it('stays CLOSED when failures are below threshold', async () => {
    const breaker = new Breaker({ failureThreshold: 3, failureWindow: 60000, resetTimeout: 5000, halfOpenRequests: 1 })
    breaker.recordFailure()
    breaker.recordFailure()
    expect(breaker.state).toBe('CLOSED')
  })

  it('opens after failure threshold exceeded', () => {
    const breaker = new Breaker({ failureThreshold: 3, failureWindow: 60000, resetTimeout: 5000, halfOpenRequests: 1 })
    breaker.recordFailure()
    breaker.recordFailure()
    breaker.recordFailure()
    expect(breaker.state).toBe('OPEN')
  })

  it('transitions to HALF_OPEN after resetTimeout', async () => {
    const breaker = new Breaker({ failureThreshold: 1, failureWindow: 60000, resetTimeout: 50, halfOpenRequests: 1 })
    breaker.recordFailure()
    expect(breaker.state).toBe('OPEN')
    await new Promise(r => setTimeout(r, 60))
    expect(breaker.state).toBe('HALF_OPEN')
  })

  it('closes after successful half-open requests', () => { /* ... */ })
  it('re-opens on failure during half-open', () => { /* ... */ })

  it('requeues job when circuit is open and onOpen is requeue', async () => {
    // Open the circuit, then try to process — job should be requeued
    await q.enqueue('payment', {})
    openStripeCircuit()
    await q.processNext('payment')
    const jobs = await backend.listJobs({ status: 'pending' })
    expect(jobs.data).toHaveLength(1) // requeued, not failed
  })

  it('isolates breakers per dependency', () => {
    // Stripe breaker open, Sendgrid breaker closed
    // Payment jobs requeue, email jobs process normally
  })
})
```

- [ ] **Step 2: Run to verify failure**
- [ ] **Step 3: Implement** — `breaker.ts`: `Breaker` class with state machine (CLOSED/OPEN/HALF_OPEN). Sliding window failure tracking using timestamped array. `checkState()` auto-transitions OPEN→HALF_OPEN after resetTimeout. Plugin registers `guard` on `process`: checks `ctx.state['_breakerName']` to find which breaker applies. Overrides `ctx.breaker()` on context to wrap calls with breaker check. Emits `circuit:open`, `circuit:close`, `circuit:half-open` events.
- [ ] **Step 4: Run tests to verify pass**
- [ ] **Step 5: Commit**

Run: `git commit -m "feat(plugin-circuit-breaker): add per-dependency circuit breakers with configurable actions"`

---

### Task 19: Backpressure Plugin

**Files:**
- Create: `packages/plugin-backpressure/` (full package, use Plugin Implementation Pattern)
- Create: `packages/plugin-backpressure/src/signals.ts`
- Create: `packages/plugin-backpressure/src/actions.ts`
- Test: `packages/plugin-backpressure/tests/backpressure.test.ts`

**Public API:**

```ts
export interface BackpressureOpts {
  signals: {
    queueDepth?: { pressure: number; critical: number }
    processingTime?: { pressure: string; critical: string }
    memoryUsage?: { pressure: number; critical: number }
    errorRate?: { pressure: number; critical: number }
    consumerLag?: { pressure: string; critical: string }
  }
  actions?: { pressure?: string[]; critical?: string[] }
  onPressure?: (ctx: BackpressureContext) => Promise<void>  // mutually exclusive with actions.pressure
  onCritical?: (ctx: BackpressureContext) => Promise<void>  // mutually exclusive with actions.critical
  onRecovery?: (ctx: BackpressureContext) => Promise<void>
  recovery?: { cooldown?: number; stepUp?: number }
}
export function backpressure(opts: BackpressureOpts): PsyPlugin
```

- [ ] **Step 1: Write failing tests**

```ts
describe('Backpressure', () => {
  it('transitions HEALTHY → PRESSURE when signal crosses threshold', () => {
    const monitor = new SignalMonitor({ queueDepth: { pressure: 100, critical: 1000 } })
    monitor.update({ queueDepth: 150 })
    expect(monitor.state).toBe('PRESSURE')
  })

  it('transitions PRESSURE → CRITICAL', () => {
    const monitor = new SignalMonitor({ queueDepth: { pressure: 100, critical: 1000 } })
    monitor.update({ queueDepth: 1500 })
    expect(monitor.state).toBe('CRITICAL')
  })

  it('executes configured actions on state change', async () => {
    const emitted: string[] = []
    q.events.on('backpressure:pressure', () => emitted.push('pressure'))
    // Trigger pressure state
    await simulateHighQueueDepth()
    expect(emitted).toContain('pressure')
  })

  it('throws if both actions and onPressure callback provided', () => {
    expect(() => backpressure({
      signals: { queueDepth: { pressure: 100, critical: 1000 } },
      actions: { pressure: ['emit-warning'] },
      onPressure: async () => {},
    })).toThrow('mutually exclusive')
  })

  it('recovers with cooldown and stepUp', async () => { /* ... */ })
})
```

- [ ] **Step 2: Run to verify failure**
- [ ] **Step 3: Implement** — `signals.ts`: `SignalMonitor` class polls metrics on interval, computes state (HEALTHY/PRESSURE/CRITICAL) based on configured thresholds. `actions.ts`: maps action names to functions (e.g., `'reduce-concurrency'` → halve worker count). Validates mutual exclusivity at construction. Plugin registers `guard` on `enqueue` to check state and apply actions. Emits `backpressure:*` events on transitions. Recovery timer restores capacity gradually.
- [ ] **Step 4: Run tests to verify pass**
- [ ] **Step 5: Commit**

Run: `git commit -m "feat(plugin-backpressure): add adaptive backpressure with configurable signals and actions"`

---

## Phase 8: Priority & Fusion Plugins

### Task 20: Deadline Priority Plugin

**Files:**
- Create: `packages/plugin-deadline-priority/` (full package, use Plugin Implementation Pattern)
- Create: `packages/plugin-deadline-priority/src/curves.ts`
- Test: `packages/plugin-deadline-priority/tests/deadline-priority.test.ts`

**Public API:**

```ts
export interface DeadlinePriorityOpts {
  urgencyCurve: 'linear' | 'exponential' | 'step' | ((timeRemainingPct: number, basePriority: number) => number)
  boostThreshold?: number   // default: 0.5
  maxBoost?: number         // default: 95
  interval?: number         // ms (default: 5000)
  onDeadlineMiss?: 'process-anyway' | 'fail' | 'move-to-dead-letter' | ((ctx: JobContext) => Promise<void>)
}
export function deadlinePriority(opts: DeadlinePriorityOpts): PsyPlugin
```

- [ ] **Step 1: Write failing tests**

```ts
describe('Deadline Priority', () => {
  it('does not boost priority when time remaining is above threshold', () => {
    const calc = exponentialCurve(0.5, 95)
    // 80% time remaining, base priority 30 → no boost
    expect(calc(0.8, 30)).toBe(30)
  })

  it('boosts priority exponentially as deadline approaches', () => {
    const calc = exponentialCurve(0.5, 95)
    const at50pct = calc(0.5, 30)   // threshold reached
    const at10pct = calc(0.1, 30)   // nearly expired
    expect(at10pct).toBeGreaterThan(at50pct)
    expect(at10pct).toBeLessThanOrEqual(95) // respects maxBoost
  })

  it('emits job:deadline-missed when deadline passes', async () => {
    const missed = vi.fn()
    q.events.on('job:deadline-missed', missed)
    const past = new Date(Date.now() - 1000)
    await q.enqueue('urgent', {}, { deadline: past })
    await priorityPlugin.evaluate() // exposed for testing
    expect(missed).toHaveBeenCalled()
  })

  it('supports custom urgency curve function', () => {
    const custom = (pct: number, base: number) => pct < 0.1 ? 95 : base
    expect(custom(0.05, 30)).toBe(95)
    expect(custom(0.5, 30)).toBe(30)
  })
})
```

- [ ] **Step 2: Run to verify failure**
- [ ] **Step 3: Implement** — `curves.ts`: exports `linearCurve`, `exponentialCurve`, `stepCurve` functions. Plugin runs `setInterval` at configured interval, queries backend for jobs with deadlines, recalculates priorities, updates via `backend.atomic()`. Emits `job:deadline-missed` and runs configurable action when `Date.now() > deadline`.
- [ ] **Step 4: Run tests to verify pass**
- [ ] **Step 5: Commit**

Run: `git commit -m "feat(plugin-deadline-priority): add dynamic priority with urgency curves"`

---

### Task 21: Job Fusion Plugin

**Files:**
- Create: `packages/plugin-job-fusion/` (full package, use Plugin Implementation Pattern)
- Create: `packages/plugin-job-fusion/src/batcher.ts`
- Test: `packages/plugin-job-fusion/tests/job-fusion.test.ts`

**Public API:**

```ts
export interface FusionRule {
  match: string                                    // job name pattern
  groupBy: (job: Job) => string                    // grouping key
  window: number                                   // ms to collect
  maxBatch: number                                 // max jobs per batch
  fuse: (jobs: Job[]) => unknown                   // merge payloads
}
export interface JobFusionOpts { rules: FusionRule[] }
export function jobFusion(opts: JobFusionOpts): PsyPlugin
```

- [ ] **Step 1: Write failing tests**

```ts
describe('Job Fusion', () => {
  it('batches jobs within window and calls fuse()', async () => {
    q.use(jobFusion({
      rules: [{
        match: 'notify',
        groupBy: (j) => (j.payload as any).userId,
        window: 100,
        maxBatch: 10,
        fuse: (jobs) => ({ userId: (jobs[0]!.payload as any).userId, count: jobs.length }),
      }],
    }))
    await q.start()
    await q.enqueue('notify', { userId: 'u1', msg: 'a' })
    await q.enqueue('notify', { userId: 'u1', msg: 'b' })
    await q.enqueue('notify', { userId: 'u1', msg: 'c' })
    await new Promise(r => setTimeout(r, 150)) // wait for window
    // Should have 1 fused job instead of 3
    const jobs = await backend.listJobs({ name: 'notify', status: 'pending' })
    expect(jobs.data).toHaveLength(1)
    expect(jobs.data[0].payload).toEqual({ userId: 'u1', count: 3 })
  })

  it('triggers early when maxBatch reached', async () => { /* ... */ })
  it('does not fuse jobs across different tenants', async () => { /* ... */ })
  it('passes through non-matching jobs unchanged', async () => { /* ... */ })
  it('fused job inherits highest priority and earliest deadline', async () => { /* ... */ })
})
```

- [ ] **Step 2: Run to verify failure**
- [ ] **Step 3: Implement** — `batcher.ts`: `BatchCollector` class with `Map<string, { jobs: Job[], timer: NodeJS.Timeout }>`. Plugin registers `transform` on `enqueue`: checks if job matches a rule, computes groupBy key, adds to batch. When timer fires or maxBatch reached: calls `fuse()`, creates fused job with highest priority/earliest deadline, stores original job IDs in `meta['fusion.originalJobIds']`. On fused job completion: marks all originals as completed.
- [ ] **Step 4: Run tests to verify pass**
- [ ] **Step 5: Commit**

Run: `git commit -m "feat(plugin-job-fusion): add auto-batching with configurable grouping and fusion"`

---

## Phase 9: Additional Backends

### Task 22: Redis Backend

**Files:**
- Create: `packages/backend-redis/` (full package, use Plugin Implementation Pattern but as backend)
- Create: `packages/backend-redis/src/adapter.ts`
- Create: `packages/backend-redis/src/lua/dequeue.lua`
- Create: `packages/backend-redis/src/lua/ack.lua`
- Test: `packages/backend-redis/tests/adapter.test.ts`

**Dependencies:** `ioredis`

**Key test assertions** (mirror Task 8's SQLite test suite):

```ts
describe('RedisBackendAdapter', () => {
  // Skip all tests if Redis not available
  beforeAll(async () => {
    try { await redis.ping() } catch { return test.skip('Redis not available') }
  })

  it('enqueues and retrieves a job')          // XADD + HSET, HGETALL
  it('dequeues atomically with completion token')  // XREADGROUP + Lua script
  it('acks with token verification')           // Lua atomic check
  it('respects priority ordering on dequeue')  // Sorted set scoring
  it('scheduleAt and pollScheduled')           // ZADD + ZRANGEBYSCORE
  it('acquireLock with SET NX EX')
  it('enqueueBulk in pipeline')               // Redis pipeline for atomicity
  // ... same contract as SQLite
})
```

- [ ] **Step 1: Scaffold package with ioredis dep**

Run: `cd packages/backend-redis && pnpm add ioredis`

- [ ] **Step 2: Write failing tests** (copy structure from Task 8, adapt for Redis)
- [ ] **Step 3: Implement** — `adapter.ts`: Redis Streams (`XADD`/`XREADGROUP` with consumer group) for queue ops. Job data stored as Hash (`HSET psyqueue:job:{id}`). Scheduling via Sorted Set (`ZADD psyqueue:{queue}:scheduled`). Lua scripts for atomic dequeue (read from stream + set completion token + update status in one atomic op) and ack (verify token + update status). Locking via `SET psyqueue:lock:{key} NX EX`.
- [ ] **Step 4: Run tests to verify pass**
- [ ] **Step 5: Commit**

Run: `git commit -m "feat(backend-redis): implement Redis backend with Streams and Lua scripts"`

---

### Task 23: Postgres Backend

**Files:**
- Create: `packages/backend-postgres/` (full package, use Plugin Implementation Pattern but as backend)
- Create: `packages/backend-postgres/src/adapter.ts`
- Create: `packages/backend-postgres/src/schema.sql`
- Test: `packages/backend-postgres/tests/adapter.test.ts`

**Dependencies:** `pg`

**Key test assertions** (mirror Task 8's SQLite test suite):

```ts
describe('PostgresBackendAdapter', () => {
  // Skip if Postgres not available
  beforeAll(async () => {
    try { await pool.query('SELECT 1') } catch { return test.skip('Postgres not available') }
  })

  it('enqueues and retrieves a job')           // INSERT + SELECT
  it('dequeues with FOR UPDATE SKIP LOCKED')   // Non-blocking atomic dequeue
  it('acks with completion token')             // UPDATE WHERE token matches
  it('respects priority ordering')             // ORDER BY priority DESC
  it('scheduleAt and pollScheduled')           // TIMESTAMPTZ + index scan
  it('acquireLock with pg_advisory_lock')
  it('enqueueBulk in transaction')             // BEGIN + multiple INSERTs + COMMIT
  // ... same contract as SQLite
})
```

- [ ] **Step 1: Scaffold package with pg dep**

Run: `cd packages/backend-postgres && pnpm add pg && pnpm add -D @types/pg`

- [ ] **Step 2: Write failing tests**
- [ ] **Step 3: Implement** — `schema.sql`: DDL with JSONB fields, TIMESTAMPTZ, indexes (same structure as SQLite but Postgres-native types). `adapter.ts`: `SELECT ... FOR UPDATE SKIP LOCKED LIMIT ?` for dequeue. `pg_advisory_lock(hashtext(key))` for distributed locking. All mutations in transactions. `enqueueBulk` uses `BEGIN`/`COMMIT` for atomicity.
- [ ] **Step 4: Run tests to verify pass**
- [ ] **Step 5: Commit**

Run: `git commit -m "feat(backend-postgres): implement PostgreSQL backend with SKIP LOCKED"`

---

## Phase 10: Observability

### Task 24: OpenTelemetry Tracing Plugin

**Files:**
- Create: `packages/plugin-otel-tracing/` (full package, use Plugin Implementation Pattern)
- Test: `packages/plugin-otel-tracing/tests/otel-tracing.test.ts`

**Dependencies:** `@opentelemetry/api`, `@opentelemetry/sdk-trace-node`, `@opentelemetry/exporter-trace-otlp-http`

**Public API:**

```ts
export interface OtelTracingOpts {
  serviceName: string
  exporter: 'otlp' | 'jaeger' | 'zipkin' | 'console'
  endpoint?: string
  traceEnqueue?: boolean
  traceProcess?: boolean
  traceWorkflowSteps?: boolean
  attributes?: (job: Job) => Record<string, string | number>
}
export function otelTracing(opts: OtelTracingOpts): PsyPlugin
```

- [ ] **Step 1: Write failing tests**

```ts
describe('OTel Tracing', () => {
  it('creates a span on enqueue with correct attributes', async () => {
    await q.enqueue('email.send', { to: 'a@b.com' })
    const spans = exporter.getFinishedSpans()
    const enqueueSpan = spans.find(s => s.name === 'psyqueue.enqueue')
    expect(enqueueSpan).toBeDefined()
    expect(enqueueSpan!.attributes['job.queue']).toBe('email.send')
  })

  it('creates a span on process', async () => { /* ... */ })
  it('propagates traceId from enqueue to process span', async () => {
    await q.enqueue('test', {})
    await q.processNext('test')
    const spans = exporter.getFinishedSpans()
    const enqSpan = spans.find(s => s.name === 'psyqueue.enqueue')
    const procSpan = spans.find(s => s.name === 'psyqueue.process')
    expect(procSpan!.parentSpanId).toBe(enqSpan!.spanContext().spanId)
  })

  it('sets traceId and spanId on job object', async () => { /* ... */ })
})
```

- [ ] **Step 2-5: Implement, test, commit**

Run: `git commit -m "feat(plugin-otel-tracing): add OpenTelemetry distributed tracing"`

---

### Task 25: Metrics Plugin

**Files:**
- Create: `packages/plugin-metrics/` (full package, use Plugin Implementation Pattern)
- Test: `packages/plugin-metrics/tests/metrics.test.ts`

**Dependencies:** `prom-client`

**Public API:**

```ts
export interface MetricsOpts {
  exporter: 'prometheus' | 'otlp' | 'statsd'
  port?: number
  histogramBuckets?: number[]
}
export function metrics(opts: MetricsOpts): PsyPlugin
```

- [ ] **Step 1: Write failing tests**

```ts
describe('Metrics', () => {
  it('increments psyqueue_jobs_enqueued_total on enqueue', async () => {
    await q.enqueue('test', {})
    const metric = await registry.getSingleMetricAsString('psyqueue_jobs_enqueued_total')
    expect(metric).toContain('queue="test"')
    expect(metric).toContain('1')
  })

  it('records processing duration histogram', async () => { /* ... */ })
  it('tracks queue depth gauge', async () => { /* ... */ })
  it('labels metrics with tenantId when present', async () => { /* ... */ })
  it('serves /metrics endpoint on configured port', async () => { /* ... */ })
})
```

- [ ] **Step 2-5: Implement, test, commit**

Run: `git commit -m "feat(plugin-metrics): add Prometheus metrics with auto-labeling"`

---

### Task 26: Audit Log Plugin

**Files:**
- Create: `packages/plugin-audit-log/` (full package, use Plugin Implementation Pattern)
- Create: `packages/plugin-audit-log/src/hash-chain.ts`
- Test: `packages/plugin-audit-log/tests/audit-log.test.ts`

**Public API:**

```ts
export interface AuditLogOpts {
  store: 'backend' | 'file' | BackendAdapter
  filePath?: string
  events?: 'all' | string[]
  includePayload?: boolean
  retention?: string
  hashChain?: boolean
}
export function auditLog(opts: AuditLogOpts): PsyPlugin
```

- [ ] **Step 1: Write failing tests**

```ts
describe('Audit Log', () => {
  it('records entry for each lifecycle event', async () => {
    await q.enqueue('test', {})
    await q.processNext('test')
    const entries = await q.audit.query({ jobName: 'test' })
    const types = entries.map(e => e.event)
    expect(types).toContain('job:enqueued')
    expect(types).toContain('job:started')
    expect(types).toContain('job:completed')
  })

  it('hash chain is valid for sequential entries', async () => {
    await q.enqueue('a', {})
    await q.enqueue('b', {})
    const entries = await q.audit.query({})
    const valid = verifyHashChain(entries)
    expect(valid).toBe(true)
  })

  it('detects tampered entry in hash chain', () => {
    const entries = [
      { hash: 'abc', prevHash: null, event: 'a' },
      { hash: 'def', prevHash: 'abc', event: 'b' },
    ]
    entries[0]!.event = 'tampered' // tamper
    expect(verifyHashChain(entries)).toBe(false)
  })

  it('excludes payload when includePayload is false', async () => { /* ... */ })
  it('prunes entries beyond retention window', async () => { /* ... */ })
})
```

- [ ] **Step 2-5: Implement, test, commit** — `hash-chain.ts`: `computeHash(entry, prevHash)` uses `crypto.createHash('sha256')`. Each entry includes `prevHash` and `hash`. `verifyHashChain(entries)` recomputes and compares. Plugin registers `finalize` on all events.

Run: `git commit -m "feat(plugin-audit-log): add hash-chained immutable audit log"`

---

## Phase 11: Transport — Polyglot Workers

### Task 27: gRPC Workers Plugin

**Files:**
- Create: `proto/psyqueue/v1/worker.proto` (from spec Section 13)
- Create: `packages/plugin-grpc-workers/` (full package, use Plugin Implementation Pattern)
- Create: `packages/plugin-grpc-workers/src/server.ts`
- Test: `packages/plugin-grpc-workers/tests/grpc-workers.test.ts`

**Dependencies:** `@grpc/grpc-js`, `@grpc/proto-loader`

**Public API:**

```ts
export interface GrpcWorkersOpts {
  port: number
  auth: 'token' | 'mtls' | 'none'
  tokens?: string[]
  queues: string[]   // which queues accept remote workers, '*' for all
}
export function grpcWorkers(opts: GrpcWorkersOpts): PsyPlugin
```

- [ ] **Step 1: Write proto file and failing tests**

```ts
describe('gRPC Workers', () => {
  it('client connects and registers', async () => {
    const client = createTestClient(port, 'test-token')
    const response = await client.register({ workerId: 'w1', queues: ['test'], concurrency: 1, language: 'node' })
    expect(response.success).toBe(true)
  })

  it('client fetches a job via FetchJobs stream', async () => {
    await q.enqueue('test', { data: 'hello' })
    const jobs = await client.fetchJobs({ queue: 'test', count: 1, workerId: 'w1' })
    expect(jobs).toHaveLength(1)
    expect(JSON.parse(jobs[0].payload)).toEqual({ data: 'hello' })
  })

  it('client acks a job with completion token', async () => { /* ... */ })
  it('rejects unauthenticated requests', async () => { /* ... */ })
  it('heartbeat extends job lock', async () => { /* ... */ })
})
```

- [ ] **Step 2-5: Implement, test, commit** — `server.ts`: gRPC server using `@grpc/grpc-js`. `FetchJobs`: dequeues from backend, streams one-shot up to `count`, closes. `Ack`/`Nack`: delegates to backend. `Heartbeat`: refreshes lock TTL. Auth middleware checks bearer token from metadata.

Run: `git commit -m "feat(plugin-grpc-workers): add gRPC transport for polyglot workers"`

---

### Task 28: HTTP Workers Plugin

**Files:**
- Create: `packages/plugin-http-workers/` (full package, use Plugin Implementation Pattern)
- Create: `packages/plugin-http-workers/src/server.ts`
- Test: `packages/plugin-http-workers/tests/http-workers.test.ts`

**Public API:**

```ts
export interface HttpWorkersOpts {
  port: number
  auth?: { type: 'bearer'; tokens: string[] }
  queues?: string[]
}
export function httpWorkers(opts: HttpWorkersOpts): PsyPlugin
```

- [ ] **Step 1: Write failing tests**

```ts
describe('HTTP Workers', () => {
  it('GET /jobs/fetch returns available jobs', async () => {
    await q.enqueue('test', { data: 1 })
    const res = await fetch(`http://localhost:${port}/jobs/fetch?queue=test&count=1`, {
      headers: { Authorization: 'Bearer test-token' }
    })
    expect(res.status).toBe(200)
    const jobs = await res.json()
    expect(jobs).toHaveLength(1)
  })

  it('POST /jobs/:id/ack marks job complete', async () => { /* ... */ })
  it('POST /jobs/:id/nack requeues job', async () => { /* ... */ })
  it('returns 401 without auth token', async () => {
    const res = await fetch(`http://localhost:${port}/jobs/fetch?queue=test&count=1`)
    expect(res.status).toBe(401)
  })
})
```

- [ ] **Step 2-5: Implement, test, commit** — `server.ts`: Node.js built-in `http.createServer`. JSON request/response. Routes: `/workers/register`, `/jobs/fetch`, `/jobs/:id/ack`, `/jobs/:id/nack`, `/jobs/:id/heartbeat`. Bearer auth middleware.

Run: `git commit -m "feat(plugin-http-workers): add HTTP REST transport for polyglot workers"`

---

## Phase 12: Testing & Sync Plugins

### Task 29: Chaos Testing Plugin

**Files:**
- Create: `packages/plugin-chaos/` (full package, use Plugin Implementation Pattern)
- Create: `packages/plugin-chaos/src/scenarios.ts`
- Test: `packages/plugin-chaos/tests/chaos.test.ts`

**Public API:**

```ts
export interface ChaosOpts {
  enabled: boolean
  scenarios: {
    slowProcess?: { probability: number; delay: [number, number] }
    workerCrash?: { probability: number; timing: 'mid-process' }
    duplicateDelivery?: { probability: number }
    networkPartition?: { probability: number; duration: [number, number] }
    backendOutage?: { probability: number; duration: [number, number] }
    clockSkew?: { probability: number; drift: [number, number] }
  }
}
export function chaosMode(opts: ChaosOpts): PsyPlugin
export function chaosRun(q: PsyQueue, config: { scenario: string; jobs: number; duration: string }): Promise<ChaosReport>
```

- [ ] **Step 1: Write failing tests**

```ts
describe('Chaos Mode', () => {
  it('injects delay into processing when slowProcess fires', async () => {
    q.use(chaosMode({ enabled: true, scenarios: { slowProcess: { probability: 1.0, delay: [100, 100] } } }))
    await q.start()
    await q.enqueue('test', {})
    const start = Date.now()
    await q.processNext('test')
    expect(Date.now() - start).toBeGreaterThanOrEqual(90)
  })

  it('does nothing when enabled is false', async () => { /* ... */ })

  it('chaosRun returns correct report', async () => {
    const report = await chaosRun(q, { scenario: 'duplicate-delivery-storm', jobs: 10, duration: '5s' })
    expect(report.jobsEnqueued).toBe(10)
    expect(report.jobsLost).toBe(0) // no data loss
    expect(report).toHaveProperty('avgRecoveryTime')
  })
})
```

- [ ] **Step 2-5: Implement, test, commit** — `scenarios.ts`: each scenario is a middleware factory. `slowProcess`: adds `setTimeout` in process pipeline. `workerCrash`: throws mid-process to simulate crash. `duplicateDelivery`: calls next() twice. Plugin registers `guard` on `process`, rolls dice per `probability`, applies scenario if hit.

Run: `git commit -m "feat(plugin-chaos): add chaos testing with configurable failure scenarios"`

---

### Task 30: Offline Sync Plugin

**Files:**
- Create: `packages/plugin-offline-sync/` (full package, use Plugin Implementation Pattern)
- Create: `packages/plugin-offline-sync/src/sync-engine.ts`
- Test: `packages/plugin-offline-sync/tests/offline-sync.test.ts`

**Dependencies:** `better-sqlite3` (for local buffer)

**Public API:**

```ts
export interface OfflineSyncOpts {
  localPath: string                      // independent SQLite, NOT the registered backend
  remote: string                         // grpc:// or http:// URL
  sync: { mode: 'opportunistic' | 'scheduled' | 'manual'; interval?: number }
  onConflict?: 'remote-wins' | 'local-wins' | 'merge'
  maxLocalJobs?: number
  onBufferFull?: 'drop-lowest-priority' | 'reject' | 'rotate'
}
export function offlineSync(opts: OfflineSyncOpts): PsyPlugin
```

- [ ] **Step 1: Write failing tests**

```ts
describe('Offline Sync', () => {
  it('buffers jobs locally when remote is unreachable', async () => {
    // Disconnect remote
    mockRemote.disconnect()
    await q.enqueue('test', { data: 1 })
    // Job should be in local SQLite, not remote
    const localJobs = localDb.prepare('SELECT * FROM jobs').all()
    expect(localJobs).toHaveLength(1)
  })

  it('syncs buffered jobs when connection restored', async () => {
    mockRemote.disconnect()
    await q.enqueue('test', { data: 1 })
    mockRemote.reconnect()
    await q.sync.push()
    expect(mockRemote.receivedJobs).toHaveLength(1)
    // Local buffer should be cleared
    const localJobs = localDb.prepare('SELECT * FROM jobs').all()
    expect(localJobs).toHaveLength(0)
  })

  it('deduplicates on retried sync via idempotency keys', async () => { /* ... */ })
  it('respects maxLocalJobs buffer limit', async () => { /* ... */ })
  it('manual sync mode does not auto-sync', async () => { /* ... */ })
})
```

- [ ] **Step 2-5: Implement, test, commit** — `sync-engine.ts`: manages own `better-sqlite3` instance at `localPath`. Intercepts `enqueue` in `guard` phase: if remote health check fails → write to local SQLite instead. Sync engine batches local jobs, sends to remote via gRPC/HTTP, clears on ack. Auto-assigns idempotency keys to buffered jobs.

Run: `git commit -m "feat(plugin-offline-sync): add offline-first queue with sync"`

---

## Phase 13: Dashboard

### Task 31: Dashboard API Server

**Files:**
- Create: `packages/dashboard/package.json`
- Create: `packages/dashboard/src/server.ts`
- Create: `packages/dashboard/src/plugin.ts`
- Create: `packages/dashboard/src/api/routes.ts`
- Test: `packages/dashboard/tests/api.test.ts`

**Dependencies:** `express`, `@types/express`

**Public API:**

```ts
export interface DashboardOpts {
  port: number
  basePath?: string
  auth: { type: 'basic'; user: string; pass: string }
    | { type: 'bearer'; tokens: string[] }
    | { type: 'custom'; middleware: (req: any, res: any, next: any) => void }
}
export function dashboard(opts: DashboardOpts): PsyPlugin
```

- [ ] **Step 1: Write failing tests**

```ts
describe('Dashboard API', () => {
  it('GET /api/overview returns queue stats', async () => {
    await q.enqueue('test', {})
    const res = await fetch(`http://localhost:${port}/api/overview`)
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data).toHaveProperty('queues')
    expect(data).toHaveProperty('totalPending')
  })

  it('GET /api/jobs returns filtered job list', async () => {
    const res = await fetch(`http://localhost:${port}/api/jobs?queue=test&status=pending`)
    const data = await res.json()
    expect(data).toHaveProperty('data')
    expect(data).toHaveProperty('total')
  })

  it('POST /api/jobs/:id/retry requeues a failed job', async () => { /* ... */ })
  it('returns 401 without auth', async () => { /* ... */ })
  it('GET /api/workflows/:id returns DAG data', async () => { /* ... */ })
})
```

- [ ] **Step 2-5: Implement, test, commit** — `routes.ts`: Express router with all API endpoints. Queries backend and plugin state. `plugin.ts`: wraps as PsyPlugin, starts Express server on `start()`. Auth middleware based on opts.

Run: `git commit -m "feat(dashboard): add dashboard API server with auth"`

---

### Task 32: Dashboard React UI

**Files:**
- Create: `packages/dashboard/vite.config.ts`
- Create: `packages/dashboard/src/ui/index.html`
- Create: `packages/dashboard/src/ui/main.tsx`
- Create: `packages/dashboard/src/ui/App.tsx`
- Create: `packages/dashboard/src/ui/pages/` (Overview, Queues, Jobs, Workflows, Tenants, Circuits, Audit, Actions)

**Dependencies:** `react`, `react-dom`, `@tanstack/react-query`, `recharts`, `react-router-dom`, `dagre` (for workflow DAG layout)

**Testing approach:** Vitest + `@testing-library/react` + MSW (Mock Service Worker) for API mocking.

- [ ] **Step 1: Scaffold Vite + React project**

```ts
// packages/dashboard/vite.config.ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  root: 'src/ui',
  build: { outDir: '../../dist/ui' },
})
```

- [ ] **Step 2: Create pages**

Each page is a React component that fetches from `/api/*` using `@tanstack/react-query`:
- **Overview**: Queue depth bar chart, throughput sparkline (recharts), error rate, backpressure gauge
- **Jobs**: Table with search/filter, click to inspect payload/error, retry button
- **Workflows**: Dagre-laid-out DAG with step status (green=done, yellow=active, red=failed, gray=pending)
- **Tenants**: Per-tenant metrics table, rate limit usage bars
- **Circuits**: State indicator per breaker (green/yellow/red), failure count, manual open/close
- **Audit**: Searchable log table with hash chain integrity indicator
- **Actions**: Bulk retry, replay from dead letter, pause/resume queue buttons

- [ ] **Step 3: Write component tests**

```ts
describe('Overview Page', () => {
  it('renders queue depth chart with data from API', async () => {
    server.use(rest.get('/api/overview', (req, res, ctx) => res(ctx.json({ queues: [{ name: 'test', pending: 5 }], totalPending: 5 }))))
    render(<Overview />)
    await waitFor(() => expect(screen.getByText('test')).toBeInTheDocument())
  })
})
```

- [ ] **Step 4: Build and embed** — Vite builds to `dist/ui/`, Express server in Task 31 serves this as static files.
- [ ] **Step 5: Commit**

Run: `git commit -m "feat(dashboard): add React UI with all pages"`

---

## Phase 14: CLI & Polish

### Task 33: CLI Tools

**Files:**
- Create: `packages/cli/` (full package)
- Test: `packages/cli/tests/cli.test.ts`

Implementation:
- Uses `commander` for CLI parsing. Commands:
  - `psyqueue migrate --from <uri> --to <uri>`: Read all jobs from source backend, write to target backend in batches
  - `psyqueue audit verify --from <date> --to <date>`: Read audit log entries, verify hash chain integrity
  - `psyqueue replay --queue <name> --error-code <code>`: Replay dead-lettered jobs matching filter
- Tests: CLI argument parsing, migrate with mock backends, audit verify with valid/tampered chains

- [ ] **Step 1-5: Same TDD flow**

Run: `git commit -m "feat(cli): add migrate, audit verify, and replay commands"`

---

### Task 34: Presets

**Files:**
- Modify: `packages/core/src/kernel.ts` (add `PsyQueue.from()` static method)
- Modify: `packages/core/src/presets.ts`
- Modify: `packages/core/src/index.ts` (export presets)
- Test: `packages/core/tests/presets.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
describe('Presets', () => {
  it('PsyQueue.from(presets.lite) creates working queue with SQLite', async () => {
    const q = PsyQueue.from(presets.lite)
    q.handle('test', async () => ({ ok: true }))
    await q.start()
    await q.enqueue('test', {})
    await q.processNext('test')
    await q.stop()
  })

  it('PsyQueue.from(preset, { override }) swaps backend', async () => {
    const q = PsyQueue.from(presets.saas, {
      override: { backend: sqlite({ path: ':memory:' }) },
    })
    await q.start()
    // Should work with SQLite instead of Redis
    await q.enqueue('test', {})
    await q.stop()
  })

  it('PsyQueue.from(preset, { add, remove }) modifies plugin list', () => {
    const q = PsyQueue.from(presets.saas, {
      add: [chaosMode({ enabled: true, scenarios: {} })],
      remove: ['dashboard'],
    })
    // Verify chaos is added, dashboard is removed
  })
})
```

- [ ] **Step 2: Run to verify failure**
- [ ] **Step 3: Implement** — Add `static from(preset, overrides?)` to `PsyQueue` class in `kernel.ts`. `presets.ts`: each preset returns a list of plugin factories. `from()` creates PsyQueue, applies preset plugins, processes overrides (swap backend, add/remove plugins by name).
- [ ] **Step 4: Run tests to verify pass**
- [ ] **Step 5: Commit**

Run: `git commit -m "feat(core): add lite, saas, and enterprise presets with PsyQueue.from()"`

---

### Task 35: Docker Compose & CI

**Files:**
- Create: `docker-compose.yml`
- Create: `.github/workflows/ci.yml`
- Create: `.env.example`

- [ ] **Step 1: Create Docker Compose**

```yaml
# docker-compose.yml
services:
  redis:
    image: redis:7-alpine
    ports: ["6379:6379"]

  postgres:
    image: postgres:16-alpine
    ports: ["5432:5432"]
    environment:
      POSTGRES_DB: psyqueue_test
      POSTGRES_USER: psyqueue
      POSTGRES_PASSWORD: psyqueue
    volumes:
      - postgres_data:/var/lib/postgresql/data

  jaeger:
    image: jaegertracing/all-in-one:latest
    ports:
      - "16686:16686"   # UI
      - "4318:4318"     # OTLP HTTP

volumes:
  postgres_data:
```

- [ ] **Step 2: Create GitHub Actions CI**

```yaml
# .github/workflows/ci.yml
name: CI
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    services:
      redis:
        image: redis:7-alpine
        ports: [6379:6379]
      postgres:
        image: postgres:16-alpine
        ports: [5432:5432]
        env:
          POSTGRES_DB: psyqueue_test
          POSTGRES_USER: psyqueue
          POSTGRES_PASSWORD: psyqueue
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm build
      - run: pnpm test
```

- [ ] **Step 3: Create .env.example**

```env
# .env.example
REDIS_URL=redis://localhost:6379
DATABASE_URL=postgres://psyqueue:psyqueue@localhost:5432/psyqueue_test
JAEGER_ENDPOINT=http://localhost:4318
DASHBOARD_PORT=4000
DASHBOARD_USER=admin
DASHBOARD_PASS=changeme
```

- [ ] **Step 4: Commit**

Run: `git add docker-compose.yml .github/ .env.example && git commit -m "feat: add Docker Compose, GitHub Actions CI, and env template"`

---

### Task 36: Examples

**Files:**
- Create: `examples/basic/index.ts`
- Create: `examples/saas-multi-tenant/index.ts`
- Create: `examples/workflow-saga/index.ts`

- [ ] **Step 1: Create basic example**

```ts
// examples/basic/index.ts
import { PsyQueue } from 'psyqueue'
import { sqlite } from '@psyqueue/backend-sqlite'

const q = new PsyQueue()
q.use(sqlite({ path: './jobs.db' }))

q.handle('greet', async (ctx) => {
  console.log(`Hello, ${(ctx.job.payload as any).name}!`)
  return { greeted: true }
})

await q.start()
await q.enqueue('greet', { name: 'World' })
console.log('Job enqueued! Processing...')
await q.processNext('greet')
await q.stop()
```

- [ ] **Step 2: Create SaaS multi-tenant example**

```ts
// examples/saas-multi-tenant/index.ts
import { PsyQueue } from 'psyqueue'
import { sqlite } from '@psyqueue/backend-sqlite'
import { tenancy } from '@psyqueue/plugin-tenancy'
import { scheduler } from '@psyqueue/plugin-scheduler'

const q = new PsyQueue()
q.use(sqlite({ path: ':memory:' }))
q.use(scheduler())
q.use(tenancy({
  tiers: {
    free:       { rateLimit: { max: 10, window: '1m' }, concurrency: 2,  weight: 1 },
    pro:        { rateLimit: { max: 100, window: '1m' }, concurrency: 10, weight: 3 },
    enterprise: { rateLimit: { max: 1000, window: '1m' }, concurrency: 50, weight: 10 },
  },
  resolveTier: async (tenantId) => {
    const tiers: Record<string, string> = { 't1': 'free', 't2': 'pro', 't3': 'enterprise' }
    return tiers[tenantId] ?? 'free'
  },
  scheduling: 'weighted-fair-queue',
}))

q.handle('report', async (ctx) => {
  console.log(`Generating report for tenant ${ctx.job.tenantId}`)
  return { generated: true }
})

await q.start()

// Enqueue jobs for different tenants
for (let i = 0; i < 10; i++) {
  await q.enqueue('report', { type: 'daily' }, { tenantId: 't1' })
  await q.enqueue('report', { type: 'daily' }, { tenantId: 't2' })
  await q.enqueue('report', { type: 'daily' }, { tenantId: 't3' })
}

console.log('30 jobs enqueued across 3 tenants. Fair scheduling active.')
await q.stop()
```

- [ ] **Step 3: Create workflow saga example** (booking with compensation)

```ts
// examples/workflow-saga/index.ts
import { PsyQueue } from 'psyqueue'
import { sqlite } from '@psyqueue/backend-sqlite'
import { workflows } from '@psyqueue/plugin-workflows'
import { saga } from '@psyqueue/plugin-saga'

const q = new PsyQueue()
q.use(sqlite({ path: ':memory:' }))
q.use(workflows())
q.use(saga())

const bookFlight = async (ctx: any) => {
  console.log('Booking flight...')
  return { bookingId: 'FL-123' }
}
const cancelFlight = async (ctx: any) => {
  console.log(`Cancelling flight ${ctx.results.reserve_flight.bookingId}`)
}
const bookHotel = async (ctx: any) => {
  console.log('Booking hotel...')
  return { reservationId: 'HT-456' }
}
const cancelHotel = async (ctx: any) => {
  console.log(`Cancelling hotel ${ctx.results.reserve_hotel.reservationId}`)
}
const processPayment = async () => {
  console.log('Processing payment...')
  throw new Error('Payment declined!')
}

const { workflow } = await import('@psyqueue/plugin-workflows')

const booking = workflow('booking.create')
  .step('reserve_flight', bookFlight, { compensate: cancelFlight })
  .step('reserve_hotel', bookHotel, { after: 'reserve_flight', compensate: cancelHotel })
  .step('charge_card', processPayment, { after: 'reserve_hotel' })
  .build()

await q.start()
await q.enqueue(booking, { customerId: 'cust_789' })
console.log('Booking workflow started. Payment will fail, triggering compensation.')
await q.stop()
```

- [ ] **Step 4: Create offline-sync and polyglot examples**

```ts
// examples/offline-sync/index.ts
import { PsyQueue } from 'psyqueue'
import { sqlite } from '@psyqueue/backend-sqlite'
import { offlineSync } from '@psyqueue/plugin-offline-sync'

const q = new PsyQueue()
q.use(sqlite({ path: ':memory:' }))
q.use(offlineSync({
  localPath: './offline-buffer.db',
  remote: 'grpc://queue.example.com:50051',
  sync: { mode: 'manual' },
  maxLocalJobs: 1000,
}))
q.handle('sensor.reading', async (ctx) => {
  console.log('Processing sensor data:', ctx.job.payload)
})
await q.start()
// Enqueue while "offline" — buffered locally
await q.enqueue('sensor.reading', { temp: 22.5, humidity: 65 })
console.log('Job buffered locally. Call q.sync.push() when connected.')
await q.stop()
```

```ts
// examples/polyglot/server.ts
import { PsyQueue } from 'psyqueue'
import { sqlite } from '@psyqueue/backend-sqlite'
import { grpcWorkers } from '@psyqueue/plugin-grpc-workers'

const q = new PsyQueue()
q.use(sqlite({ path: ':memory:' }))
q.use(grpcWorkers({ port: 50051, auth: 'token', tokens: ['secret'], queues: ['*'] }))
await q.start()
await q.enqueue('ml.predict', { input: [1, 2, 3] })
console.log('Queue running. Connect a Python/Go worker to localhost:50051')
```

```python
# examples/polyglot/worker.py
# Requires: pip install grpcio grpcio-tools
# Generate stubs: python -m grpc_tools.protoc -I../../proto --python_out=. --grpc_python_out=. ../../proto/psyqueue/v1/worker.proto
print("Python worker example — see proto/ for gRPC service definition")
```

- [ ] **Step 5: Commit**

Run: `git add examples/ && git commit -m "feat: add basic, saas, workflow, offline-sync, and polyglot examples"`

---

## Checkpoint Summary

After completing all 36 tasks, PsyQueue will have:

| Component | Status |
|-----------|--------|
| Core kernel (event bus, plugin registry, middleware pipeline) | Complete |
| SQLite backend | Complete |
| Redis backend | Complete |
| Postgres backend | Complete |
| Job processing with retry + dead letter | Complete |
| Scheduler (delayed + cron) | Complete |
| Crash recovery (WAL) | Complete |
| Exactly-once (idempotency + completion tokens) | Complete |
| Schema versioning (Zod + migration chains) | Complete |
| Workflow DAGs + conditional branching | Complete |
| Saga compensation | Complete |
| Multi-tenancy + fair scheduling + rate limiting | Complete |
| Circuit breakers (per-dependency) | Complete |
| Adaptive backpressure | Complete |
| Deadline-aware dynamic priority | Complete |
| Job fusion / auto-batching | Complete |
| OpenTelemetry tracing | Complete |
| Prometheus metrics | Complete |
| Hash-chained audit log | Complete |
| gRPC workers | Complete |
| HTTP workers | Complete |
| Chaos testing | Complete |
| Offline sync | Complete |
| React dashboard | Complete |
| CLI tools | Complete |
| Presets (lite, saas, enterprise) | Complete |
| Docker Compose + CI + examples | Complete |
