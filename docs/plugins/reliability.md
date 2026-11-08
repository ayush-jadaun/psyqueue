# Reliability Plugins

## Circuit Breaker

Protects downstream services from cascading failures. When a service starts failing, the circuit opens and jobs are requeued or dead-lettered instead of hammering the failing service.

### Installation

```bash
npm install @psyqueue/plugin-circuit-breaker
```

### Configuration

```typescript
import { circuitBreaker } from '@psyqueue/plugin-circuit-breaker'

q.use(circuitBreaker({
  breakers: {
    'payment-api': {
      failureThreshold: 5,
      failureWindow: 30_000,
      resetTimeout: 60_000,
      halfOpenRequests: 3,
      onOpen: 'requeue',
    },
    'email-service': {
      failureThreshold: 10,
      failureWindow: 60_000,
      resetTimeout: 120_000,
      halfOpenRequests: 2,
      onOpen: 'fail',
    },
  },
}))
```

| Breaker Option | Type | Default | Description |
|----------------|------|---------|-------------|
| `failureThreshold` | `number` | *required* | Number of failures within the window to trip the breaker |
| `failureWindow` | `number` | *required* | Time window in ms for counting failures |
| `resetTimeout` | `number` | *required* | Time in ms to wait before transitioning OPEN to HALF_OPEN |
| `halfOpenRequests` | `number` | *required* | Successful requests in HALF_OPEN needed to close the breaker |
| `onOpen` | `'requeue' \| 'fail'` | `'requeue'` | Action when circuit is open |

### Usage in Handlers

Wrap calls to external services with `ctx.breaker()`:

```typescript
q.handle('payment.charge', async (ctx) => {
  const { customerId, amount } = ctx.job.payload as any

  const result = await ctx.breaker('payment-api', async () => {
    return await stripe.charges.create({
      customer: customerId,
      amount,
    })
  })

  return result
})
```

### Circuit States

```
  CLOSED ----[failure threshold reached]----> OPEN
    ^                                           |
    |                                   [resetTimeout elapsed]
    |                                           |
    +------[halfOpenRequests succeed]------ HALF_OPEN
                                               |
                                        [any failure]
                                               |
                                             OPEN
```

| State | Behavior |
|-------|----------|
| **CLOSED** | Normal operation. Failures are counted. |
| **OPEN** | All calls short-circuit. Jobs are requeued or dead-lettered based on `onOpen`. |
| **HALF_OPEN** | Limited requests are allowed through. Success closes the breaker; failure reopens it. |

### Events

| Event | Data | When |
|-------|------|------|
| `circuit:open` | `{ name }` | Breaker tripped open |
| `circuit:half-open` | `{ name }` | Breaker transitioned to half-open |
| `circuit:close` | `{ name }` | Breaker recovered and closed |

### Programmatic Access

```typescript
const plugin = circuitBreaker({ breakers: { ... } })
q.use(plugin)

// Get breaker state
const breaker = plugin.getBreaker('payment-api')
breaker?.currentState // 'CLOSED' | 'OPEN' | 'HALF_OPEN'
```

---

## Backpressure

Adaptive load shedding based on system health signals. Automatically reduces throughput when the system is under pressure.

### Installation

```bash
npm install @psyqueue/plugin-backpressure
```

### Configuration

```typescript
import { backpressure } from '@psyqueue/plugin-backpressure'

q.use(backpressure({
  signals: {
    queueDepth: { pressure: 1000, critical: 5000 },
    errorRate: { pressure: 0.1, critical: 0.5 },
  },
  actions: {
    pressure: ['reduce-concurrency'],
    critical: ['pause-enqueue'],
  },
  recovery: {
    cooldown: 30_000,
    stepUp: 2,
  },
}))
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `signals.queueDepth.pressure` | `number` | - | Queue depth threshold for PRESSURE state |
| `signals.queueDepth.critical` | `number` | - | Queue depth threshold for CRITICAL state |
| `signals.errorRate.pressure` | `number` | - | Error rate threshold (0-1) for PRESSURE |
| `signals.errorRate.critical` | `number` | - | Error rate threshold (0-1) for CRITICAL |
| `actions.pressure` | `string[]` | `[]` | Actions to take in PRESSURE state |
| `actions.critical` | `string[]` | `[]` | Actions to take in CRITICAL state |
| `onPressure` | `Function` | - | Custom handler for PRESSURE state |
| `onCritical` | `Function` | - | Custom handler for CRITICAL state |
| `recovery.cooldown` | `number` | `0` | Time in ms to wait before allowing recovery |
| `recovery.stepUp` | `number` | `10` | Concurrency increase per recovery step |

### Pressure States

| State | Meaning |
|-------|---------|
| `HEALTHY` | System operating normally |
| `PRESSURE` | System under load; reducing throughput |
| `CRITICAL` | System overloaded; aggressive measures |

### Custom Handlers

```typescript
q.use(backpressure({
  signals: { queueDepth: { pressure: 500, critical: 2000 } },
  onPressure: async ({ setConcurrency }) => {
    await setConcurrency(5) // reduce to 5 concurrent workers
  },
  onCritical: async ({ setConcurrency }) => {
    await setConcurrency(1) // reduce to 1 concurrent worker
  },
}))
```

### Updating Metrics

The plugin exposes methods for feeding it system metrics:

```typescript
const bp = backpressure({ signals: { ... } })
q.use(bp)

