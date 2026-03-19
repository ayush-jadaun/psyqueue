# @psyqueue/plugin-offline-sync

> Local-first offline sync for PsyQueue. Buffer jobs locally when the remote backend is unreachable.

## Installation

```bash
npm install @psyqueue/plugin-offline-sync
```

## Usage

```typescript
import { offlineSync } from '@psyqueue/plugin-offline-sync'

q.use(offlineSync({
  localPath: './local-queue.db',
  sync: { intervalMs: 30_000, autoSync: true },
  maxLocalJobs: 10_000,
}))
```

## Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `localPath` | `string` | *required* | Local SQLite buffer path |
| `sync.intervalMs` | `number` | - | Auto-sync interval (ms) |
| `sync.autoSync` | `boolean` | `true` | Enable background sync |
| `maxLocalJobs` | `number` | - | Max locally-buffered jobs |

## Events

| Event | When |
|-------|------|
| `offline:fallback` | Job buffered after remote failure |
| `offline:auto-synced` | Background sync completed |

## Exports

- `offlineSync(opts)` -- Plugin factory
- `SyncEngine` -- Sync engine class

## Documentation

See [Advanced Plugins](../../docs/plugins/advanced.md#offline-sync) for detailed usage.

## License

MIT
