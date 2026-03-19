/**
 * Example 04: Complex DAG Workflow — Order Processing
 *
 * Demonstrates:
 *   - Defining a multi-step DAG with the workflow() builder
 *   - Parallel branches (steps with no inter-dependency run concurrently)
 *   - Steps that depend on multiple prior steps (fan-in)
 *   - Passing results between steps via ctx.results
 *   - Conditional steps using `when` (step only runs if condition is met)
 *   - Workflow lifecycle events: workflow:completed, workflow:failed
 *
 * Workflow shape:
 *
 *   validate-order
 *       ├── charge-payment ──────────────────┐
 *       ├── reserve-inventory                 │
 *       │       └── fulfill-order ◄───────────┘
 *       └── send-confirmation (when: order > $100)
 *
 * Run: npx tsx examples/04-workflow-dag/index.ts
 */

import { PsyQueue } from '@psyqueue/core'
import { sqlite } from '@psyqueue/backend-sqlite'
import { workflows, workflow } from '@psyqueue/plugin-workflows'

async function main() {
  console.log('=== Complex DAG Workflow: Order Processing ===\n')

  const q = new PsyQueue()
  q.use(sqlite({ path: ':memory:' }))

  const wfPlugin = workflows()
  q.use(wfPlugin)

  // ── Define the DAG ─────────────────────────────────────────────────────────

  const orderWorkflow = workflow('process-order')

    // Step 1: Validate order — no dependencies (root step).
    .step('validate-order', async (ctx) => {
      const payload = ctx.job.payload as { orderId: string; total: number; items: string[] }
      console.log(`  [validate-order] Validating order ${payload.orderId}`)
      if (payload.total <= 0) throw new Error('Order total must be positive')
      return { valid: true, orderId: payload.orderId, total: payload.total, items: payload.items }
    })

    // Step 2a: Charge payment — depends on validate-order.
    .step('charge-payment', async (ctx) => {
      const validated = ctx.results?.['validate-order'] as { orderId: string; total: number }
      console.log(`  [charge-payment] Charging $${validated.total} for order ${validated.orderId}`)
      // Simulate payment gateway call
      await new Promise(r => setTimeout(r, 30))
      return { charged: true, transactionId: `TXN-${Date.now()}`, amount: validated.total }
    }, { after: 'validate-order' })

    // Step 2b: Reserve inventory — runs in parallel with charge-payment.
    .step('reserve-inventory', async (ctx) => {
      const validated = ctx.results?.['validate-order'] as { orderId: string; items: string[] }
      console.log(`  [reserve-inventory] Reserving ${validated.items.length} items for order ${validated.orderId}`)
      await new Promise(r => setTimeout(r, 20))
      return { reserved: true, items: validated.items, warehouseId: 'WH-EU-01' }
    }, { after: 'validate-order' })

    // Step 3: Fulfill order — waits for BOTH charge-payment and reserve-inventory (fan-in).
    .step('fulfill-order', async (ctx) => {
      const payment = ctx.results?.['charge-payment'] as { transactionId: string }
      const inventory = ctx.results?.['reserve-inventory'] as { warehouseId: string }
      console.log(`  [fulfill-order] Fulfilling via ${inventory.warehouseId} (txn: ${payment.transactionId})`)
      return { fulfilled: true, shippingLabel: `SHIP-${Date.now()}` }
    }, { after: ['charge-payment', 'reserve-inventory'] })

    // Step 4: Send VIP confirmation — conditional: only runs when order total > 100.
    .step('send-vip-confirmation', async (ctx) => {
      const validated = ctx.results?.['validate-order'] as { orderId: string; total: number }
      console.log(`  [send-vip-confirmation] Sending VIP email for $${validated.total} order`)
      return { emailSent: true }
    }, {
      after: 'validate-order',
      when: ({ results }) => {
        const validated = results['validate-order'] as { total: number } | undefined
        return (validated?.total ?? 0) > 100
      },
    })

    .build()

  // Register the workflow definition and its step handlers.
  wfPlugin.engine.registerDefinition(orderWorkflow)
  for (const step of orderWorkflow.steps) {
    q.handle(step.name, step.handler)
  }

  // ── Events ─────────────────────────────────────────────────────────────────

  q.events.on('job:started', (e) => {
    const d = e.data as { name: string }
    console.log(`  [event] job:started  name=${d.name}`)
  })

  q.events.on('workflow:completed', (e) => {
    const d = e.data as { workflowId: string; definitionName: string }
    console.log(`\n  [event] workflow:completed  workflowId=${d.workflowId.slice(0, 8)}  def=${d.definitionName}`)
  })

  q.events.on('workflow:failed', (e) => {
    const d = e.data as { workflowId: string; failedStep: string; error: string }
    console.log(`\n  [event] workflow:failed  failedStep=${d.failedStep}  error=${d.error}`)
  })

  await q.start()
  console.log('Queue started.\n')

  // ── Start a workflow: HIGH-VALUE order (total > 100, VIP step will run) ────

  console.log('-- Starting workflow: $250 order (VIP step should run) --')
  const workflowId1 = await q.enqueue('process-order', {
    orderId: 'ORD-001',
    total: 250,
    items: ['laptop', 'mouse', 'keyboard'],
  })
  console.log(`  Workflow started: ${workflowId1.slice(0, 8)}\n`)

  // Drive the workflow by processing jobs until all are done.
  // The engine enqueues multiple steps as they become ready.
  for (let i = 0; i < 20; i++) {
    const processed = await q.processNext('default')
    if (!processed) break
  }

  // Alternative: use startWorker() for continuous processing (production pattern)
  // In production, replace the manual processNext loop with:
  //
  // q.startWorker('process-order', { concurrency: 5, pollInterval: 50 })
  //
  // The workflow engine automatically enqueues downstream steps as prior
  // steps complete. startWorker() picks them up and processes them.

  // ── Start a second workflow: LOW-VALUE order (VIP step will be skipped) ───

  console.log('\n-- Starting workflow: $45 order (VIP step should be skipped) --')
  const workflowId2 = await q.enqueue('process-order', {
    orderId: 'ORD-002',
    total: 45,
    items: ['book'],
  })
  console.log(`  Workflow started: ${workflowId2.slice(0, 8)}\n`)

  for (let i = 0; i < 20; i++) {
    const processed = await q.processNext('default')
    if (!processed) break
  }

  // ── Inspect workflow state via the engine ────────────────────────────────

  console.log('\n-- Workflow state --')
  const instances = wfPlugin.engine.store.list()
  for (const instance of instances) {
    console.log(`  workflowId=${instance.id.slice(0, 8)}  status=${instance.status}`)
    for (const [stepName, state] of Object.entries(instance.steps)) {
      console.log(`    step=${stepName}  status=${state.status}  skipped=${state.skipped ?? false}`)
    }
  }

  await q.stop()
  console.log('\nDone!')
}

main().catch(console.error)
