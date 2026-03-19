# @psyqueue/plugin-scheduler

> Delayed jobs and cron scheduling for PsyQueue.

## Installation

```bash
npm install @psyqueue/plugin-scheduler
```

## Usage

```typescript
import { PsyQueue } from 'psyqueue'
import { sqlite } from '@psyqueue/backend-sqlite'
import { scheduler } from '@psyqueue/plugin-scheduler'

const q = new PsyQueue()
q.use(sqlite({ path: ':memory:' }))
q.use(scheduler({ pollInterval: 1000 }))

await q.start()

// Delayed job
await q.enqueue('task', {}, { runAt: new Date(Date.now() + 60_000) })

// Cron job
await q.enqueue('cleanup', {}, { cron: '0 2 * * *' })
```

## Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `pollInterval` | `number` | `1000` | Ms between polling for due scheduled jobs |
| `cronLockTtl` | `number` | `60000` | Lock TTL in ms for cron leader election |

**Depends on:** `backend`

## Exports

- `scheduler(opts?)` -- Plugin factory function
- `computeNextRunAt` -- Compute next cron occurrence

## Documentation

See [Scheduling Plugins](../../docs/plugins/scheduling.md) for detailed usage and configuration.

## License

MIT
