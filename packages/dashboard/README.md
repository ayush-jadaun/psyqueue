# @psyqueue/dashboard

> Web-based monitoring dashboard for PsyQueue. View queues, jobs, and system health.

## Installation

```bash
npm install @psyqueue/dashboard
```

## Usage

```typescript
import { dashboard } from '@psyqueue/dashboard'

q.use(dashboard({
  port: 3001,
  auth: { type: 'bearer', credentials: 'my-secret' },
}))

await q.start()
// Dashboard at http://localhost:3001
```

## Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `port` | `number` | - | HTTP server port |
| `auth.type` | `'basic' \| 'bearer'` | - | Authentication type |
| `auth.credentials` | `string` | - | Secret token or `user:password` |

**Depends on:** `backend`

## Exports

- `dashboard(opts?)` -- Plugin factory
- `createDashboardServer(opts)` -- Standalone server factory

## Documentation

See [Observability Plugins](../../docs/plugins/observability.md#dashboard) for detailed usage.

## License

MIT
