# @psyqueue/plugin-tenancy

> Multi-tenancy for PsyQueue. Per-tenant rate limits, tiered configuration, and fair scheduling.

## Installation

```bash
npm install @psyqueue/plugin-tenancy
```

## Usage

```typescript
import { tenancy } from '@psyqueue/plugin-tenancy'

q.use(tenancy({
  tiers: {
    free: { rateLimit: { max: 100, window: '1m' }, concurrency: 2, weight: 1 },
    pro:  { rateLimit: { max: 1000, window: '1m' }, concurrency: 10, weight: 5 },
  },
  resolveTier: async (tenantId) => {
    const tenant = await db.tenants.findById(tenantId)
    return tenant.plan
  },
  scheduling: 'weighted-fair-queue',
}))

await q.enqueue('task', payload, { tenantId: 'tenant-123' })
```

## Configuration

| Option | Type | Description |
|--------|------|-------------|
| `tiers` | `Record<string, TierConfig>` | Tier definitions with rate limits, concurrency, and weights |
| `resolveTier` | `(tenantId: string) => Promise<string>` | Resolve tenant ID to tier name |
| `scheduling` | `'weighted-fair-queue' \| 'round-robin' \| 'strict-priority'` | Fair scheduling algorithm |

### TierConfig

| Field | Type | Description |
|-------|------|-------------|
| `rateLimit.max` | `number` | Max requests per window |
| `rateLimit.window` | `'1s' \| '1m' \| '1h'` | Sliding window duration |
| `concurrency` | `number` | Max concurrent jobs |
| `weight` | `number` | Scheduling weight |

**Depends on:** `backend`

## Exports

- `tenancy(opts)` -- Plugin factory
- `TierManager` -- Tier management class
- `SlidingWindowRateLimiter` -- Rate limiter
- `FairScheduler` -- Fair scheduling implementation

## Documentation

See [Multi-Tenancy Plugin](../../docs/plugins/tenancy.md) for detailed usage, scheduling modes, and real-world examples.

## License

MIT
