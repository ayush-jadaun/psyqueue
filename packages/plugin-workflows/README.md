# @psyqueue/plugin-workflows

> DAG-based workflow orchestration for PsyQueue. Define multi-step workflows with dependencies and conditional branching.

## Installation

```bash
npm install @psyqueue/plugin-workflows
```

## Usage

```typescript
import { workflows, workflow } from '@psyqueue/plugin-workflows'

const q = new PsyQueue()
q.use(sqlite({ path: ':memory:' }))

const wf = workflows()
q.use(wf)

const def = workflow('order.process')
  .step('validate', async (ctx) => ({ valid: true }))
  .step('charge', async (ctx) => ({ chargeId: 'ch_123' }), { after: 'validate' })
  .step('ship', async (ctx) => ({ tracking: 'TRK-1' }), { after: 'charge' })
  .build()

wf.engine.registerDefinition(def)

await q.start()
const workflowId = await q.enqueue('order.process', { items: ['widget'] })
```

## Configuration

The `workflows()` factory takes no options. Configure by registering workflow definitions.

**Depends on:** `backend`

## Step Options

| Option | Type | Description |
|--------|------|-------------|
| `after` | `string \| string[]` | Step dependencies |
| `when` | `(ctx) => boolean` | Conditional execution |
| `compensate` | `JobHandler` | Saga compensation handler |

## Exports

- `workflows()` -- Plugin factory
- `workflow(name)` -- Workflow builder factory
- `WorkflowBuilder` -- Builder class
- `WorkflowEngine` -- Engine class
- `WorkflowStore` -- State store

## Documentation

See [Workflow Plugins](../../docs/plugins/workflows.md) for detailed usage, parallel execution, and conditional branching.

## License

MIT
