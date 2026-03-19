# Advanced Plugins

## Chaos Testing

Inject controlled failures into job processing for resilience testing. Validate that your retry logic, circuit breakers, and compensation handlers work correctly under adverse conditions.

### Installation

```bash
npm install @psyqueue/plugin-chaos
```

### Configuration

```typescript
import { chaosMode } from '@psyqueue/plugin-chaos'

q.use(chaosMode({
  enabled: process.env.CHAOS_ENABLED === 'true',
  scenarios: [
    {
      type: 'slowProcess',
      config: { probability: 0.3, minDelay: 500, maxDelay: 5000 },
    },
    {
      type: 'workerCrash',
      config: { probability: 0.1, message: 'Simulated crash' },
    },
    {
      type: 'duplicateDelivery',
      config: { probability: 0.05, extraRuns: 1 },
    },
  ],
}))
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | `boolean` | *required* | Master switch. When `false`, no chaos is injected. |
| `scenarios` | `ChaosScenarioEntry[]` | *required* | List of chaos scenarios to apply |

### Scenarios

#### Slow Process

Adds a random delay before processing to simulate slow external services or network latency.

```typescript
{
  type: 'slowProcess',
  config: {
    probability: 0.3,   // 30% of jobs affected
    minDelay: 500,       // Minimum delay in ms
    maxDelay: 5000,      // Maximum delay in ms
  },
}
```

| Config | Type | Description |
|--------|------|-------------|
| `probability` | `number` | Chance of triggering (0.0-1.0) |
| `minDelay` | `number` | Minimum added delay in ms |
| `maxDelay` | `number` | Maximum added delay in ms |

When triggered, sets `ctx.state['chaos_slowProcess'] = true` and `ctx.state['chaos_delay']` with the actual delay.

#### Worker Crash

Throws an error to simulate a worker crash.

```typescript
{
  type: 'workerCrash',
  config: {
    probability: 0.1,
    message: 'Simulated OOM',
  },
}
```

| Config | Type | Description |
|--------|------|-------------|
| `probability` | `number` | Chance of triggering (0.0-1.0) |
| `message` | `string` | Error message (default: `'Chaos: simulated worker crash'`) |

#### Duplicate Delivery

Runs the handler multiple times to test idempotency.

```typescript
{
  type: 'duplicateDelivery',
  config: {
    probability: 0.05,
    extraRuns: 1,
  },
}
```

| Config | Type | Description |
|--------|------|-------------|
| `probability` | `number` | Chance of triggering (0.0-1.0) |
| `extraRuns` | `number` | How many extra times to run the handler (default: 1) |

### Events

| Event | Data | When |
|-------|------|------|
| `chaos:enabled` | `{ scenarios: string[] }` | Plugin initialized with chaos enabled |

### Safety

The `enabled` flag is the master switch. Set it to `false` in production:

```typescript
q.use(chaosMode({
  enabled: process.env.NODE_ENV !== 'production',
  scenarios: [ /* ... */ ],
}))
```

---

## Offline Sync

Local-first job queue with background synchronization. When the remote backend is unreachable, jobs are buffered locally and synced when connectivity is restored.

### Installation

```bash
npm install @psyqueue/plugin-offline-sync
```

### Configuration

```typescript
import { offlineSync } from '@psyqueue/plugin-offline-sync'

q.use(offlineSync({
  localPath: './local-queue.db',
  sync: {
    intervalMs: 30_000,
    autoSync: true,
  },
  maxLocalJobs: 10_000,
}))
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `localPath` | `string` | *required* | Path to local SQLite buffer database |
| `remote` | `string` | `'backend'` | Namespace of the remote backend |
| `sync.intervalMs` | `number` | - | Auto-sync interval in ms |
| `sync.autoSync` | `boolean` | `true` | Enable automatic background sync |
| `maxLocalJobs` | `number` | - | Maximum jobs to buffer locally |

### How It Works

1. When a job is enqueued, it goes through the normal pipeline.
2. If the remote backend's enqueue fails (network error, timeout, etc.), the guard middleware catches the error and buffers the job locally.
3. A background timer periodically pushes locally-buffered jobs to the remote backend.
4. On `q.stop()`, a final push attempt is made.

### Manual Sync

```typescript
const api = q.getExposed('offline-sync') as any

// Manually push buffered jobs
const synced = await api.push()
console.log(`Synced ${synced} jobs`)

// Check how many jobs are buffered
const count = api.unsyncedCount()

// List locally-buffered jobs
const localJobs = api.listLocal()
```

### Events

| Event | Data | When |
|-------|------|------|
| `offline:fallback` | `{ jobId, queue, error }` | Job buffered locally after remote failure |
| `offline:auto-synced` | `{ count }` | Auto-sync pushed buffered jobs |

### Use Cases

- Mobile or edge applications with intermittent connectivity
- Local development with an unreliable network
- Disaster recovery: buffer jobs during backend outages

---

## Job Fusion

Batches multiple similar jobs into a single fused job. Reduces database writes and network calls for high-volume scenarios like notifications, analytics events, or webhook deliveries.

### Installation

```bash
npm install @psyqueue/plugin-job-fusion
```

### Configuration

