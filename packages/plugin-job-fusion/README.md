# @psyqueue/plugin-job-fusion

> Job batching and fusion for PsyQueue. Combine similar jobs into a single fused job.

## Installation

```bash
npm install @psyqueue/plugin-job-fusion
```

## Usage

```typescript
import { jobFusion } from '@psyqueue/plugin-job-fusion'

q.use(jobFusion({
  rules: [{
    match: 'notification.send',
    groupBy: (job) => (job.payload as any).userId,
    window: 5000,
    maxBatch: 50,
    fuse: (jobs) => ({
      userId: (jobs[0]!.payload as any).userId,
      messages: jobs.map(j => (j.payload as any).message),
    }),
  }],
}))
```

## Configuration

### FusionRule

| Field | Type | Description |
|-------|------|-------------|
| `match` | `string` | Job name to intercept |
| `groupBy` | `(job) => string` | Group key function |
| `window` | `number` | Batch window (ms) |
| `maxBatch` | `number` | Max jobs per batch |
| `fuse` | `(jobs) => unknown` | Merge payloads into one |

## Exports

- `jobFusion(opts)` -- Plugin factory
- `BatchCollector` -- Batch collector class

## Documentation

See [Advanced Plugins](../../docs/plugins/advanced.md#job-fusion) for detailed usage.

## License

MIT
