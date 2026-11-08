# Upgrading

## From 0.1.x

This release fixes correctness problems found in an audit (lost jobs, duplicate
runs, guarantees that only held inside one process). Some fixes change APIs or
defaults.

### Removed: `@psyqueue/plugin-crash-recovery`

Crash recovery is now built into the core worker on every backend, with leases:

```diff
- import { crashRecovery } from '@psyqueue/plugin-crash-recovery'
- q.use(crashRecovery({ walPath: './psyqueue.wal' }))
+ q.startWorker('emails', { leaseMs: 60_000 }) // jobs of a dead worker are reclaimed after leaseMs
```

The plugin marked jobs completed before their handler ran, so it could not
recover crashed jobs. Delete the `.wal` file it left behind.

### Process middleware now wraps the handler

`q.pipeline('process', fn)` middleware now runs *around* the handler: code
after `await next()` runs after the handler finished, and a handler error
propagates through `next()`. Before, the whole pipeline ran before the handler.
Middleware that returns without calling `next()` now skips the handler.

The `complete`, `fail` and `retry` pipelines now run. In `fail`,
`ctx.state.error` holds the error and `ctx.state.willRetry` says whether the
job will be retried.

### Workflows

- `engine.store.get()`, `engine.store.list()`, `engine.cancel()` and
  `engine.getStepResults()` are now **async**, and so are `get`, `list` and
  `cancel` on `q.getExposed('workflows')`. State is stored in the backend.
- Steps now **retry**: default 3 attempts total (`maxRetries`, `backoff`,
  `backoffBase` per step). Before, a step failed on its first error. Pass
  `{ maxRetries: 1 }` for the old behavior.
- `workflow:failed` fires once no step of the workflow is still running.
- Step status `'cancelled'` is new (queued steps of a cancelled or failed workflow).
- The saga plugin's `Compensator` export is removed; compensation runs as
  jobs inside the workflows engine. A failing compensation no longer stops the
  remaining ones; check `instance.compensation.failed`.

### Tenancy

- Fair scheduling and tier `concurrency` only apply to the queues you list:
  `tenancy({ ..., queues: ['emails'] })`. Every process using those queues
  must load the plugin with the same list.
- `setTier`, `override` and `removeOverride` are now **async**.
- `SlidingWindowRateLimiter` is removed; rate limits are enforced by the
  backend and shared by all processes.
- `scheduling` is optional (default `'weighted-fair-queue'`). New options:
  `defaultTier`, `tierCacheTtl` (default 60 s; tiers were cached forever).

### Idempotency keys (`exactly-once`)

- `idempotencyKey` is now enforced by the backend, **even without the
  plugin**, across processes and restarts. Keys are scoped to queue + job name
  (before: global). A key is freed when its job fails or dies, or after the
  window (default 24 h, per job via `idempotencyTtl`).
- The `DedupStore` export and the `cleanupInterval` option are gone (the option
  is accepted and ignored).

### Behavior changes in core

- `processNext()` promotes due scheduled jobs itself, so a job whose `runAt`
  has passed runs without waiting for the scheduler's poll.
- On Redis, jobs with a future `runAt` are scheduled even without the
  scheduler plugin (before, they ran immediately).
- On Redis, jobs come out oldest first (FIFO). They came out newest first.
- `job:enqueued` only fires for jobs that were stored (not for duplicates or
  jobs a plugin swallowed). A job with no handler now emits `job:dead`.

### Database schema

SQLite and Postgres migrate themselves on `connect()`: a `heartbeat_at` column
on the jobs table, plus new tables for idempotency keys, tenant policies and
rate-limit events.
