# @psyqueue/plugin-backpressure

> Adaptive backpressure for PsyQueue. Automatically reduce throughput when the system is under pressure.

## Installation

```bash
npm install @psyqueue/plugin-backpressure
```

## Usage

```typescript
import { backpressure } from '@psyqueue/plugin-backpressure'

q.use(backpressure({
  signals: {
    queueDepth: { pressure: 1000, critical: 5000 },
    errorRate: { pressure: 0.1, critical: 0.5 },
  },
  recovery: { cooldown: 30_000, stepUp: 2 },
}))
```

## Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `signals.queueDepth.pressure` | `number` | - | Queue depth threshold for PRESSURE |
| `signals.queueDepth.critical` | `number` | - | Queue depth threshold for CRITICAL |
| `signals.errorRate.pressure` | `number` | - | Error rate threshold (0-1) for PRESSURE |
| `signals.errorRate.critical` | `number` | - | Error rate threshold (0-1) for CRITICAL |
| `recovery.cooldown` | `number` | `0` | Cooldown before recovery (ms) |
| `recovery.stepUp` | `number` | `10` | Concurrency increase per recovery step |

## Exports

- `backpressure(opts)` -- Plugin factory
- `SignalMonitor` -- Signal monitoring class

## Documentation

See [Reliability Plugins](../../docs/plugins/reliability.md#backpressure) for detailed usage.

## License

MIT
