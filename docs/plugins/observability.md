# Observability Plugins

## OpenTelemetry Tracing

Adds distributed tracing to job enqueue and process operations using the OpenTelemetry SDK. Trace context is propagated from producer (enqueue) to consumer (process) via job metadata.

### Installation

```bash
npm install @psyqueue/plugin-otel-tracing @opentelemetry/api @opentelemetry/sdk-trace-node @opentelemetry/sdk-trace-base
```

### Configuration

```typescript
import { otelTracing } from '@psyqueue/plugin-otel-tracing'

q.use(otelTracing({
  serviceName: 'my-worker',
  exporter: 'console',
  traceEnqueue: true,
  traceProcess: true,
  attributes: (job) => ({
    'app.tenant': job.tenantId ?? 'unknown',
    'app.queue': job.queue,
  }),
}))
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `serviceName` | `string` | *required* | OpenTelemetry service name |
| `exporter` | `'console' \| 'memory'` | `'console'` | Span exporter. `'memory'` is useful for testing. |
| `exporterInstance` | `InMemorySpanExporter` | - | Provide a pre-configured exporter (for testing) |
| `traceEnqueue` | `boolean` | `true` | Create spans for enqueue operations |
| `traceProcess` | `boolean` | `true` | Create spans for process operations |
| `attributes` | `(job: Job) => Record<string, string \| number>` | - | Custom span attributes |

### Span Details

**Enqueue span:**
- Name: `psyqueue.enqueue`
- Kind: `PRODUCER`
- Attributes: `psyqueue.job.id`, `psyqueue.job.name`, `psyqueue.job.queue`, `psyqueue.job.attempt`, plus custom attributes

**Process span:**
- Name: `psyqueue.process`
- Kind: `CONSUMER`
- Parent: Linked to the enqueue span via trace context propagated in `job.meta`
- Attributes: Same as enqueue span

### Trace Propagation

The tracing plugin stores trace context in `job.meta['_otel_traceId']` and `job.meta['_otel_spanId']`. When processing a job, it reconstructs the parent context so the process span is linked to the enqueue span. This works across process boundaries and backends.

### Integration with OTLP

To export to Jaeger, Zipkin, or any OTLP collector, configure your OpenTelemetry SDK separately and use the plugin's tracing alongside your existing setup. The plugin creates a local `NodeTracerProvider` to avoid polluting the global provider.

### Testing

```typescript
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base'

const exporter = new InMemorySpanExporter()
const plugin = otelTracing({
  serviceName: 'test',
  exporterInstance: exporter,
})

q.use(plugin)
await q.start()

await q.enqueue('test-job', {})
await q.processNext('test-job')

const spans = exporter.getFinishedSpans()
// spans[0].name === 'psyqueue.enqueue'
// spans[1].name === 'psyqueue.process'
```

---

## Prometheus Metrics

Exposes Prometheus-compatible metrics using [prom-client](https://github.com/siimon/prom-client). Tracks enqueue counts, completion counts, failure counts, processing duration, and queue depth.

### Installation

```bash
npm install @psyqueue/plugin-metrics prom-client
```

### Configuration

```typescript
import { metrics } from '@psyqueue/plugin-metrics'

q.use(metrics({
  prefix: 'psyqueue',
  defaultLabels: { service: 'my-worker' },
}))
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `prefix` | `string` | `'psyqueue'` | Metric name prefix |
| `defaultLabels` | `Record<string, string>` | - | Labels added to all metrics |
| `registry` | `Registry` | `new Registry()` | Custom prom-client Registry (for testing or multi-registry setups) |

### Exported Metrics

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `{prefix}_jobs_enqueued_total` | Counter | `queue`, `name` | Total jobs enqueued |
| `{prefix}_jobs_completed_total` | Counter | `queue`, `name` | Total jobs completed |
| `{prefix}_jobs_failed_total` | Counter | `queue`, `name` | Total jobs failed |
| `{prefix}_job_duration_ms` | Histogram | `queue`, `name` | Processing duration in milliseconds |
| `{prefix}_queue_depth` | Gauge | `queue` | Current pending jobs per queue |

### Histogram Buckets

Default duration buckets (ms): `10, 50, 100, 250, 500, 1000, 2500, 5000, 10000`

### Exposing to Prometheus

```typescript
import { createServer } from 'node:http'

const plugin = metrics()
q.use(plugin)

createServer(async (req, res) => {
  if (req.url === '/metrics') {
    const registry = plugin.getRegistry()
    res.setHeader('Content-Type', registry.contentType)
    res.end(await registry.metrics())
  }
}).listen(9090)
```

### Grafana Dashboard

Query examples for Grafana:

