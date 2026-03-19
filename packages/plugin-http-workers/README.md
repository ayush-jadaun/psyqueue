# @psyqueue/plugin-http-workers

> HTTP worker transport for PsyQueue. Distribute job processing to remote workers over HTTP.

## Installation

```bash
npm install @psyqueue/plugin-http-workers
```

## Usage

```typescript
import { httpWorkers } from '@psyqueue/plugin-http-workers'

q.use(httpWorkers({
  port: 8080,
  auth: { type: 'bearer', tokens: ['worker-secret'] },
  queues: ['email.send'],
}))
```

## Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `port` | `number` | *required* | HTTP server port |
| `auth.type` | `'bearer'` | - | Authentication type |
| `auth.tokens` | `string[]` | - | Allowed bearer tokens |
| `queues` | `string[]` | - | Restrict accessible queues |

## Exports

- `httpWorkers(opts)` -- Plugin factory
- `HttpWorkerServer` -- Server class

## Documentation

See [Transport Plugins](../../docs/plugins/transport.md#http-workers) for detailed usage.

## License

MIT
