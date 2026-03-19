# @psyqueue/backend-redis

> Redis backend for PsyQueue. High-throughput production storage using ioredis.

## Installation

```bash
npm install psyqueue @psyqueue/backend-redis
```

## Usage

```typescript
import { PsyQueue } from 'psyqueue'
import { redis } from '@psyqueue/backend-redis'

const q = new PsyQueue()
q.use(redis({ host: 'localhost', port: 6379 }))

q.handle('email.send', async (ctx) => {
  const { to, subject } = ctx.job.payload as any
  await sendEmail(to, subject)
  return { sent: true }
})

await q.start()

// Start a worker pool with concurrency:10
q.startWorker('email.send', { concurrency: 10 })

await q.enqueue('email.send', { to: 'alice@example.com', subject: 'Hello' })
```

## Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `host` | `string` | `'localhost'` | Redis host |
| `port` | `number` | `6379` | Redis port |
| `password` | `string` | - | Redis password |
| `db` | `number` | `0` | Redis database number |
| `url` | `string` | - | Full Redis connection URL |
| `keyPrefix` | `string` | `'psyqueue:'` | Prefix for all Redis keys |

## Architecture

The Redis backend uses a hybrid data model designed for throughput:

### Hybrid List + Sorted Set

- **Default-priority jobs** (priority = 0) use a Redis LIST (RPUSH to enqueue, RPOP to dequeue) -- O(1) on both sides.
- **Priority jobs** (priority > 0) use a sorted set for ordering, then get promoted to the front of the ready list (LPUSH) so they are dequeued before normal jobs.

This means the common case (no priority) avoids sorted-set overhead entirely.

### Blocking Dequeue (BRPOPLPUSH)

When used with `startWorker()`, a dedicated blocking connection waits on BRPOPLPUSH until a job arrives. This eliminates polling overhead and provides near-instant job pickup. The adapter sets `supportsBlocking: true` to signal this capability to the worker pool.

### Hash Field Packing

Each job is stored as a Redis hash with 13 fields (down from ~30):

- **Hot fields** (individual hash fields): `id`, `queue`, `name`, `payload`, `status`, `priority`, `attempt`, `max_retries`, `completion_token`, `created_at`, `started_at`, `completed_at`
- **Cold fields** (packed into `_ext` JSON blob): backoff settings, workflow IDs, tenant IDs, trace IDs, schema version, metadata, deadlines, cron expressions, results, errors

This reduces memory per job and the number of fields Lua scripts need to read/write.

### Lua Scripts

All critical operations are implemented as atomic Lua scripts:

- **DEQUEUE_SCRIPT** -- RPOP N job IDs from the ready list and activate them atomically.
- **ACK_AND_FETCH_SCRIPT** -- Ack the current job AND dequeue the next in a single call (reduces per-job round-trips from 3 to 2).
- **NACK_SCRIPT** -- Handles requeue (immediate or delayed), dead-letter, and fail in one call.
- **ENQUEUE_PRIORITY_SCRIPT** -- ZADD to the priority sorted set + promote to the ready list.
- **POLL_SCHEDULED_SCRIPT** -- Move due jobs from the scheduled sorted set to the ready list.

### Active Set

Active job tracking uses a plain Redis set (SADD/SREM) instead of a sorted set, since active jobs don't need ordering.

## Performance

| Metric | PsyQueue Redis | BullMQ Redis |
|--------|---------------|-------------|
| Processing throughput | **7,989 jobs/sec** | 6,187 jobs/sec |

Benchmark: 5,000 jobs, concurrency:10, no-op handler, measured after ack. PsyQueue is **1.29x faster** than BullMQ.

## When to Use

- Production multi-worker deployments
- High-throughput job processing (7,989+ jobs/sec)
- Real-time applications needing sub-millisecond latency
- When you already have Redis in your infrastructure

## Exports

- `redis(opts?)` -- Plugin factory function
- `RedisBackendAdapter` -- The adapter class
- `serializeJobToHash(job)` -- Serialize a Job to a Redis hash (hot/cold field packing)
- `deserializeJobFromHash(hash)` -- Deserialize a Redis hash back to a Job

## Documentation

See [Backend Plugins](../../docs/plugins/backends.md) for detailed configuration and migration guides.

## License

MIT