```promql
# Job throughput
rate(psyqueue_jobs_completed_total[5m])

# Error rate
rate(psyqueue_jobs_failed_total[5m]) / rate(psyqueue_jobs_enqueued_total[5m])

# P99 processing duration
histogram_quantile(0.99, rate(psyqueue_job_duration_ms_bucket[5m]))

# Queue depth
psyqueue_queue_depth
```

---

## Audit Log

Tamper-evident, hash-chained audit trail for every job lifecycle event. Useful for compliance, debugging, and forensic analysis.

### Installation

```bash
npm install @psyqueue/plugin-audit-log
```

### Configuration

```typescript
import { auditLog } from '@psyqueue/plugin-audit-log'

q.use(auditLog({
  store: 'file',
  filePath: './audit.log',
  events: 'all',
  includePayload: false,
  hashChain: true,
  retention: '90d',
}))
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `store` | `'memory' \| 'file'` | *required* | Storage backend. `'memory'` for testing, `'file'` for production. |
| `filePath` | `string` | - | Path to audit log file (required when `store: 'file'`) |
| `events` | `'all' \| string[]` | `'all'` | Which events to record |
| `includePayload` | `boolean` | `false` | Include job payload in audit entries |
| `hashChain` | `boolean` | `true` | Enable SHA-256 hash chain for tamper evidence |
| `retention` | `string` | - | Retention metadata (e.g., `'90d'`). Does not auto-prune. |

### Recorded Events

By default, the plugin records all of these events:

**Pipeline events:** `enqueue`, `process`

**Bus events:** `job:completed`, `job:failed`, `job:retry`, `job:dead`, `job:requeued`, `job:replayed`, `job:enqueued`, `job:started`

To record only specific events:

```typescript
q.use(auditLog({
  store: 'memory',
  events: ['enqueue', 'job:completed', 'job:failed', 'job:dead'],
}))
```

### Audit Entry Format

```typescript
interface AuditEntry {
  id: string            // UUID
  timestamp: string     // ISO 8601
  event: string         // Event name
  jobId: string
  jobName: string
  queue: string
  tenantId?: string
  payload?: unknown     // Only if includePayload: true
  prevHash: string      // Hash of the previous entry
  hash: string          // SHA-256 hash of this entry + prevHash
}
```

### Querying the Audit Log

```typescript
const plugin = auditLog({ store: 'memory' })
q.use(plugin)

// Query entries
const entries = plugin.audit.query({
  event: 'job:completed',
  queue: 'payment.charge',
  from: new Date('2025-01-01'),
  to: new Date('2025-01-31'),
})

// Query by job ID
const jobHistory = plugin.audit.query({ jobId: 'some-job-id' })

// Query multiple event types
const failures = plugin.audit.query({
  event: ['job:failed', 'job:dead'],
})
```

### Hash Chain Verification

Verify that the audit log has not been tampered with:

```typescript
const isValid = plugin.audit.verify()
// true if the entire chain is intact

// Verify a range
const rangeValid = plugin.audit.verify(100, 200)
```

The hash chain uses SHA-256. Each entry's hash is computed from the entry data concatenated with the previous entry's hash. If any entry is modified, deleted, or inserted, verification fails.

---

## Dashboard

Web-based monitoring UI for PsyQueue. View queues, jobs, and system health.

### Installation

```bash
npm install @psyqueue/dashboard
```

### Configuration

```typescript
import { dashboard } from '@psyqueue/dashboard'

q.use(dashboard({
  port: 3001,
  auth: {
    type: 'bearer',
    credentials: 'my-secret-token',
  },
}))
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `port` | `number` | - | HTTP port for the dashboard |
| `auth` | `object` | - | Authentication configuration |
| `auth.type` | `'basic' \| 'bearer'` | - | Authentication type |
| `auth.credentials` | `string` | - | Secret token or `user:password` string |

**Depends on:** `backend`

### Usage

```typescript
await q.start()

// Start the dashboard server manually via exposed API
const dashApi = q.getExposed('dashboard') as any
await dashApi.start()

// Dashboard available at http://localhost:3001
```

### Authentication

**Bearer token:**
```typescript
q.use(dashboard({
  port: 3001,
  auth: { type: 'bearer', credentials: 'my-secret-token' },
}))
// Access: curl -H "Authorization: Bearer my-secret-token" http://localhost:3001
```

**Basic auth:**
```typescript
q.use(dashboard({
  port: 3001,
  auth: { type: 'basic', credentials: 'admin:password' },
}))
```

### Features

- Queue overview (pending, active, completed, failed, dead counts)
- Job list with filtering and pagination
- Job detail view (payload, status, attempts, errors)
- Dead letter management (replay, purge)
- Real-time updates via SSE
