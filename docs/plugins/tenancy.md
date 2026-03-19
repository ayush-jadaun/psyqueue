# Multi-Tenancy Plugin

Provides per-tenant rate limiting, tiered configuration, and fair scheduling to prevent noisy-neighbor problems in SaaS applications.

## Installation

```bash
npm install @psyqueue/plugin-tenancy
```

## Configuration

```typescript
import { tenancy } from '@psyqueue/plugin-tenancy'

q.use(tenancy({
  tiers: {
    free: {
      rateLimit: { max: 100, window: '1m' },
      concurrency: 2,
      weight: 1,
    },
    pro: {
      rateLimit: { max: 1000, window: '1m' },
      concurrency: 10,
      weight: 5,
    },
    enterprise: {
      rateLimit: { max: 10000, window: '1m' },
      concurrency: 50,
      weight: 20,
    },
  },
  resolveTier: async (tenantId) => {
    // Look up tenant's subscription tier
    const tenant = await db.tenants.findById(tenantId)
    return tenant.plan // 'free', 'pro', or 'enterprise'
  },
  scheduling: 'weighted-fair-queue',
}))
```

**Depends on:** `backend`

### Options

| Option | Type | Description |
|--------|------|-------------|
| `tiers` | `Record<string, TierConfig>` | Tier definitions (see below) |
| `resolveTier` | `(tenantId: string) => Promise<string>` | Async function that resolves a tenant ID to a tier name |
| `scheduling` | `SchedulingMode` | Fair scheduling algorithm |

### TierConfig

```typescript
interface TierConfig {
  rateLimit: {
    max: number          // Maximum requests allowed in the window
    window: '1s' | '1m' | '1h'  // Sliding window duration
  }
  concurrency: number    // Max concurrent jobs for this tier
  weight: number         // Scheduling weight (higher = more capacity share)
}
```

## Rate Limiting

The tenancy plugin enforces per-tenant rate limits on the enqueue path (guard phase). When a tenant exceeds their rate limit, a `RateLimitError` is thrown.

```typescript
try {
  await q.enqueue('task', payload, { tenantId: 'tenant-123' })
} catch (err) {
  if (err instanceof RateLimitError) {
    // err.retryAfter contains suggested wait time in ms
    res.status(429).json({
      error: 'Rate limit exceeded',
      retryAfter: err.retryAfter,
    })
  }
}
```

Rate limiting uses a sliding window algorithm. The window resets continuously, not at fixed intervals.

Jobs enqueued without a `tenantId` bypass rate limiting entirely.

### Events

| Event | Data | When |
|-------|------|------|
| `tenancy:rate-limited` | `{ tenantId, retryAfter }` | Tenant exceeded rate limit |

## Fair Scheduling

The plugin supports three scheduling modes that determine which tenant's jobs get processed when multiple tenants have pending work.

### Scheduling Modes

| Mode | Description |
|------|-------------|
| `weighted-fair-queue` | Tenants receive processing capacity proportional to their tier weight. Uses deficit-counter algorithm. |
| `round-robin` | Tenants take turns regardless of tier. Equal share for all. |
| `strict-priority` | Highest-weight tier always goes first. Lower tiers may starve under load. |

#### Weighted Fair Queue (recommended)

With weights `{ free: 1, pro: 5, enterprise: 20 }`:

- Enterprise gets 20x the throughput share of free
- Pro gets 5x the throughput share of free
- No tenant is completely starved

```typescript
q.use(tenancy({
  tiers: { free: { weight: 1, ... }, pro: { weight: 5, ... } },
  scheduling: 'weighted-fair-queue',
  ...
}))
```

#### Round-Robin

Every tenant gets equal turns regardless of their tier:

```typescript
scheduling: 'round-robin'
```

#### Strict Priority

Higher-weight tiers always go first. Use with caution -- lower tiers can starve:

```typescript
scheduling: 'strict-priority'
```

## Tenant Context

When a tenanted job is enqueued, the plugin attaches tenant context to `ctx.tenant`:

```typescript
q.pipeline('process', async (ctx, next) => {
  if (ctx.tenant) {
    console.log(`Processing for tenant ${ctx.tenant.id} (tier: ${ctx.tenant.tier})`)
  }
  await next()
})
```

## Exposed API

The tenancy plugin exposes a management API:

```typescript
const tenancyApi = q.getExposed('tenancy') as any

// Change a tenant's tier at runtime
tenancyApi.setTier('tenant-123', 'pro')

// Apply per-tenant overrides (e.g., temporary rate limit boost)
tenancyApi.override('tenant-456', {
  rateLimit: { max: 5000 },
  concurrency: 25,
})

// Remove overrides
tenancyApi.removeOverride('tenant-456')

// List known tenants
tenancyApi.list()
// Returns: [{ tenantId: 'tenant-123', tier: 'pro' }, ...]

// Select next tenant to process (used by custom workers)
tenancyApi.selectTenant(['tenant-123', 'tenant-456'])
```

## Real-World Example

```typescript
import { PsyQueue } from '@psyqueue/core'
import { redis } from '@psyqueue/backend-redis'
import { tenancy } from '@psyqueue/plugin-tenancy'

const q = new PsyQueue()

q.use(redis({ host: 'redis.internal' }))
q.use(tenancy({
  tiers: {
    free:       { rateLimit: { max: 60,    window: '1m' }, concurrency: 2,  weight: 1  },
    starter:    { rateLimit: { max: 300,   window: '1m' }, concurrency: 5,  weight: 3  },
    pro:        { rateLimit: { max: 1000,  window: '1m' }, concurrency: 20, weight: 10 },
    enterprise: { rateLimit: { max: 10000, window: '1m' }, concurrency: 100, weight: 50 },
  },
  resolveTier: async (tenantId) => {
    const cache = await redis.get(`tenant:${tenantId}:tier`)
    if (cache) return cache
    const tenant = await db.query('SELECT plan FROM tenants WHERE id = $1', [tenantId])
    await redis.set(`tenant:${tenantId}:tier`, tenant.plan, 'EX', 300)
    return tenant.plan
  },
  scheduling: 'weighted-fair-queue',
}))

// Enqueue with tenant context
q.handle('webhook.deliver', async (ctx) => {
  const { url, payload } = ctx.job.payload as any
  await fetch(url, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
})

await q.start()

// API endpoint
app.post('/webhooks', async (req, res) => {
  try {
    const jobId = await q.enqueue('webhook.deliver', req.body, {
      tenantId: req.auth.tenantId,
    })
    res.json({ jobId })
  } catch (err) {
    if (err.code === 'RATE_LIMIT_EXCEEDED') {
      res.status(429).json({ retryAfter: err.retryAfter })
    }
  }
})
```
