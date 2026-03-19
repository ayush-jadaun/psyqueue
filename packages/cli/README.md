# @psyqueue/cli

> Command-line tools for PsyQueue. Migrate backends, replay dead letters, and verify audit logs.

## Installation

```bash
npm install -g @psyqueue/cli
```

## Commands

### migrate

Migrate jobs between backends.

```bash
psyqueue migrate --from sqlite:./jobs.db --to redis://localhost:6379 --dry-run
```

| Flag | Description |
|------|-------------|
| `--from <uri>` | Source backend URI |
| `--to <uri>` | Destination backend URI |
| `--dry-run` | Preview without executing |

### replay

Replay dead-lettered jobs.

```bash
psyqueue replay --queue email.send --limit 100
```

| Flag | Description |
|------|-------------|
| `--queue <name>` | Queue to replay from |
| `--limit <n>` | Max jobs to replay |

### audit verify

Verify audit log hash chain integrity.

```bash
psyqueue audit verify --store ./audit.log
```

| Flag | Description |
|------|-------------|
| `--store <path>` | Audit log store path |

## Exports

- `createProgram()` -- Create the Commander program (for embedding)

## License

MIT
