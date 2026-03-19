/**
 * Example 07: Circuit Breaker
 *
 * Demonstrates:
 *   - Wrapping an external API call with a named circuit breaker
 *   - Breaker state transitions: CLOSED → OPEN → HALF_OPEN → CLOSED
 *   - circuit:open, circuit:half-open, circuit:close events
 *   - Jobs being requeued when the circuit is OPEN (onOpen: 'requeue')
 *   - Breaker recovering after resetTimeout elapses
 *
 * Run: npx tsx examples/07-circuit-breaker/index.ts
 */

import { PsyQueue } from 'psyqueue'
import { sqlite } from '@psyqueue/backend-sqlite'
import { circuitBreaker } from '@psyqueue/plugin-circuit-breaker'

// Simulated external payment API — fails on the first N calls.
let apiCallCount = 0
async function callPaymentApi(amount: number): Promise<{ txId: string }> {
  apiCallCount++
  // Fail calls 1–4, succeed from call 5 onward.
  if (apiCallCount <= 4) {
    throw new Error(`Payment API timeout (call #${apiCallCount})`)
  }
  return { txId: `TXN-${apiCallCount}` }
}

async function main() {
  console.log('=== Circuit Breaker ===\n')

  const q = new PsyQueue()
  q.use(sqlite({ path: ':memory:' }))

  // Configure a circuit breaker named "payment-api".
  // After 3 failures within 10 seconds, the circuit opens.
  // After 2 seconds the circuit moves to HALF_OPEN and allows one probe request.
  // 1 successful probe closes the circuit again.
  const cbPlugin = circuitBreaker({
    breakers: {
      'payment-api': {
        failureThreshold: 3,     // Open after 3 failures
        failureWindow: 10_000,   // Count failures within 10 s
        resetTimeout: 2_000,     // Wait 2 s before half-opening
        halfOpenRequests: 1,     // 1 success closes the circuit
        onOpen: 'requeue',       // Requeue jobs when circuit is open
      },
    },
  })
  q.use(cbPlugin)

  // ── Handler ───────────────────────────────────────────────────────────────

  q.handle('charge-customer', async (ctx) => {
    const { customerId, amount } = ctx.job.payload as { customerId: string; amount: number }

    // ctx.breaker() wraps the call with circuit-breaker protection.
    // If the circuit is OPEN, the plugin calls ctx.requeue() automatically.
    const result = await ctx.breaker('payment-api', () => callPaymentApi(amount))

    if (result) {
      const r = result as { txId: string }
      console.log(`  [charge-customer] SUCCESS  customer=${customerId}  txId=${r.txId}`)
      return { charged: true, txId: r.txId }
    }
    // Result is undefined when the circuit short-circuited (job was requeued).
    console.log(`  [charge-customer] Circuit open — job requeued`)
    return undefined
  })

  // ── Events ────────────────────────────────────────────────────────────────

  q.events.on('circuit:open', (e) => {
    const d = e.data as { name: string }
    console.log(`  [event] circuit:open      breaker=${d.name}  — rejecting calls, job will be requeued`)
  })

  q.events.on('circuit:half-open', (e) => {
    const d = e.data as { name: string }
    console.log(`  [event] circuit:half-open breaker=${d.name}  — allowing probe request`)
  })

  q.events.on('circuit:close', (e) => {
    const d = e.data as { name: string }
    console.log(`  [event] circuit:close     breaker=${d.name}  — circuit healed, normal traffic resumed`)
  })

  q.events.on('job:requeued', (e) => {
    const d = e.data as { jobId: string; name: string }
    console.log(`  [event] job:requeued      name=${d.name}  id=${d.jobId.slice(0, 8)}`)
  })

  q.events.on('job:retry', (e) => {
    const d = e.data as { name: string; attempt: number; delay: number }
    console.log(`  [event] job:retry         name=${d.name}  attempt=${d.attempt}  delay=${d.delay}ms`)
  })

  q.events.on('job:completed', (e) => {
    const d = e.data as { name: string; result: unknown }
    console.log(`  [event] job:completed     name=${d.name}  result=${JSON.stringify(d.result)}`)
  })

  await q.start()
  console.log('Queue started.\n')

  // ── Enqueue 6 charge jobs ──────────────────────────────────────────────────

  console.log('-- Enqueueing 6 charge jobs --')
  for (let i = 1; i <= 6; i++) {
    await q.enqueue(
      'charge-customer',
      { customerId: `CUST-${i}`, amount: i * 10 },
      { maxRetries: 5, backoff: 'exponential', backoffBase: 100 },
    )
  }

  // ── Process: first 3 calls fail, circuit opens ────────────────────────────

  console.log('\n-- Processing first batch (failures will trip the breaker) --')
  for (let i = 0; i < 6; i++) {
    await q.processNext('default')
  }

  // ── Inspect breaker state ─────────────────────────────────────────────────

  const breaker = cbPlugin.getBreaker('payment-api')
  console.log(`\n-- Breaker state after failures: ${breaker?.currentState} --`)

  // ── Wait for resetTimeout, then process again (circuit goes HALF_OPEN) ───

  console.log('\n-- Waiting 2.5s for resetTimeout to elapse... --')
  await new Promise(r => setTimeout(r, 2_500))

  console.log('\n-- Processing again (circuit should HALF_OPEN and then CLOSE) --')
  // apiCallCount is now 4 — next call (#5) will succeed.
  for (let i = 0; i < 10; i++) {
    const processed = await q.processNext('default')
    if (!processed) break
    await new Promise(r => setTimeout(r, 50))
  }

  console.log(`\n-- Final breaker state: ${breaker?.currentState} --`)

  // Alternative: use startWorker() for continuous processing (production pattern)
  // In production, replace the manual loops above with:
  //
  // q.startWorker('default', { concurrency: 5, pollInterval: 50 })
  //
  // The circuit breaker plugin integrates with startWorker() seamlessly.
  // When the circuit is OPEN, ctx.breaker() calls ctx.requeue() which puts
  // the job back in the queue. The worker picks it up again after a delay.

  await q.stop()
  console.log('\nDone!')
}

main().catch(console.error)
