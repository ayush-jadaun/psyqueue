# @psyqueue/backend-redis

> Redis backend for PsyQueue. High-throughput production storage using ioredis.

## Installation

```bash
npm install psyqueue @psyqueue/backend-redis
```

## Usage

```typescript
import { PsyQueue } from 'psyqueue'
import { redis } from '@psyqueue/backend-redis'

const q = new PsyQueue()
q.use(redis({ host: 'localhost', port: 6379 }))

await q.start()
```

## Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `host` | `string` | `'localhost'` | Redis host |
| `port` | `number` | `6379` | Redis port |
| `password` | `string` | - | Redis password |
| `db` | `number` | `0` | Redis database number |
| `url` | `string` | - | Full Redis connection URL |
| `keyPrefix` | `string` | `'psyqueue:'` | Prefix for all Redis keys |

## When to Use

- Production multi-worker deployments
- High-throughput job processing
- Real-time applications needing sub-millisecond latency

## Exports

- `redis(opts?)` -- Plugin factory function
- `RedisBackendAdapter` -- The adapter class

## Documentation

See [Backend Plugins](../../docs/plugins/backends.md) for detailed configuration and migration guides.

## License

MIT
