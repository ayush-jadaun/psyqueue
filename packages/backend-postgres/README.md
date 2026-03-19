# @psyqueue/backend-postgres

> Postgres backend for PsyQueue. ACID-compliant relational storage using pg.

## Installation

```bash
npm install psyqueue @psyqueue/backend-postgres
```

## Usage

```typescript
import { PsyQueue } from 'psyqueue'
import { postgres } from '@psyqueue/backend-postgres'

const q = new PsyQueue()
q.use(postgres({
  connectionString: 'postgresql://user:pass@localhost:5432/psyqueue',
}))

await q.start()
```

## Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `connectionString` | `string` | - | Full Postgres connection string |
| `host` | `string` | `'localhost'` | Postgres host |
| `port` | `number` | `5432` | Postgres port |
| `database` | `string` | - | Database name |
| `user` | `string` | - | Database user |
| `password` | `string` | - | Database password |
| `ssl` | `boolean` | `false` | Enable SSL |
| `max` | `number` | `10` | Connection pool size |

## When to Use

- Enterprise applications with ACID requirements
- Audit compliance (SQL-queryable job history)
- When Postgres is already in your stack

## Exports

- `postgres(opts?)` -- Plugin factory function
- `PostgresBackendAdapter` -- The adapter class

## Documentation

See [Backend Plugins](../../docs/plugins/backends.md) for detailed configuration and migration guides.

## License

MIT