```typescript
import { jobFusion } from '@psyqueue/plugin-job-fusion'

q.use(jobFusion({
  rules: [
    {
      match: 'notification.send',
      groupBy: (job) => job.payload.userId,
      window: 5000,          // 5-second batching window
      maxBatch: 50,          // Flush after 50 items
      fuse: (jobs) => ({
        userId: jobs[0].payload.userId,
        messages: jobs.map(j => j.payload.message),
        count: jobs.length,
      }),
    },
  ],
}))
```

### FusionRule

```typescript
interface FusionRule {
  match: string                   // Job name to match
  groupBy: (job: Job) => string   // Group key function
  window: number                  // Max time to wait before flushing (ms)
  maxBatch: number                // Max jobs per batch
  fuse: (jobs: Job[]) => unknown  // Combine job payloads into one
}
```

| Field | Type | Description |
|-------|------|-------------|
| `match` | `string` | Job name to intercept |
| `groupBy` | `(job: Job) => string` | Returns a group key. Jobs with the same key are batched together. |
| `window` | `number` | Batching window in ms. Jobs are flushed after this duration. |
| `maxBatch` | `number` | Maximum batch size. The batch flushes immediately when this count is reached. |
| `fuse` | `(jobs: Job[]) => unknown` | Merge function. Receives all jobs in the batch and returns a single payload. |

### How It Works

1. When a matching job is enqueued, the transform middleware intercepts it and adds it to a batch collector.
2. The original enqueue is short-circuited (the job is NOT persisted individually).
3. The batch flushes when either the `window` expires or `maxBatch` is reached.
4. A fused job is created with the merged payload and enqueued to the backend.

### Fused Job Properties

The fused job inherits properties from the batch:
- **Priority:** Maximum priority from all jobs in the batch
- **Deadline:** Earliest deadline from all jobs in the batch
- **Timeout:** Maximum timeout from all jobs in the batch
- **Metadata:** Includes `fusion.originalJobIds`, `fusion.groupKey`, `fusion.count`

### Events

| Event | Data | When |
|-------|------|------|
| `job:fused` | `{ fusedJobId, originalJobIds, groupKey, count }` | Batch flushed and fused job enqueued |

### Example: Batch Webhook Delivery

```typescript
q.use(jobFusion({
  rules: [{
    match: 'webhook.deliver',
    groupBy: (job) => (job.payload as any).endpoint,
    window: 2000,
    maxBatch: 100,
    fuse: (jobs) => ({
      endpoint: (jobs[0]!.payload as any).endpoint,
      events: jobs.map(j => (j.payload as any).event),
    }),
  }],
}))

// Handle the fused job
q.handle('webhook.deliver', async (ctx) => {
  const { endpoint, events } = ctx.job.payload as any
  // events is an array of all batched events
  await fetch(endpoint, {
    method: 'POST',
    body: JSON.stringify({ events }),
  })
})
```

---

## Schema Versioning

Payload migration and validation for evolving job schemas. When your payload format changes, define migration functions between versions and the plugin handles the rest.

### Installation

```bash
npm install @psyqueue/plugin-schema-versioning
```

### Configuration

```typescript
import { schemaVersioning } from '@psyqueue/plugin-schema-versioning'

q.use(schemaVersioning())
```

No configuration options for the plugin itself. Versioning is configured per-handler.

### Defining Versioned Handlers

Use `schemaVersioning.versioned()` to create a handler with version-aware processing:

```typescript
import { schemaVersioning } from '@psyqueue/plugin-schema-versioning'
import { z } from 'zod'

q.use(schemaVersioning())

q.handle('email.send', schemaVersioning.versioned({
  current: 2,
  versions: {
    1: {
      schema: z.object({
        to: z.string(),
        body: z.string(),
      }),
      process: async (ctx) => {
        // Handle v1 payloads
        const { to, body } = ctx.job.payload as any
        await sendEmail(to, 'No Subject', body)
      },
      migrate: (payload: any) => ({
        to: payload.to,
        subject: 'No Subject',
        body: payload.body,
      }),
    },
    2: {
      schema: z.object({
        to: z.string(),
        subject: z.string(),
        body: z.string(),
      }),
      process: async (ctx) => {
        // Handle v2 payloads (current)
        const { to, subject, body } = ctx.job.payload as any
        await sendEmail(to, subject, body)
      },
    },
  },
}))
```

### VersionConfig

```typescript
interface VersionConfig {
  schema: ZodSchema            // Zod schema for validation
  process: JobHandler          // Handler for this version
  migrate?: (payload: unknown) => unknown  // Migrate FROM this version to the next
}
```

### How It Works

1. Job is dequeued with `schemaVersion: 1`.
2. Plugin detects current version is `2`.
3. Builds migration chain: `v1.migrate` transforms the payload.
4. Validates the migrated payload against `v2.schema`.
5. If valid, calls `v2.process`.
6. If invalid, dead-letters with `SCHEMA_MISMATCH`.

### Migration Chains

Migrations are composable. If you're on version 3 and receive a version 1 payload:

```
v1 --[v1.migrate]--> v2 --[v2.migrate]--> v3
```

Each version's `migrate` function only needs to handle the transformation from that version to the next.

### Enqueuing with a Schema Version

```typescript
await q.enqueue('email.send', {
  to: 'user@example.com',
  subject: 'Hello',
  body: 'World',
}, {
  meta: { schemaVersion: 2 },
})
```

Jobs without a `schemaVersion` default to version 1.

### Validation

Validation uses [Zod](https://zod.dev) schemas. If the payload does not match the current version's schema after migration, the job is dead-lettered with a `SCHEMA_MISMATCH` reason.
