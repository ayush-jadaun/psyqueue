# @psyqueue/plugin-schema-versioning

> Payload migration and Zod validation for PsyQueue. Evolve job schemas without breaking existing jobs.

## Installation

```bash
npm install @psyqueue/plugin-schema-versioning
```

## Usage

```typescript
import { schemaVersioning } from '@psyqueue/plugin-schema-versioning'
import { z } from 'zod'

q.use(schemaVersioning())

q.handle('email.send', schemaVersioning.versioned({
  current: 2,
  versions: {
    1: {
      schema: z.object({ to: z.string(), body: z.string() }),
      process: async (ctx) => { /* handle v1 */ },
      migrate: (payload) => ({ ...payload, subject: 'No Subject' }),
    },
    2: {
      schema: z.object({ to: z.string(), subject: z.string(), body: z.string() }),
      process: async (ctx) => { /* handle v2 */ },
    },
  },
}))
```

## Configuration

No plugin-level options. Versioning is configured per-handler via `schemaVersioning.versioned()`.

## Exports

- `schemaVersioning()` -- Plugin factory
- `schemaVersioning.versioned(config)` -- Create versioned handler
- `validatePayload` -- Validation utility

## Documentation

See [Advanced Plugins](../../docs/plugins/advanced.md#schema-versioning) for detailed usage.

## License

MIT
