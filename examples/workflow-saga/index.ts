/**
 * Workflow + Saga Compensation Example
 *
 * Demonstrates:
 *   - Defining a multi-step booking workflow (flight -> hotel -> car)
 *   - Saga compensation: if a step fails, previously completed steps
 *     are automatically compensated in reverse order.
 */
import { PsyQueue } from 'psyqueue'
import { sqlite } from '@psyqueue/backend-sqlite'
import { workflows, workflow } from '@psyqueue/plugin-workflows'
import { saga } from '@psyqueue/plugin-saga'

async function main() {
  const q = new PsyQueue()

  // 1. Register plugins
  q.use(sqlite({ path: ':memory:' }))
  const wfPlugin = workflows()
  q.use(wfPlugin)
  q.use(saga())

  // 2. Define the booking workflow with compensation handlers
  const bookingWorkflow = workflow('book-trip')
    .step('reserve-flight', async (ctx) => {
      const { destination } = ctx.job.payload as { destination: string }
      console.log(`Reserving flight to ${destination}...`)
      return { confirmationId: 'FL-001', destination }
    }, {
      compensate: async (ctx) => {
        console.log('Cancelling flight reservation FL-001...')
        return { cancelled: true }
      },
    })
    .step('reserve-hotel', async (ctx) => {
      const flightResult = ctx.results?.['reserve-flight'] as { destination: string } | undefined
      console.log(`Reserving hotel in ${flightResult?.destination ?? 'unknown'}...`)
      return { confirmationId: 'HT-001' }
    }, {
      after: 'reserve-flight',
      compensate: async (ctx) => {
        console.log('Cancelling hotel reservation HT-001...')
        return { cancelled: true }
      },
    })
    .step('reserve-car', async (ctx) => {
      console.log('Reserving rental car...')
      // This step could fail, triggering saga compensation
      return { confirmationId: 'CR-001' }
    }, {
      after: 'reserve-hotel',
      compensate: async (ctx) => {
        console.log('Cancelling car reservation CR-001...')
        return { cancelled: true }
      },
    })
    .build()

  // 3. Register the workflow definition
  wfPlugin.engine.registerDefinition(bookingWorkflow)

  // 4. Register handlers for each step
  for (const step of bookingWorkflow.steps) {
    q.handle(step.name, step.handler)
  }

  // 5. Listen for workflow events
  q.events.on('workflow:completed', (event) => {
    console.log('Booking workflow completed!', event.data)
  })

  q.events.on('workflow:failed', (event) => {
    console.log('Booking workflow failed, triggering compensation...', event.data)
  })

  q.events.on('workflow:compensated', (event) => {
    console.log('All compensations completed successfully.', event.data)
  })

  // 6. Start and enqueue
  await q.start()

  const workflowId = await q.enqueue('book-trip', { destination: 'Tokyo' })
  console.log(`Started booking workflow: ${workflowId}`)

  // 7. Process the workflow steps
  // In a real app, a worker loop would do this continuously
  for (let i = 0; i < 10; i++) {
    const processed = await q.processNext('default')
    if (!processed) break
  }

  await q.stop()
  console.log('Done.')
}

main().catch(console.error)
