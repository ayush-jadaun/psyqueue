# @psyqueue/plugin-otel-tracing

> OpenTelemetry distributed tracing for PsyQueue. Trace context propagation from enqueue to process.

## Installation

```bash
npm install @psyqueue/plugin-otel-tracing @opentelemetry/api @opentelemetry/sdk-trace-node @opentelemetry/sdk-trace-base
```

## Usage

```typescript
import { otelTracing } from '@psyqueue/plugin-otel-tracing'

q.use(otelTracing({
  serviceName: 'my-worker',
  exporter: 'console',
  traceEnqueue: true,
  traceProcess: true,
}))
```

## Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `serviceName` | `string` | *required* | OTel service name |
| `exporter` | `'console' \| 'memory'` | `'console'` | Span exporter |
| `traceEnqueue` | `boolean` | `true` | Trace enqueue operations |
| `traceProcess` | `boolean` | `true` | Trace process operations |
| `attributes` | `(job) => Record<string, string \| number>` | - | Custom span attributes |

## Documentation

See [Observability Plugins](../../docs/plugins/observability.md#opentelemetry-tracing) for detailed usage.

## License

MIT
