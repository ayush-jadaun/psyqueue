# @psyqueue/plugin-saga

> Saga compensation for PsyQueue workflows. Automatic rollback when a workflow step fails.

## Installation

```bash
npm install @psyqueue/plugin-saga
```

## Usage

```typescript
import { saga } from '@psyqueue/plugin-saga'
import { workflows, workflow } from '@psyqueue/plugin-workflows'

q.use(workflows())
q.use(saga())

const def = workflow('payment')
  .step('reserve', reserveHandler, {
    compensate: async (ctx) => { await releaseReservation(ctx) },
  })
  .step('charge', chargeHandler, {
    after: 'reserve',
    compensate: async (ctx) => { await refundCharge(ctx) },
  })
  .build()
```

## Configuration

No configuration options. The plugin listens for `workflow:failed` events and runs compensations automatically.

**Depends on:** `workflows`

## How It Works

When a workflow step is dead-lettered, the saga plugin runs compensation handlers on all previously-completed steps in reverse completion order.

## Events

| Event | Data | When |
|-------|------|------|
| `workflow:compensating` | `{ workflowId, definitionName }` | Compensation starting |
| `workflow:compensated` | `{ workflowId, definitionName }` | All compensations succeeded |
| `workflow:compensation-failed` | `{ workflowId, definitionName }` | A compensation handler threw |

## Documentation

See [Workflow Plugins](../../docs/plugins/workflows.md#saga-compensation) for detailed usage.

## License

MIT
