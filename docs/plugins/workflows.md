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

```typescript
const api = q.getExposed('workflows')

// List all workflow instances
api.list()

// Get a specific instance
api.get(workflowId)

// Cancel a running workflow
api.cancel(workflowId)
```

### Events

| Event | Data | When |
|-------|------|------|
| `workflow:started` | `{ workflowId, definitionName }` | Workflow instance created |
| `workflow:completed` | `{ workflowId, definitionName }` | All steps completed |
| `workflow:failed` | `{ workflowId, definitionName, failedStep, error }` | A step was dead-lettered |

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

No configuration options. The plugin listens for `workflow:failed` events and triggers compensation.

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

### Events

| Event | Data | When |
|-------|------|------|
| `workflow:compensating` | `{ workflowId, definitionName }` | Compensation starting |
| `workflow:compensated` | `{ workflowId, definitionName }` | All compensations succeeded |
| `workflow:compensation-failed` | `{ workflowId, definitionName }` | A compensation handler threw |

### Compensation Failure

If a compensation handler itself throws, the workflow transitions to `COMPENSATION_FAILED`. The `workflow:compensation-failed` event is emitted. You should monitor for this event and handle it with manual intervention or alerts.
