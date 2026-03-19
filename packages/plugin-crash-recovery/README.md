# @psyqueue/plugin-crash-recovery

> WAL-based crash recovery for PsyQueue. Automatically requeue orphaned jobs after a process crash.

## Installation

```bash
npm install @psyqueue/plugin-crash-recovery
```

## Usage

```typescript
import { crashRecovery } from '@psyqueue/plugin-crash-recovery'

q.use(crashRecovery({
  walPath: './psyqueue.wal',
  autoRecover: true,
  onRecoverActiveJob: 'requeue',
}))
```

## Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `walPath` | `string` | `'./psyqueue.wal'` | Write-ahead log file path |
| `autoRecover` | `boolean` | `true` | Auto-recover on start |
| `onRecoverActiveJob` | `'requeue' \| 'fail' \| Function` | `'requeue'` | Recovery strategy |
| `shutdownTimeout` | `number` | `30000` | Max shutdown wait time (ms) |

**Depends on:** `backend`

## Exports

- `crashRecovery(opts?)` -- Plugin factory
- `WriteAheadLog` -- WAL class
- `recoverFromWal` -- Recovery function

## Documentation

See [Reliability Plugins](../../docs/plugins/reliability.md#crash-recovery) for detailed usage.

## License

MIT
