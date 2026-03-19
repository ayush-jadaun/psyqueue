# Backend Plugins

PsyQueue supports three storage backends. All implement the same `BackendAdapter` interface, so you can swap between them without changing application code.

## When to Use Which

| Backend | Best For | Tradeoffs |
|---------|----------|-----------|
| **SQLite** | Development, prototyping, single-process apps, edge/embedded | No network setup. Not suited for multi-process workers. |
| **Redis** | High-throughput production, multi-worker setups | Requires Redis server. No ACID transactions across jobs. |
| **Postgres** | Enterprise, audit requirements, ACID compliance, complex queries | Slightly higher latency than Redis. Requires Postgres server. |

---

## SQLite Backend

Embedded storage using [better-sqlite3](https://github.com/WiseLibs/better-sqlite3). No external infrastructure required.

### Installation

```bash
npm install @psyqueue/backend-sqlite
```

### Configuration

```typescript
import { sqlite } from '@psyqueue/backend-sqlite'

q.use(sqlite({
  path: './jobs.db',     // File path, or ':memory:' for in-memory
}))
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `path` | `string` | *required* | SQLite database file path. Use `':memory:'` for in-memory databases (useful for testing). |

### When to Use

- Local development and prototyping
- Single-process applications
- Edge computing or embedded scenarios
- Tests (use `:memory:` for fast, isolated tests)

### Limitations

- Single-writer: only one process can write at a time
- Not suitable for horizontally-scaled worker pools
- Data lives on a single machine

---

## Redis Backend

High-performance backend using [ioredis](https://github.com/redis/ioredis). Designed for production multi-worker deployments.

### Installation

```bash
npm install @psyqueue/backend-redis
```

### Configuration

```typescript
import { redis } from '@psyqueue/backend-redis'

// Option 1: Individual settings
q.use(redis({
  host: 'localhost',
  port: 6379,
  password: 'secret',
  db: 0,
  keyPrefix: 'psyqueue:',
}))

// Option 2: Connection URL
q.use(redis({
  url: 'redis://:secret@localhost:6379/0',
}))
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `host` | `string` | `'localhost'` | Redis host |
| `port` | `number` | `6379` | Redis port |
| `password` | `string` | - | Redis password |
| `db` | `number` | `0` | Redis database number |
| `url` | `string` | - | Full Redis connection URL. Overrides host/port/password/db. |
| `keyPrefix` | `string` | `'psyqueue:'` | Prefix for all Redis keys |

### When to Use

- Production multi-worker deployments
- High-throughput job processing (10k+ jobs/sec)
- When you already have Redis in your infrastructure
- Real-time applications needing sub-millisecond dequeue latency

### Features

- Atomic operations via Lua scripts
- Distributed locking for cron leader election
- Sorted sets for priority-based dequeue
- Pub/sub for real-time notifications

---

## Postgres Backend

ACID-compliant relational backend using [pg](https://node-postgres.com/). Best for enterprise workloads with audit requirements.

### Installation

```bash
npm install @psyqueue/backend-postgres
```

### Configuration

```typescript
import { postgres } from '@psyqueue/backend-postgres'

// Option 1: Connection string
q.use(postgres({
  connectionString: 'postgresql://user:pass@localhost:5432/psyqueue',
}))

// Option 2: Individual settings
q.use(postgres({
  host: 'localhost',
  port: 5432,
  database: 'psyqueue',
  user: 'psyqueue',
  password: 'secret',
  ssl: true,
  max: 20,
}))
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `connectionString` | `string` | - | Full Postgres connection string. Overrides other connection options. |
| `host` | `string` | `'localhost'` | Postgres host |
| `port` | `number` | `5432` | Postgres port |
| `database` | `string` | - | Database name |
| `user` | `string` | - | Database user |
| `password` | `string` | - | Database password |
| `ssl` | `boolean` | `false` | Enable SSL |
| `max` | `number` | `10` | Connection pool size |

### When to Use

- Enterprise applications with ACID requirements
- Audit compliance (SQL-queryable job history)
- Complex reporting queries on job data
- When you already have Postgres and want to avoid adding Redis

### Features

- ACID transactions for atomic operations
- `SELECT ... FOR UPDATE SKIP LOCKED` for safe concurrent dequeue
- Auto-creates schema on first connect
- Connection pooling via `pg.Pool`

---

## Migrating Between Backends

Use the PsyQueue CLI to migrate jobs between backends:

```bash
npx psyqueue migrate \
  --from sqlite:./jobs.db \
  --to redis://localhost:6379 \
  --dry-run
```

The migration tool:
1. Connects to the source backend
2. Reads all jobs (pending, scheduled, dead)
3. Connects to the destination backend
4. Bulk-enqueues jobs to the destination
5. Verifies counts match

### Zero-Downtime Migration Pattern

1. Deploy with both backends configured (read from old, write to both)
2. Drain the old backend (process remaining jobs)
3. Switch reads to the new backend
4. Remove the old backend configuration

Since all backends implement the same interface, your handlers and middleware work without changes.
