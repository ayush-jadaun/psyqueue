/**
 * Example 05: Saga Compensation — Booking Workflow
 *
 * Demonstrates:
 *   - Defining a saga-style workflow where each step has a compensate handler
 *   - What happens when a step fails after prior steps succeeded
 *   - Automatic compensation in reverse order (flight ← hotel ← payment)
 *   - Compensation lifecycle events: workflow:compensating, workflow:compensated
 *
 * Booking flow:
 *
 *   book-flight ──► book-hotel ──► charge-card ──► send-itinerary
 *
 * In this demo, charge-card fails. The saga plugin automatically cancels
 * hotel and flight reservations in reverse completion order.
 *
 * Run: npx tsx examples/05-saga-compensation/index.ts
 */

import { PsyQueue } from 'psyqueue'
import { sqlite } from '@psyqueue/backend-sqlite'
import { workflows, workflow } from '@psyqueue/plugin-workflows'
import { saga } from '@psyqueue/plugin-saga'

async function main() {
  console.log('=== Saga Compensation: Booking Workflow ===\n')

  const q = new PsyQueue()
  q.use(sqlite({ path: ':memory:' }))

  const wfPlugin = workflows()
  q.use(wfPlugin)

  // The saga plugin listens for workflow:failed events and automatically
  // invokes compensate handlers in reverse completion order.
  q.use(saga())

  // ── Define the booking saga ───────────────────────────────────────────────

  const bookingWorkflow = workflow('book-trip')

    // Step 1: Reserve flight
    .step('book-flight', async (ctx) => {
      const { destination, dates } = ctx.job.payload as { destination: string; dates: string }
      console.log(`  [book-flight] Reserving flight to ${destination} for ${dates}`)
      await new Promise(r => setTimeout(r, 20))
      return { flightRef: 'FL-2024-TYO-001', airline: 'SkyAir', destination }
    }, {
      compensate: async (ctx) => {
        const result = ctx.results?.['book-flight'] as { flightRef: string } | undefined
        console.log(`  [COMPENSATE book-flight] Cancelling flight ${result?.flightRef ?? 'unknown'}`)
        return { cancelled: true, refundAmount: 450 }
      },
    })

    // Step 2: Reserve hotel (depends on flight)
    .step('book-hotel', async (ctx) => {
      const flight = ctx.results?.['book-flight'] as { destination: string }
      console.log(`  [book-hotel] Reserving hotel in ${flight.destination}`)
      await new Promise(r => setTimeout(r, 15))
      return { hotelRef: 'HT-2024-TYO-007', hotel: 'Grand Shibuya', nights: 5 }
    }, {
      after: 'book-flight',
      compensate: async (ctx) => {
        const result = ctx.results?.['book-hotel'] as { hotelRef: string } | undefined
        console.log(`  [COMPENSATE book-hotel] Cancelling hotel ${result?.hotelRef ?? 'unknown'}`)
        return { cancelled: true, refundAmount: 900 }
      },
    })

    // Step 3: Charge credit card (depends on hotel) — will FAIL
    .step('charge-card', async (ctx) => {
      const flight = ctx.results?.['book-flight'] as { flightRef: string }
      const hotel = ctx.results?.['book-hotel'] as { hotelRef: string }
      console.log(`  [charge-card] Charging for flight=${flight.flightRef} hotel=${hotel.hotelRef}`)
      // Simulate a payment decline
      throw new Error('Card declined: insufficient funds')
    }, {
      after: 'book-hotel',
      compensate: async (_ctx) => {
        // charge-card never succeeded, so nothing to reverse
        console.log('  [COMPENSATE charge-card] Nothing to reverse (charge never completed)')
        return { cancelled: true }
      },
    })

    // Step 4: Send itinerary (would run only if charge-card succeeded)
    .step('send-itinerary', async (ctx) => {
      const charge = ctx.results?.['charge-card'] as { amount: number }
      console.log(`  [send-itinerary] Sending itinerary email (paid $${charge.amount})`)
      return { emailSent: true }
    }, { after: 'charge-card' })

    .build()

  wfPlugin.engine.registerDefinition(bookingWorkflow)
  for (const step of bookingWorkflow.steps) {
    q.handle(step.name, step.handler)
  }

  // ── Events ──────────────────────────────────────────────────────────────────

  q.events.on('job:started', (e) => {
    const d = e.data as { name: string }
    console.log(`  [event] job:started        name=${d.name}`)
  })

  q.events.on('job:failed', (e) => {
    const d = e.data as { name: string; error: string }
    console.log(`  [event] job:failed         name=${d.name}  error="${d.error}"`)
  })

  q.events.on('job:dead', (e) => {
    const d = e.data as { name: string }
    console.log(`  [event] job:dead           name=${d.name}`)
  })

  q.events.on('workflow:failed', (e) => {
    const d = e.data as { workflowId: string; failedStep: string; error: string }
    console.log(`\n  [event] workflow:failed    failedStep=${d.failedStep}`)
    console.log(`          Saga will now compensate completed steps in reverse order...`)
  })

  q.events.on('workflow:compensating', (e) => {
    const d = e.data as { workflowId: string }
    console.log(`\n  [event] workflow:compensating  workflowId=${d.workflowId.slice(0, 8)}`)
  })

  q.events.on('workflow:compensated', (e) => {
    const d = e.data as { workflowId: string }
    console.log(`  [event] workflow:compensated   workflowId=${d.workflowId.slice(0, 8)} ✓`)
    console.log('          All reservations cancelled successfully.')
  })

  q.events.on('workflow:compensation-failed', (e) => {
    const d = e.data as { workflowId: string }
    console.log(`  [event] workflow:compensation-failed  workflowId=${d.workflowId.slice(0, 8)}`)
  })

  await q.start()
  console.log('Queue started.\n')

  // ── Start the booking workflow ────────────────────────────────────────────

  console.log('-- Starting booking workflow (charge-card will fail) --')
  const workflowId = await q.enqueue('book-trip', {
    destination: 'Tokyo',
    dates: '2026-06-01 to 2026-06-07',
    passengers: 2,
  })
  console.log(`  Workflow started: ${workflowId.slice(0, 8)}\n`)

  // Drive the workflow steps (charge-card has 0 retries so it goes straight to dead letter)
  for (let i = 0; i < 20; i++) {
    const processed = await q.processNext('default')
    if (!processed) {
      // Small wait for async compensation to complete
      await new Promise(r => setTimeout(r, 100))
      break
    }
  }

  // ── Show final workflow state ─────────────────────────────────────────────

  console.log('\n-- Final workflow state --')
  const instance = wfPlugin.engine.store.get(workflowId)
  if (instance) {
    console.log(`  status: ${instance.status}`)
    for (const [name, state] of Object.entries(instance.steps)) {
      console.log(`  step=${name}  status=${state.status}`)
    }
  }

  await q.stop()
  console.log('\nDone!')
}

main().catch(console.error)
