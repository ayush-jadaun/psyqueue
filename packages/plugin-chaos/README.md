# @psyqueue/plugin-chaos

> Chaos testing for PsyQueue. Inject controlled failures to validate resilience.

## Installation

```bash
npm install @psyqueue/plugin-chaos
```

## Usage

```typescript
import { chaosMode } from '@psyqueue/plugin-chaos'

q.use(chaosMode({
  enabled: process.env.NODE_ENV !== 'production',
  scenarios: [
    { type: 'slowProcess', config: { probability: 0.3, minDelay: 500, maxDelay: 5000 } },
    { type: 'workerCrash', config: { probability: 0.1 } },
    { type: 'duplicateDelivery', config: { probability: 0.05 } },
  ],
}))
```

## Configuration

| Option | Type | Description |
|--------|------|-------------|
| `enabled` | `boolean` | Master switch |
| `scenarios` | `ChaosScenarioEntry[]` | List of scenarios |

### Scenarios

| Type | Config | Description |
|------|--------|-------------|
| `slowProcess` | `{ probability, minDelay, maxDelay }` | Random processing delays |
| `workerCrash` | `{ probability, message? }` | Simulated crashes |
| `duplicateDelivery` | `{ probability, extraRuns? }` | Test idempotency |

## Exports

- `chaosMode(opts)` -- Plugin factory
- `slowProcess`, `workerCrash`, `duplicateDelivery` -- Individual scenario middleware

## Documentation

See [Advanced Plugins](../../docs/plugins/advanced.md#chaos-testing) for detailed usage.

## License

MIT
