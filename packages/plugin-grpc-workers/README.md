# @psyqueue/plugin-grpc-workers

> gRPC worker transport for PsyQueue. Distribute job processing to remote workers over gRPC.

## Installation

```bash
npm install @psyqueue/plugin-grpc-workers
```

## Usage

```typescript
import { grpcWorkers } from '@psyqueue/plugin-grpc-workers'

q.use(grpcWorkers({
  port: 50051,
  auth: true,
  tokens: ['worker-token-abc'],
  queues: ['email.send'],
}))
```

## Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `port` | `number` | *required* | gRPC server port |
| `auth` | `boolean` | - | Enable token authentication |
| `tokens` | `string[]` | - | Allowed worker tokens |
| `queues` | `string[]` | - | Restrict accessible queues |

## Exports

- `grpcWorkers(opts)` -- Plugin factory
- `GrpcWorkerServer` -- Server class

## Documentation

See [Transport Plugins](../../docs/plugins/transport.md#grpc-workers) for detailed usage.

## License

MIT
