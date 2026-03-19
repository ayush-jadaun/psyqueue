# Getting Started with PsyQueue

This guide walks you through installing PsyQueue, creating your first job, adding retries, scheduling delayed work, and upgrading backends.

## Installation

PsyQueue requires Node.js 20+ and uses ESM modules.

```bash
# Core package + SQLite backend (zero-infra)
npm install psyqueue @psyqueue/backend-sqlite
```

If you use pnpm or yarn:

```bash
pnpm add psyqueue @psyqueue/backend-sqlite
# or
yarn add psyqueue @psyqueue/backend-sqlite
```

## Your First Job

Create a file `worker.ts`:

```typescript
import { PsyQueue } from 'psyqueue'
import { sqlite } from '@psyqueue/backend-sqlite'

// 1. Create the queue with a SQLite backend
const q = new PsyQueue()
q.use(sqlite({ path: './jobs.db' }))

// 2. Register a job handler
q.handle('email.send', async (ctx) => {
  const { to, subject } = ctx.job.payload as { to: string; subject: string }
  ctx.log.info(`Sending email to ${to}: ${subject}`)

  // Your email sending logic here
  await sendEmail(to, subject)

  return { sent: true, to }
})

// 3. Start the queue
await q.start()

// 4. Enqueue a job
const jobId = await q.enqueue('email.send', {
  to: 'alice@example.com',
  subject: 'Welcome to our platform',
})

console.log(`Enqueued job: ${jobId}`)

// 5. Process it
const processed = await q.processNext('email.send')
console.log(`Job processed: ${processed}`) // true

// 6. Graceful shutdown
await q.stop()
```

Key points:
- The `queue` (second argument) defaults to the job name if not specified.
- `processNext` dequeues one job, runs the handler, and acks/nacks automatically.
- The `ctx.log` logger prefixes messages with the job ID.

## Adding Retry Logic

PsyQueue retries failed jobs automatically. The default is 3 retries with exponential backoff.

```typescript
// Override retry settings per job
const jobId = await q.enqueue('payment.charge', {
  customerId: 'cus_123',
  amount: 4999,
}, {
  maxRetries: 5,                // retry up to 5 times
  backoff: 'exponential',       // exponential, linear, or fixed
  backoffBase: 2000,            // start at 2 seconds
  backoffCap: 60_000,           // max delay: 60 seconds
  backoffJitter: true,          // +/- 25% jitter (default: true)
  timeout: 10_000,              // fail if handler takes > 10s
})
```

### Error Classification

PsyQueue automatically classifies errors to decide retry behavior:

| Category | Retryable | Detection |
|----------|-----------|-----------|
| `transient` | Yes | `timeout`, `ECONNREFUSED`, `ECONNRESET` in message |
| `rate-limit` | Yes | `rate limit` in message |
| `validation` | No | `validation`, `invalid` in message |
| `fatal` | No | Error has `category: 'fatal'` |
| `unknown` | Yes | Default for unrecognized errors |

You can set the category explicitly on errors:

```typescript
const err = new Error('Bad input')
;(err as any).category = 'validation' // won't retry
throw err
```

### Dead Letter Queue

When retries are exhausted (or a non-retryable error occurs), jobs move to the dead letter queue.

```typescript
// List dead-lettered jobs
const dead = await q.deadLetter.list({ queue: 'payment.charge' })

// Replay a specific job
await q.deadLetter.replay(jobId)

// Replay all dead-lettered jobs
const count = await q.deadLetter.replayAll({ queue: 'payment.charge' })

// Purge old dead letters
await q.deadLetter.purge({ before: new Date('2025-01-01') })
```

## Scheduling Delayed Jobs

Install the scheduler plugin:

```bash
npm install @psyqueue/plugin-scheduler
```