// Feed metrics from your monitoring system
setInterval(async () => {
  await bp.updateMetrics({
    queueDepth: await getQueueDepth(),
    errorRate: getRecentErrorRate(),
  })
}, 5000)
```

### Events

| Event | Data | When |
|-------|------|------|
| `backpressure:pressure` | `{ state, jobId? }` | Entered PRESSURE state |
| `backpressure:critical` | `{ state, jobId? }` | Entered CRITICAL state |
| `backpressure:healthy` | `{ state }` | Recovered to HEALTHY |

---

## Exactly-Once Delivery

Deduplicates jobs using idempotency keys. Prevents duplicate processing when the same request is submitted multiple times.

### Installation

```bash
npm install @psyqueue/plugin-exactly-once
```

### Configuration

```typescript
import { exactlyOnce } from '@psyqueue/plugin-exactly-once'

q.use(exactlyOnce({
  window: '24h',
  onDuplicate: 'ignore',
  cleanupInterval: '1h',
}))
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `window` | `string` | `'24h'` | Dedup window. Formats: `'500ms'`, `'30s'`, `'5m'`, `'1h'`, `'7d'` |
| `onDuplicate` | `'ignore' \| 'reject'` | `'ignore'` | Action when duplicate detected |
| `cleanupInterval` | `string` | `'1h'` | How often to prune expired dedup keys |

**Depends on:** `backend`

### Usage

Add an `idempotencyKey` when enqueuing:

```typescript
// First call: job is created
const id1 = await q.enqueue('payment.charge', { amount: 4999 }, {
  idempotencyKey: 'order-789-charge',
})

// Second call with same key within window:
const id2 = await q.enqueue('payment.charge', { amount: 4999 }, {
  idempotencyKey: 'order-789-charge',
})

// With 'ignore' mode: id2 === id1 (returns original job ID, no new job created)
// With 'reject' mode: throws DuplicateJobError
```

### Duplicate Handling Modes

| Mode | Behavior |
|------|----------|
| `ignore` | Returns the original job ID. The caller sees success. No new job is created. |
| `reject` | Throws a `DuplicateJobError` with the original job ID. |

```typescript
import { DuplicateJobError } from '@psyqueue/core'

try {
  await q.enqueue('task', payload, { idempotencyKey: 'key-123' })
} catch (err) {
  if (err instanceof DuplicateJobError) {
    console.log(`Duplicate! Original job: ${err.existingJobId}`)
  }
}
```

### Window Duration Formats

| Format | Example | Duration |
|--------|---------|----------|
| Milliseconds | `'500ms'` | 500ms |
| Seconds | `'30s'` | 30 seconds |
| Minutes | `'5m'` | 5 minutes |
| Hours | `'24h'` | 24 hours |
| Days | `'7d'` | 7 days |

---

## Crash Recovery

Crash recovery is built into the core worker; there is no plugin to install.

Every worker renews a lease on each job it holds every `leaseMs / 4`. If a worker crashes or hangs, it stops renewing, and after `leaseMs` (default 60 s) another worker returns the job to the queue. Jobs that run longer than `leaseMs` are safe while their worker is alive.

```typescript
q.startWorker('emails', { concurrency: 10, leaseMs: 60_000 })
```

A worker whose lease expired can't overwrite the job afterwards: its late ack or nack is rejected because the job's completion token changed. Works the same on SQLite, Postgres and Redis.

Processing is at-least-once: a job that was running when its worker died runs again, so side effects in handlers should be idempotent.

> The former `@psyqueue/plugin-crash-recovery` (WAL file) was removed: it marked jobs completed before their handler ran, so it could not recover crashed jobs.
