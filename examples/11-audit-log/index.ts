/**
 * Example 11: Audit Log with Hash-Chain Verification
 *
 * Demonstrates:
 *   - Recording all job state transitions in a tamper-evident audit log
 *   - Hash-chained entries: each entry includes the SHA-256 hash of the previous entry
 *   - Querying the audit log by event type, job ID, or time range
 *   - Verifying chain integrity with audit.verify()
 *   - Detecting tampering (simulated by mutating an entry)
 *   - Including job payloads in audit records (includePayload: true)
 *
 * Run: npx tsx examples/11-audit-log/index.ts
 */

import { PsyQueue } from '@psyqueue/core'
import { sqlite } from '@psyqueue/backend-sqlite'
import { auditLog } from '@psyqueue/plugin-audit-log'

async function main() {
  console.log('=== Audit Log with Hash-Chain Verification ===\n')

  const q = new PsyQueue()
  q.use(sqlite({ path: ':memory:' }))

  // Create the audit log plugin.
  // store: 'memory' keeps all entries in RAM for this demo.
  // hashChain: true (default) links each entry to the previous via SHA-256.
  // includePayload: true records job payload in every audit entry.
  const auditPlugin = auditLog({
    store: 'memory',
    events: 'all',         // Record all lifecycle events
    includePayload: true,  // Include job payload in each entry
    hashChain: true,       // Enable hash chaining for tamper detection
    retention: '90d',      // Metadata annotation (not enforced in memory mode)
  })
  q.use(auditPlugin)

  // ── Handlers ──────────────────────────────────────────────────────────────

  q.handle('process-payment', async (ctx) => {
    const { orderId, amount } = ctx.job.payload as { orderId: string; amount: number }
    console.log(`  [process-payment] Processing $${amount} for order ${orderId}`)
    return { processed: true, orderId }
  })

  q.handle('send-notification', async (ctx) => {
    const { userId, message } = ctx.job.payload as { userId: string; message: string }
    console.log(`  [send-notification] Notifying user ${userId}: "${message}"`)
    return { notified: true }
  })

  q.handle('always-fails-audit', async (_ctx) => {
    throw new Error('Deliberate failure for audit log demo')
  })

  await q.start()
  console.log('Queue started.\n')

  // ── Enqueue and process jobs ───────────────────────────────────────────────

  console.log('-- Enqueuing and processing jobs --')
  const paymentId = await q.enqueue(
    'process-payment',
    { orderId: 'ORD-001', amount: 99.99 },
    { queue: 'payments', tenantId: 'tenant-acme' },
  )
  const notifId = await q.enqueue(
    'send-notification',
    { userId: 'USR-42', message: 'Your order has shipped!' },
  )
  const failId = await q.enqueue(
    'always-fails-audit',
    { reason: 'demo' },
    { maxRetries: 0 },
  )

  await q.processNext('payments')
  await q.processNext('default')
  await q.processNext('default')  // always-fails-audit

  // Alternative: use startWorker() for continuous processing (production pattern)
  // In production, replace the manual processNext calls with:
  //
  // q.startWorker('payments', { concurrency: 5, pollInterval: 50 })
  // q.startWorker('default', { concurrency: 5, pollInterval: 50 })
  //
  // The audit log plugin records events for every lifecycle transition
  // regardless of whether jobs are processed via processNext() or startWorker().

  // ── Query the audit log ────────────────────────────────────────────────────

  console.log('\n-- Full audit log (all events) --')
  const allEntries = auditPlugin.audit.query()
  console.log(`  Total audit entries: ${allEntries.length}`)
  for (const entry of allEntries) {
    const hashPreview = entry.hash ? entry.hash.slice(0, 12) + '...' : '(no hash)'
    console.log(`  [${entry.event.padEnd(20)}] jobId=${entry.jobId.slice(0, 8)}  hash=${hashPreview}`)
  }

  // ── Query by event type ───────────────────────────────────────────────────

  console.log('\n-- Filter: completed events only --')
  const completedEntries = auditPlugin.audit.query({ event: 'job:completed' })
  for (const entry of completedEntries) {
    console.log(`  jobId=${entry.jobId.slice(0, 8)}  name=${entry.jobName}  queue=${entry.queue}`)
  }

  // ── Query by job ID ───────────────────────────────────────────────────────

  console.log(`\n-- Filter: all events for payment job ${paymentId.slice(0, 8)} --`)
  const paymentEntries = auditPlugin.audit.query({ jobId: paymentId })
  for (const entry of paymentEntries) {
    console.log(`  event=${entry.event}  timestamp=${entry.timestamp}`)
  }

  // ── Verify chain integrity ─────────────────────────────────────────────────

  console.log('\n-- Verifying hash chain integrity --')
  const isValid = auditPlugin.audit.verify()
  console.log(`  Chain is valid: ${isValid}`)

  // ── Simulate tampering ────────────────────────────────────────────────────

  console.log('\n-- Simulating tampering: modifying an audit entry --')
  const entries = auditPlugin.audit.query()
  if (entries.length > 0) {
    // Mutate the event field of the first entry — this should break the chain.
    const firstEntry = entries[0]!
    const originalEvent = firstEntry.event
    ;(firstEntry as { event: string }).event = 'TAMPERED'
    console.log(`  Modified entry[0].event from "${originalEvent}" to "TAMPERED"`)

    const isValidAfterTamper = auditPlugin.audit.verify()
    console.log(`  Chain is valid after tampering: ${isValidAfterTamper}`)

    // Restore to show verification passes again
    ;(firstEntry as { event: string }).event = originalEvent
    const isValidAfterRestore = auditPlugin.audit.verify()
    console.log(`  Chain is valid after restoring: ${isValidAfterRestore}`)
  }

  // ── Verify a slice of the chain ───────────────────────────────────────────

  console.log('\n-- Verifying a slice of the chain (entries 2-5) --')
  const sliceValid = auditPlugin.audit.verify(2, 5)
  console.log(`  Slice [2, 5] is valid: ${sliceValid}`)

  // ── Payload inspection ────────────────────────────────────────────────────

  console.log('\n-- Audit entries with payload (includePayload: true) --')
  const withPayload = auditPlugin.audit.query({ event: 'enqueue' })
  for (const entry of withPayload) {
    if (entry.payload) {
      console.log(`  jobName=${entry.jobName}  payload=${JSON.stringify(entry.payload)}`)
    }
  }

  await q.stop()
  console.log('\nDone!')
}

main().catch(console.error)
