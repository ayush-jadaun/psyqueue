# @psyqueue/backend-sqlite

> SQLite backend for PsyQueue. Zero-infrastructure embedded storage using better-sqlite3.

## Installation

```bash
npm install psyqueue @psyqueue/backend-sqlite
```

## Usage

```typescript
import { PsyQueue } from 'psyqueue'
import { sqlite } from '@psyqueue/backend-sqlite'

const q = new PsyQueue()
q.use(sqlite({ path: './jobs.db' }))

await q.start()
```

## Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `path` | `string` | *required* | SQLite database file path. Use `':memory:'` for in-memory databases. |

## When to Use

- Local development and prototyping
- Single-process applications
- Edge computing or embedded scenarios
- Tests (use `:memory:` for fast, isolated test databases)

## Exports

- `sqlite(opts)` -- Plugin factory function
- `SQLiteBackendAdapter` -- The adapter class (for advanced use)

## Documentation

See [Backend Plugins](../../docs/plugins/backends.md) for detailed configuration and migration guides.

## License

MIT