```typescript
import { scheduler } from '@psyqueue/plugin-scheduler'

const q = new PsyQueue()
q.use(sqlite({ path: './jobs.db' }))
q.use(scheduler({ pollInterval: 1000 }))

await q.start()

// Schedule a job to run 30 minutes from now
await q.enqueue('report.generate', { type: 'daily' }, {
  runAt: new Date(Date.now() + 30 * 60 * 1000),
})

// Schedule a recurring cron job
await q.enqueue('cleanup.expired', {}, {
  cron: '0 2 * * *', // every day at 2:00 AM
})
```

The scheduler plugin polls for due jobs and moves them from `scheduled` to `pending`. Cron jobs are automatically re-scheduled after each completion.

## Adding Priority

Jobs have a default priority of `0`. Higher values are dequeued first.

```typescript
// High-priority job
await q.enqueue('notification.push', { userId: '123' }, {
  priority: 10,
})

// Low-priority background job
await q.enqueue('analytics.sync', { batch: 42 }, {
  priority: -5,
})
```

For deadline-aware priority boosting, see the [deadline-priority plugin](plugins/scheduling.md#deadline-priority).

## Bulk Enqueue

For inserting many jobs at once, use `enqueueBulk` which uses the backend's atomic batch insert:

```typescript
const ids = await q.enqueueBulk([
  { name: 'email.send', payload: { to: 'alice@example.com' } },
  { name: 'email.send', payload: { to: 'bob@example.com' } },
  { name: 'email.send', payload: { to: 'carol@example.com' } },
])
```

## Monitoring with the Dashboard

Install the dashboard plugin:

```bash
npm install @psyqueue/dashboard
```

```typescript
import { dashboard } from '@psyqueue/dashboard'

q.use(dashboard({ port: 3001 }))

await q.start()
// Dashboard available at http://localhost:3001
```

Optionally add authentication:

```typescript
q.use(dashboard({
  port: 3001,
  auth: { type: 'bearer', credentials: 'my-secret-token' },
}))
```

## Listening to Events

PsyQueue emits events for every lifecycle transition:

```typescript
q.events.on('job:completed', (event) => {
  const { jobId, name, result } = event.data as any
  console.log(`Job ${jobId} (${name}) completed:`, result)
})

q.events.on('job:failed', (event) => {
  const { jobId, error } = event.data as any
  console.error(`Job ${jobId} failed:`, error)
})

// Wildcard: listen to all job events
q.events.on('job:*', (event) => {
  console.log(`[${event.type}]`, event.data)
})
```

## Custom Middleware

Add your own middleware to any lifecycle event:

```typescript
// Log every job before processing
q.pipeline('process', async (ctx, next) => {
  console.log(`Processing: ${ctx.job.name} [${ctx.job.id}]`)
  const start = Date.now()
  await next()
  console.log(`Done in ${Date.now() - start}ms`)
}, { phase: 'observe' })

// Validate payloads before enqueue
q.pipeline('enqueue', async (ctx, next) => {
  if (!ctx.job.payload) {
    ctx.deadLetter('Empty payload')
    return
  }
  await next()
}, { phase: 'validate' })
```

## Upgrading to Redis

When you outgrow SQLite, switch to Redis without changing any application code:

```bash
npm install @psyqueue/backend-redis
```

```typescript
import { redis } from '@psyqueue/backend-redis'

const q = new PsyQueue()
q.use(redis({
  host: 'localhost',
  port: 6379,
  password: 'secret',
  db: 0,
}))

// Everything else stays the same
q.handle('email.send', async (ctx) => { /* ... */ })
await q.start()
```

Or use Postgres for ACID compliance:

```bash
npm install @psyqueue/backend-postgres
```

```typescript
import { postgres } from '@psyqueue/backend-postgres'

q.use(postgres({
  connectionString: 'postgresql://user:pass@localhost:5432/psyqueue',
}))
```

## Next Steps

- Read the [Architecture Guide](architecture.md) to understand the kernel, middleware pipeline, and plugin system.
- Browse [Plugin Guides](plugins/) for detailed configuration of every plugin.
- Check the [API Reference](api-reference.md) for the full PsyQueue API.
- See the [Comparison Guide](comparison.md) for how PsyQueue stacks up against BullMQ, Celery, and Temporal.
