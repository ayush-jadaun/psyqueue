# @psyqueue/plugin-audit-log

> Tamper-evident, hash-chained audit trail for PsyQueue. Records every job lifecycle event.

## Installation

```bash
npm install @psyqueue/plugin-audit-log
```

## Usage

```typescript
import { auditLog } from '@psyqueue/plugin-audit-log'

const plugin = auditLog({
  store: 'file',
  filePath: './audit.log',
  hashChain: true,
})
q.use(plugin)

// Query the audit log
const entries = plugin.audit.query({ event: 'job:completed', queue: 'orders' })

// Verify integrity
const valid = plugin.audit.verify()
```

## Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `store` | `'memory' \| 'file'` | *required* | Storage backend |
| `filePath` | `string` | - | Audit log file path (required for `'file'`) |
| `events` | `'all' \| string[]` | `'all'` | Events to record |
| `includePayload` | `boolean` | `false` | Include job payload |
| `hashChain` | `boolean` | `true` | Enable SHA-256 hash chain |
| `retention` | `string` | - | Retention metadata (e.g., `'90d'`) |

## Exports

- `auditLog(opts)` -- Plugin factory
- `computeHash`, `verifyChain` -- Hash chain utilities

## Documentation

See [Observability Plugins](../../docs/plugins/observability.md#audit-log) for detailed usage.

## License

MIT
