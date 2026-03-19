# @psyqueue/plugin-metrics

> Prometheus metrics for PsyQueue. Tracks enqueued, completed, failed counts, processing duration, and queue depth.

## Installation

```bash
npm install @psyqueue/plugin-metrics prom-client
```

## Usage

```typescript
import { metrics } from '@psyqueue/plugin-metrics'

const plugin = metrics({ prefix: 'psyqueue' })
q.use(plugin)

// Expose metrics endpoint
const registry = plugin.getRegistry()
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', registry.contentType)
  res.end(await registry.metrics())
})
```

## Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `prefix` | `string` | `'psyqueue'` | Metric name prefix |
| `defaultLabels` | `Record<string, string>` | - | Labels for all metrics |
| `registry` | `Registry` | `new Registry()` | Custom prom-client Registry |

## Exported Metrics

| Metric | Type | Labels |
|--------|------|--------|
| `{prefix}_jobs_enqueued_total` | Counter | `queue`, `name` |
| `{prefix}_jobs_completed_total` | Counter | `queue`, `name` |
| `{prefix}_jobs_failed_total` | Counter | `queue`, `name` |
| `{prefix}_job_duration_ms` | Histogram | `queue`, `name` |
| `{prefix}_queue_depth` | Gauge | `queue` |

## Documentation

See [Observability Plugins](../../docs/plugins/observability.md#prometheus-metrics) for detailed usage.

## License

MIT
