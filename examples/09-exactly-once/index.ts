/**
 * Example 09: Exactly-Once Processing (Idempotency Keys)
 *
 * Demonstrates:
 *   - Providing an idempotencyKey to prevent duplicate job enqueuing
 *   - 'ignore' mode: second enqueue returns the original jobId silently
 *   - 'reject' mode: second enqueue throws DuplicateJobError
 *   - Dedup window expiry (keys expire after the configured window)
 *   - Use case: webhook retries, double-click protection, at-least-once delivery
 *
 * Run: npx tsx examples/09-exactly-once/index.ts
 */

import { PsyQueue, DuplicateJobError } from 'psyqueue'
import { sqlite } from '@psyqueue/backend-sqlite'
import { exactlyOnce } from '@psyqueue/plugin-exactly-once'

async function main() {
  console.log('=== Exactly-Once Processing ===\n')

  // ── Queue A: 'ignore' mode ────────────────────────────────────────────────
  // Duplicate enqueue returns original jobId; no error is thrown.
  const qIgnore = new PsyQueue()
  qIgnore.use(sqlite({ path: ':memory:' }))
  qIgnore.use(exactlyOnce({
    window: '1h',             // Dedup window: 1 hour
    onDuplicate: 'ignore',    // Silent dedup — return original jobId
    cleanupInterval: '10m',   // Prune expired keys every 10 minutes
  }))

  qIgnore.handle('send-invoice', async (ctx) => {
    const { invoiceId } = ctx.job.payload as { invoiceId: string }
    console.log(`  [send-invoice] Sending invoice ${invoiceId}`)
    return { sent: true, invoiceId }
  })

  await qIgnore.start()
  console.log('Queue (ignore mode) started.\n')

  // ── Scenario 1: Webhook retry (ignore mode) ───────────────────────────────

  console.log('-- Scenario: Webhook delivers twice (idempotency key: ignore) --')

  // First delivery — job is enqueued normally.
  const id1 = await qIgnore.enqueue(
    'send-invoice',
    { invoiceId: 'INV-2024-001' },
    { idempotencyKey: 'invoice:INV-2024-001:send' },
  )
  console.log(`  First  enqueue  → jobId: ${id1.slice(0, 8)}`)

  // Second delivery (webhook retry) — same idempotency key.
  // The plugin intercepts and returns the original jobId without persisting a duplicate.
  const id2 = await qIgnore.enqueue(
    'send-invoice',
    { invoiceId: 'INV-2024-001' },
    { idempotencyKey: 'invoice:INV-2024-001:send' },
  )
  console.log(`  Second enqueue  → jobId: ${id2.slice(0, 8)}  (same — duplicate ignored)`)
  console.log(`  IDs match: ${id1 === id2}`)

  // Third delivery (yet another retry) — still returns the same id.
  const id3 = await qIgnore.enqueue(
    'send-invoice',
    { invoiceId: 'INV-2024-001' },
    { idempotencyKey: 'invoice:INV-2024-001:send' },
  )
  console.log(`  Third  enqueue  → jobId: ${id3.slice(0, 8)}  (same again)`)
  console.log(`  All IDs identical: ${id1 === id2 && id2 === id3}`)

  // Only one job is actually in the queue.
  console.log('\n-- Processing: should process exactly 1 job --')
  const p1 = await qIgnore.processNext('default')
  const p2 = await qIgnore.processNext('default')
  console.log(`  First processNext returned: ${p1}`)
  console.log(`  Second processNext returned (queue empty): ${p2}`)

  await qIgnore.stop()

  // ── Queue B: 'reject' mode ────────────────────────────────────────────────
  // Duplicate enqueue throws DuplicateJobError.
  console.log('\n\n-- Scenario: Strict dedup with reject mode --')
  const qReject = new PsyQueue()
  qReject.use(sqlite({ path: ':memory:' }))
  qReject.use(exactlyOnce({
    window: '30m',
    onDuplicate: 'reject',
  }))

  qReject.handle('transfer-funds', async (ctx) => {
    const { from, to, amount } = ctx.job.payload as { from: string; to: string; amount: number }
    console.log(`  [transfer-funds] $${amount} from ${from} to ${to}`)
    return { transferred: true }
  })

  await qReject.start()

  const transferKey = 'transfer:ACC-001:ACC-002:$500:2026-03-19'

  // First call succeeds.
  const transferId = await qReject.enqueue(
    'transfer-funds',
    { from: 'ACC-001', to: 'ACC-002', amount: 500 },
    { idempotencyKey: transferKey },
  )
  console.log(`  First enqueue  → jobId: ${transferId.slice(0, 8)}`)

  // Second call (e.g., accidental double-submit) throws.
  try {
    await qReject.enqueue(
      'transfer-funds',
      { from: 'ACC-001', to: 'ACC-002', amount: 500 },
      { idempotencyKey: transferKey },
    )
  } catch (err) {
    if (err instanceof DuplicateJobError) {
      console.log(`  DuplicateJobError: key="${err.idempotencyKey}"  originalJobId=${err.originalJobId?.slice(0, 8)}`)
      console.log('  Double-submit blocked — transfer will only run once.')
    } else {
      throw err
    }
  }

  await qReject.processNext('default')

  // ── Scenario: Different idempotency keys create separate jobs ─────────────

  console.log('\n-- Different idempotency keys create independent jobs --')
  const idA = await qReject.enqueue('transfer-funds', { from: 'ACC-001', to: 'ACC-003', amount: 100 }, { idempotencyKey: 'transfer:A' })
  const idB = await qReject.enqueue('transfer-funds', { from: 'ACC-002', to: 'ACC-004', amount: 200 }, { idempotencyKey: 'transfer:B' })
  console.log(`  Job A: ${idA.slice(0, 8)}`)
  console.log(`  Job B: ${idB.slice(0, 8)}`)
  console.log(`  Are they different jobs? ${idA !== idB}`)

  let processed = true
  while (processed) {
    processed = await qReject.processNext('default')
  }

  // Alternative: use startWorker() for continuous processing (production pattern)
  // In production, replace the manual loops above with:
  //
  // qIgnore.startWorker('default', { concurrency: 5, pollInterval: 50 })
  // qReject.startWorker('default', { concurrency: 5, pollInterval: 50 })
  //
  // Idempotency deduplication happens at enqueue time (before the job reaches
  // the queue), so it works identically with both processNext() and startWorker().

  await qReject.stop()
  console.log('\nDone!')
}

main().catch(console.error)
