# @psyqueue/plugin-exactly-once

> Exactly-once delivery for PsyQueue via idempotency key deduplication.

## Installation

```bash
npm install @psyqueue/plugin-exactly-once
```

## Usage

```typescript
import { exactlyOnce } from '@psyqueue/plugin-exactly-once'

q.use(exactlyOnce({ window: '24h', onDuplicate: 'ignore' }))

// First call: creates job
const id1 = await q.enqueue('task', data, { idempotencyKey: 'order-123' })

// Duplicate call: returns same ID, no new job
const id2 = await q.enqueue('task', data, { idempotencyKey: 'order-123' })
// id1 === id2
```

## Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `window` | `string` | `'24h'` | Dedup window (`'500ms'`, `'30s'`, `'5m'`, `'1h'`, `'7d'`) |
| `onDuplicate` | `'ignore' \| 'reject'` | `'ignore'` | Action on duplicate |
| `cleanupInterval` | `string` | `'1h'` | Expired key cleanup interval |

**Depends on:** `backend`

## Documentation

See [Reliability Plugins](../../docs/plugins/reliability.md#exactly-once-delivery) for detailed usage.

## License

MIT
