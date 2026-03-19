# psyqueue

> Micro-kernel distributed job queue platform where everything is a plugin.

## Installation

```bash
npm install psyqueue
```

## Quick Start

```typescript
import { PsyQueue } from '@psyqueue/core'
import { sqlite } from '@psyqueue/backend-sqlite'

const q = new PsyQueue()
q.use(sqlite({ path: ':memory:' }))

q.handle('email.send', async (ctx) => {
  const { to, subject } = ctx.job.payload as any
  await sendEmail(to, subject)
  return { sent: true }
})

await q.start()
await q.enqueue('email.send', { to: 'alice@example.com', subject: 'Hello' })

// Simple: process one job at a time
await q.processNext('email.send')

// Production: start a continuous worker pool
q.startWorker('email.send', { concurrency: 10 })

await q.stop()
```

## Core API

| Method | Description |
|--------|-------------|
| `new PsyQueue()` | Create a new queue instance |
| `PsyQueue.from(preset)` | Create from a preset (`'lite'`, `'saas'`, `'enterprise'`) |
| `q.use(plugin)` | Register a plugin (chainable) |
| `q.handle(name, handler)` | Register a job handler |
| `q.enqueue(name, payload, opts?)` | Enqueue a job |
| `q.enqueueBulk(items)` | Bulk enqueue jobs |
| `q.processNext(queue)` | Dequeue and process the next job |
| `q.startWorker(queue, opts?)` | Start a continuous worker pool for a queue |
| `q.stopWorkers()` | Stop all running worker pools |
| `q.pipeline(event, fn, opts?)` | Register middleware |
| `q.start()` | Start the queue |
| `q.stop()` | Stop the queue (also stops all workers) |
| `q.events` | Event bus for lifecycle events |
| `q.deadLetter` | Dead letter queue management |

## Exports

- `PsyQueue` -- Main class
- `EventBus` -- Event bus implementation
- `PluginRegistry` -- Plugin registry
- `MiddlewarePipeline` -- Middleware pipeline
- `createJob`, `generateId` -- Job creation utilities
- `createContext` -- Context factory
- `presets` -- Preset configurations
- All types and error classes

## Documentation

See the [full documentation](../../docs/getting-started.md) for detailed guides, plugin references, and architecture overview.

## License

MIT
