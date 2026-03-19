# Transport Plugins

Transport plugins let you distribute job processing to remote workers over the network. The PsyQueue server manages the queue, while workers connect via gRPC or HTTP to fetch and complete jobs.

## gRPC Workers

Runs a gRPC server that remote workers connect to for dequeuing, acking, and nacking jobs.

### Installation

```bash
npm install @psyqueue/plugin-grpc-workers
```

### Configuration

```typescript
import { grpcWorkers } from '@psyqueue/plugin-grpc-workers'

q.use(grpcWorkers({
  port: 50051,
  auth: true,
  tokens: ['worker-token-abc', 'worker-token-def'],
  queues: ['email.send', 'report.generate'],
}))
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `port` | `number` | *required* | gRPC server port |
| `auth` | `boolean` | - | Enable token-based authentication |
| `tokens` | `string[]` | - | Allowed authentication tokens (required if `auth` is `true`) |
| `queues` | `string[]` | - | Restrict which queues workers can dequeue from. Omit to allow all. |

### Events

| Event | Data | When |
|-------|------|------|
| `grpc:listening` | `{ port }` | gRPC server started |

### Exposed API

```typescript
const api = q.getExposed('grpc-workers') as any

api.port           // The actual port (useful if 0 was passed for auto-assign)
api.server         // The GrpcWorkerServer instance
api.getWorkers()   // List connected workers
```

### How It Works

1. The gRPC server starts during `q.start()`.
2. Remote workers connect and call `Dequeue` to fetch jobs.
3. Workers process the job locally.
4. Workers call `Ack` (success) or `Nack` (failure) to report the result.
5. Events are emitted on the PsyQueue event bus as if the job were processed locally.

### Worker Implementation

Workers connect using a standard gRPC client and call these methods:

- `Dequeue(queue, count)` -- Fetch pending jobs
- `Ack(jobId, completionToken)` -- Mark job as completed
- `Nack(jobId, opts)` -- Report failure (with optional requeue)

---

## HTTP Workers

Runs an HTTP server that remote workers connect to for dequeuing and completing jobs. Simpler than gRPC for environments where gRPC is not available.

### Installation

```bash
npm install @psyqueue/plugin-http-workers
```

### Configuration

```typescript
import { httpWorkers } from '@psyqueue/plugin-http-workers'

q.use(httpWorkers({
  port: 8080,
  auth: { type: 'bearer', tokens: ['worker-secret'] },
  queues: ['email.send'],
}))
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `port` | `number` | *required* | HTTP server port |
| `auth` | `object` | - | Authentication configuration |
| `auth.type` | `'bearer'` | - | Authentication type |
| `auth.tokens` | `string[]` | - | Allowed bearer tokens |
| `queues` | `string[]` | - | Restrict which queues workers can access. Omit to allow all. |

### Events

| Event | Data | When |
|-------|------|------|
| `http:listening` | `{ port }` | HTTP server started |

### Exposed API

```typescript
const api = q.getExposed('http-workers') as any

api.port           // Actual listening port
api.server         // HttpWorkerServer instance
api.getWorkers()   // List connected workers
```

### HTTP Endpoints

The HTTP worker server exposes these REST-like endpoints:

| Method | Path | Description |
|--------|------|-------------|
| `POST /dequeue` | `{ queue, count }` | Fetch pending jobs |
| `POST /ack` | `{ jobId, completionToken }` | Acknowledge successful completion |
| `POST /nack` | `{ jobId, opts }` | Report failure |
| `GET /health` | - | Health check |

### Authentication

Workers include the bearer token in the `Authorization` header:

```bash
curl -X POST http://localhost:8080/dequeue \
  -H "Authorization: Bearer worker-secret" \
  -H "Content-Type: application/json" \
  -d '{"queue": "email.send", "count": 1}'
```

---

## Choosing Between gRPC and HTTP

| Aspect | gRPC | HTTP |
|--------|------|------|
| **Performance** | Binary protocol, faster serialization | JSON over HTTP, slightly more overhead |
| **Streaming** | Supports bidirectional streaming | Request/response only |
| **Tooling** | Requires gRPC client libraries | Any HTTP client works (curl, fetch) |
| **Firewall** | May need special configuration | Works through standard HTTP proxies |
| **Polyglot** | Proto definitions for any language | REST is universal |

Use gRPC for high-throughput, low-latency worker pools. Use HTTP for simplicity, broader compatibility, or when workers are written in languages without good gRPC support.
