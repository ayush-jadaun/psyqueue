# Workflow Plugins

## Workflows

DAG-based workflow orchestration. Define multi-step workflows with dependencies, conditional branching, and automatic step scheduling.

### Installation

```bash
npm install @psyqueue/plugin-workflows
```

### Configuration

```typescript
import { workflows, workflow } from '@psyqueue/plugin-workflows'

q.use(workflows())
```

The `workflows()` factory takes no configuration options. The plugin is configured by registering workflow definitions.

**Depends on:** `backend`

### Guarantees

- **Durable and multi-process.** Workflow state is stored in the backend, not in memory. A workflow keeps going after a restart or deploy, and any number of processes can run its steps.
- **Each step is enqueued once.** Step jobs carry a deterministic idempotency key, and every state change happens under a per-workflow backend lock, so steps that finish at the same time can't start a downstream step twice.
- **Progress is recorded before the ack.** A step's completion (and the enqueueing of the next steps) happens inside the step job's processing. If the process crashes in between, the step runs again rather than the workflow stalling. Like every job, steps are at-least-once: make side effects idempotent.
- **Steps retry.** A step is retried (default: 3 attempts total) before it fails the workflow. Configure per step with `maxRetries`, `backoff`, `backoffBase`.

### Defining a Workflow

Use the `workflow()` builder to define a DAG of steps:

```typescript
import { workflow } from '@psyqueue/plugin-workflows'

const orderWorkflow = workflow('order.process')
  .step('validate', async (ctx) => {
    const order = ctx.job.payload as Order
    if (!order.items?.length) throw new Error('Empty order')
    return { valid: true, total: calculateTotal(order) }
  })
  .step('charge', async (ctx) => {
    const { total } = ctx.results!['validate'] as { total: number }
    const charge = await stripe.charges.create({ amount: total })
    return { chargeId: charge.id }
  }, {
    after: 'validate',  // depends on validate completing first
  })
  .step('ship', async (ctx) => {
    const order = ctx.job.payload as Order
    const tracking = await shipOrder(order)
    return { trackingNumber: tracking.number }
  }, {
    after: 'charge',
  })
  .step('notify', async (ctx) => {
    const { trackingNumber } = ctx.results!['ship'] as { trackingNumber: string }
    await sendEmail(ctx.job.payload.email, `Your order shipped! Tracking: ${trackingNumber}`)
    return { notified: true }
  }, {
    after: 'ship',
  })
  .build()
```

### Registering and Starting Workflows

Register the workflow definition with the engine, then enqueue by name:

```typescript
const wf = workflows()
q.use(wf)

// Register the definition
wf.engine.registerDefinition(orderWorkflow)

await q.start()

// Start the workflow by enqueueing with the workflow name
const workflowId = await q.enqueue('order.process', {
  items: [{ sku: 'WIDGET-1', qty: 2 }],
  email: 'customer@example.com',
})
```

The workflows plugin intercepts the enqueue call (transform phase) when it detects a registered workflow name, starts the workflow, and enqueues the root steps as individual jobs.

### Step Options

```typescript
interface StepOpts {
  after?: string | string[]    // Step dependencies
  when?: (ctx: { results: Record<string, unknown> }) => boolean  // Conditional execution
  compensate?: JobHandler      // Saga compensation handler
}
```

#### Dependencies

```typescript
// Single dependency
.step('B', handler, { after: 'A' })

// Multiple dependencies (B runs after both A and C complete)
.step('B', handler, { after: ['A', 'C'] })
```

Steps with no dependencies run immediately when the workflow starts.

#### Parallel Execution

Steps that don't depend on each other run in parallel:

```typescript
workflow('parallel-example')
  .step('fetch-users', fetchUsers)        // Runs immediately
  .step('fetch-products', fetchProducts)  // Runs immediately (parallel with fetch-users)
  .step('merge', mergeResults, {
    after: ['fetch-users', 'fetch-products'],  // Waits for both
  })
  .build()
```

#### Conditional Steps

```typescript
.step('premium-shipping', handler, {
  after: 'charge',
  when: ({ results }) => {
    const charge = results['charge'] as { total: number }
    return charge.total > 10000  // Only for orders over $100
  },
})
```

If the `when` predicate returns `false`, the step is skipped and downstream steps can proceed.

### Accessing Previous Results

Inside a step handler, access results from prior steps via `ctx.results`:

```typescript
.step('summarize', async (ctx) => {
  const validation = ctx.results!['validate'] as { total: number }
  const charge = ctx.results!['charge'] as { chargeId: string }

  return {
    summary: `Charged ${validation.total} via ${charge.chargeId}`,
  }
}, { after: ['validate', 'charge'] })
```

