/**
 * Example 10: Backpressure
 *
 * Demonstrates:
 *   - Configuring backpressure signals (queue depth, error rate)
 *   - HEALTHY → PRESSURE → CRITICAL state transitions
 *   - Actions on pressure: reducing concurrency
 *   - Actions on critical: stopping new enqueues (via events)
 *   - Recovery: stepping concurrency back up after HEALTHY state returns
 *   - backpressure:pressure, backpressure:critical, backpressure:healthy events
 *
 * Run: npx tsx examples/10-backpressure/index.ts
 */

import { PsyQueue } from 'psyqueue'
import { sqlite } from '@psyqueue/backend-sqlite'
import { backpressure } from '@psyqueue/plugin-backpressure'

async function main() {
  console.log('=== Backpressure ===\n')

  const q = new PsyQueue()
  q.use(sqlite({ path: ':memory:' }))

  // Configure backpressure with two signal types:
  //  - queueDepth: triggers based on how many jobs are waiting
  //  - errorRate: triggers based on what fraction of jobs are failing
  const bpPlugin = backpressure({
    signals: {
      queueDepth: {
        pressure: 10,   // PRESSURE state when queue depth >= 10
        critical: 20,   // CRITICAL state when queue depth >= 20
      },
      errorRate: {
        pressure: 0.2,  // PRESSURE when 20% of jobs are failing
        critical: 0.5,  // CRITICAL when 50% of jobs are failing
      },
    },
    actions: {
      pressure: ['reduce-concurrency'],   // Standard action: reduce worker concurrency
      critical: ['pause-enqueue'],        // Standard action: pause new enqueues
    },
    onPressure: async ({ setConcurrency }) => {
      // Called when transitioning to PRESSURE state
      await setConcurrency(3)
      console.log('  [backpressure action] PRESSURE: reduced concurrency to 3')
    },
    onCritical: async ({ setConcurrency }) => {
      // Called when transitioning to CRITICAL state
      await setConcurrency(1)
      console.log('  [backpressure action] CRITICAL: reduced concurrency to 1 (near-pause)')
    },
    recovery: {
      cooldown: 500,   // Wait 500ms before stepping concurrency back up
      stepUp: 5,       // Increase concurrency by 5 per recovery cycle
    },
  }) as ReturnType<typeof backpressure> & {
    updateMetrics(m: { queueDepth?: number; errorRate?: number }): Promise<void>
    getState(): string
    getConcurrency(): number
  }

  q.use(bpPlugin)

  // ── Handler ───────────────────────────────────────────────────────────────

  q.handle('worker-task', async (ctx) => {
    const { taskId } = ctx.job.payload as { taskId: number }
    await new Promise(r => setTimeout(r, 5))
    return { done: true, taskId }
  })

  // ── Events ────────────────────────────────────────────────────────────────

  q.events.on('backpressure:pressure', (e) => {
    const d = e.data as { state: string; jobId?: string }
    console.log(`  [event] backpressure:pressure  state=${d.state}${d.jobId ? '  (enqueue was rate-signalled)' : ''}`)
  })

  q.events.on('backpressure:critical', (e) => {
    const d = e.data as { state: string; jobId?: string }
    console.log(`  [event] backpressure:critical  state=${d.state}${d.jobId ? '  (enqueue was critically signalled)' : ''}`)
  })

  q.events.on('backpressure:healthy', (e) => {
    const d = e.data as { state: string }
    console.log(`  [event] backpressure:healthy   state=${d.state}`)
  })

  q.events.on('job:enqueued', (e) => {
    const d = e.data as { name: string }
    // Suppress verbose output during bulk enqueue
    void d
  })

  await q.start()
  console.log('Queue started.\n')

  // ── Initial state ─────────────────────────────────────────────────────────

  console.log(`Initial state: ${bpPlugin.getState()}  concurrency: ${bpPlugin.getConcurrency()}`)

  // ── Simulate queue building up → PRESSURE ────────────────────────────────

  console.log('\n-- Simulating queue depth of 12 (threshold: pressure=10) --')
  await bpPlugin.updateMetrics({ queueDepth: 12, errorRate: 0.05 })
  console.log(`  State after depth=12: ${bpPlugin.getState()}  concurrency: ${bpPlugin.getConcurrency()}`)

  // Enqueue some jobs — each enqueue will emit a pressure event because we're in PRESSURE state.
  for (let i = 1; i <= 5; i++) {
    await q.enqueue('worker-task', { taskId: i })
  }

  // ── Simulate worsening → CRITICAL ────────────────────────────────────────

  console.log('\n-- Simulating queue depth of 25 (threshold: critical=20) --')
  await bpPlugin.updateMetrics({ queueDepth: 25, errorRate: 0.6 })
  console.log(`  State after depth=25, errorRate=0.6: ${bpPlugin.getState()}  concurrency: ${bpPlugin.getConcurrency()}`)

  // Enqueue more jobs — critical backpressure events are emitted
  for (let i = 6; i <= 10; i++) {
    await q.enqueue('worker-task', { taskId: i })
  }

  // ── Process some jobs to drain the queue ─────────────────────────────────

  console.log('\n-- Processing jobs to drain the queue --')
  for (let i = 0; i < 10; i++) {
    await q.processNext('default')
  }

  // ── Simulate recovery → HEALTHY ────────────────────────────────────────

  console.log('\n-- Queue drained: simulating healthy metrics --')
  await bpPlugin.updateMetrics({ queueDepth: 2, errorRate: 0.01 })
  console.log(`  State after depth=2, errorRate=0.01: ${bpPlugin.getState()}  concurrency: ${bpPlugin.getConcurrency()}`)

  // ── Demonstrate that actions are pluggable (custom callback) ──────────────

  console.log('\n-- Demonstrating high-error-rate signal only --')
  await bpPlugin.updateMetrics({ queueDepth: 3, errorRate: 0.55 })
  console.log(`  State with only errorRate=0.55 (critical): ${bpPlugin.getState()}`)

  await bpPlugin.updateMetrics({ queueDepth: 0, errorRate: 0.0 })
  console.log(`  State after recovery: ${bpPlugin.getState()}`)

  // Process remaining jobs
  let processed = true
  while (processed) {
    processed = await q.processNext('default')
  }

  // Alternative: use startWorker() for continuous processing (production pattern)
  // In production, replace the manual loops above with:
  //
  // q.startWorker('default', { concurrency: 10, pollInterval: 50 })
  //
  // The backpressure plugin dynamically adjusts concurrency via its
  // onPressure/onCritical callbacks. With startWorker(), the concurrency
  // setting controls how many jobs the worker pool processes in parallel.

  await q.stop()
  console.log('\nDone!')
}

main().catch(console.error)