The `ctx.workflow` object also provides the workflow ID and step ID:

```typescript
ctx.workflow?.workflowId  // Workflow instance ID
ctx.workflow?.stepId      // Current step name
ctx.workflow?.results     // Same as ctx.results
```

### Workflow Statuses

```typescript
type WorkflowStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'
  | 'COMPENSATING'
  | 'COMPENSATED'
  | 'COMPENSATION_FAILED'
```

### Exposed API

All of these are async (state is read from the backend):

```typescript
const api = q.getExposed('workflows')

await api.list()             // all instances (optionally: api.list('order.process'))
await api.get(workflowId)    // one instance, or undefined
await api.cancel(workflowId) // true if it was running; queued steps are then skipped

// Same through the engine:
await wfPlugin.engine.store.get(workflowId)
```

### Step Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `after` | `string \| string[]` | — | Steps that must finish first |
| `when` | `({ results }) => boolean` | — | Skip the step when this returns false |
| `compensate` | `JobHandler` | — | Undo handler, used by the saga plugin |
| `maxRetries` | `number` | `3` | Total attempts for the step (and its compensation) |
| `backoff` | `'fixed' \| 'linear' \| 'exponential'` | `'exponential'` | Delay strategy between attempts |
| `backoffBase` | `number` | `1000` | Base delay in ms |

### Events

| Event | Data | When |
|-------|------|------|
| `workflow:started` | `{ workflowId, definitionName }` | Workflow instance created |
| `workflow:completed` | `{ workflowId, definitionName }` | All steps completed |
| `workflow:failed` | `{ workflowId, definitionName, failedStep, error }` | A step failed for good, and no other step of the workflow is still running |
| `workflow:cancelled` | `{ workflowId }` | `cancel()` stopped the workflow |

---

## Saga Compensation

Automatic rollback when a workflow fails. When a step is dead-lettered, the saga plugin runs compensation handlers on all previously-completed steps in reverse order.

### Installation

```bash
npm install @psyqueue/plugin-saga
```

### Configuration

```typescript
import { saga } from '@psyqueue/plugin-saga'

q.use(workflows())
q.use(saga())
```

No configuration options. It turns on compensation in the workflows engine.

**Depends on:** `workflows`

### Defining Compensation Handlers

Add `compensate` handlers to workflow steps:

```typescript
const paymentWorkflow = workflow('payment.process')
  .step('reserve-inventory', async (ctx) => {
    const items = ctx.job.payload as Item[]
    const reservation = await inventory.reserve(items)
    return { reservationId: reservation.id }
  }, {
    compensate: async (ctx) => {
      const { reservationId } = ctx.results!['reserve-inventory'] as any
      await inventory.release(reservationId)
    },
  })
  .step('charge-payment', async (ctx) => {
    const { total } = ctx.results!['reserve-inventory'] as any
    const charge = await stripe.charges.create({ amount: total })
    return { chargeId: charge.id }
  }, {
    after: 'reserve-inventory',
    compensate: async (ctx) => {
      const { chargeId } = ctx.results!['charge-payment'] as any
      await stripe.refunds.create({ charge: chargeId })
    },
  })
  .step('send-confirmation', async (ctx) => {
    // If this step fails after retries...
    await sendConfirmationEmail(ctx.job.payload)
  }, {
    after: 'charge-payment',
    // No compensation needed for emails
  })
  .build()
```

If `send-confirmation` fails and is dead-lettered:
1. `charge-payment` compensation runs (refund)
2. `reserve-inventory` compensation runs (release)

### Compensation Order

Compensations run in **reverse completion order** (last completed step first). Only steps that actually completed are compensated. Steps that were skipped, pending, or failed are not compensated.

Compensation starts once no step of the failed workflow is still running, so a parallel step that finishes after its sibling failed is compensated too. Each compensation is a durable job that runs one at a time, with the step's retry settings, so a crash during rollback resumes it.

### Events

| Event | Data | When |
|-------|------|------|
| `workflow:compensating` | `{ workflowId, definitionName, steps }` | Compensation starting (steps in run order) |
| `workflow:compensation-step-failed` | `{ workflowId, step }` | One compensation failed after its retries |
| `workflow:compensated` | `{ workflowId, definitionName }` | All compensations succeeded |
| `workflow:compensation-failed` | `{ workflowId, definitionName, failedSteps }` | Finished, but some compensations failed |

### Compensation Failure

If a compensation handler keeps failing after its retries, the remaining compensations **still run**. At the end the workflow is `COMPENSATION_FAILED`, `instance.compensation.failed` lists the steps that couldn't be undone, and `workflow:compensation-failed` is emitted. Monitor this event: those steps need manual intervention.
