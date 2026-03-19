/**
 * Example 15: Chaos Testing
 *
 * Demonstrates:
 *   - Enabling chaos mode with multiple fault injection scenarios
 *   - slowProcess: artificially delays job processing (latency injection)
 *   - workerCrash: randomly throws during processing (fault injection)
 *   - duplicateDelivery: delivers the same job twice (at-least-once semantics)
 *   - Verifying that retries, dead letter, and recovery mechanisms work correctly
 *     under fault conditions
 *   - chaos:enabled event
 *
 * Run: npx tsx examples/15-chaos-testing/index.ts
 */

import { PsyQueue } from 'psyqueue'
import { sqlite } from '@psyqueue/backend-sqlite'
import { chaosMode } from '@psyqueue/plugin-chaos'
import { exactlyOnce } from '@psyqueue/plugin-exactly-once'

async function main() {
  console.log('=== Chaos Testing ===\n')

  // ── Queue A: slowProcess chaos ────────────────────────────────────────────

  console.log('-- Scenario 1: Slow process chaos (latency injection) --')
  {
    const q = new PsyQueue()
    q.use(sqlite({ path: ':memory:' }))
    q.use(chaosMode({
      enabled: true,
      scenarios: [
        {
          type: 'slowProcess',
          config: {
            probability: 1.0,    // 100% of jobs are slowed
            delayMs: 200,        // Add 200ms to every job
          },
        },
      ],
    }))

    q.handle('quick-task', async (ctx) => {
      const { id } = ctx.job.payload as { id: number }
      return { id, done: true }
    })

    q.events.on('chaos:enabled', (e) => {
      const d = e.data as { scenarios: string[] }
      console.log(`  [event] chaos:enabled  scenarios=${d.scenarios.join(', ')}`)
    })

    q.events.on('job:completed', (e) => {
      const d = e.data as { name: string }
      console.log(`  [event] job:completed  name=${d.name}`)
    })

    await q.start()

    const start = Date.now()
    await q.enqueue('quick-task', { id: 1 })
    await q.enqueue('quick-task', { id: 2 })

    await q.processNext('default')
    await q.processNext('default')

    const elapsed = Date.now() - start
    console.log(`  Time with 200ms chaos delay per job: ${elapsed}ms (expected >= 400ms)`)
    console.log(`  Chaos correctly added latency: ${elapsed >= 380}`)
    await q.stop()
  }

  // ── Queue B: workerCrash chaos ────────────────────────────────────────────

  console.log('\n-- Scenario 2: Worker crash chaos (fault injection) --')
  {
    const q = new PsyQueue()
    q.use(sqlite({ path: ':memory:' }))
    q.use(chaosMode({
      enabled: true,
      scenarios: [
        {
          type: 'workerCrash',
          config: {
            probability: 0.5,   // 50% chance of crash
            errorMessage: 'ChaosMonkey: random worker crash',
          },
        },
      ],
    }))

    let successCount = 0
    let failCount = 0

    q.handle('resilient-task', async (ctx) => {
      const { id } = ctx.job.payload as { id: number }
      successCount++
      return { id, done: true }
    })

    q.events.on('job:completed', () => { /* count via handler */ })
    q.events.on('job:failed', () => { failCount++ })
    q.events.on('job:retry', (e) => {
      const d = e.data as { name: string; attempt: number }
      console.log(`  [event] job:retry  attempt=${d.attempt}`)
    })

    await q.start()

    // Enqueue 10 jobs with retries so they can survive crashes
    for (let i = 1; i <= 10; i++) {
      await q.enqueue('resilient-task', { id: i }, { maxRetries: 3, backoff: 'fixed', backoffBase: 10 })
    }

    // Process each job multiple times to allow retries
    for (let round = 0; round < 50; round++) {
      const processed = await q.processNext('default')
      if (!processed) break
    }

    console.log(`  Jobs succeeded: ${successCount}`)
    console.log(`  Job failures (retries): ${failCount}`)
    console.log(`  System survived chaos and continued processing.`)
    await q.stop()
  }

  // ── Queue C: duplicateDelivery chaos + exactlyOnce ────────────────────────

  console.log('\n-- Scenario 3: Duplicate delivery chaos + idempotency guard --')
  {
    const q = new PsyQueue()
    q.use(sqlite({ path: ':memory:' }))

    // Chaos delivers the same job twice
    q.use(chaosMode({
      enabled: true,
      scenarios: [
        {
          type: 'duplicateDelivery',
          config: {
            probability: 1.0,  // Always duplicate
          },
        },
      ],
    }))

    // Without exactlyOnce, the handler would run twice.
    // With exactlyOnce, the second delivery is deduplicated.
    q.use(exactlyOnce({ window: '1h', onDuplicate: 'ignore' }))

    let processCount = 0
    q.handle('idempotent-task', async (ctx) => {
      processCount++
      const { id } = ctx.job.payload as { id: number }
      console.log(`  [idempotent-task] Executing task ${id}  (run #${processCount})`)
      return { id, done: true }
    })

    q.events.on('job:completed', (e) => {
      const d = e.data as { name: string }
      console.log(`  [event] job:completed  name=${d.name}`)
    })

    await q.start()

    // Enqueue with idempotency key
    await q.enqueue('idempotent-task', { id: 42 }, { idempotencyKey: 'task:42' })

    // Process twice (chaos causes the same job to appear twice in the queue)
    await q.processNext('default')
    await q.processNext('default')

    console.log(`  Handler executed ${processCount} time(s)`)
    console.log(`  Note: without exactlyOnce the handler would run twice under duplicate delivery chaos.`)

    await q.stop()
  }

  // ── Queue D: combined chaos — all three scenarios ─────────────────────────

  console.log('\n-- Scenario 4: Combined chaos (slow + crash) --')
  {
    const q = new PsyQueue()
    q.use(sqlite({ path: ':memory:' }))
    q.use(chaosMode({
      enabled: true,
      scenarios: [
        {
          type: 'slowProcess',
          config: { probability: 0.3, delayMs: 50 },    // 30% chance of 50ms delay
        },
        {
          type: 'workerCrash',
          config: { probability: 0.2, errorMessage: 'random crash' },  // 20% crash rate
        },
      ],
    }))

    let completedCount = 0
    q.handle('mixed-chaos-task', async (_ctx) => {
      completedCount++
      return { done: true }
    })

    q.events.on('job:retry', (e) => {
      const d = e.data as { attempt: number }
      console.log(`  [event] job:retry attempt=${d.attempt}`)
    })

    await q.start()

    for (let i = 0; i < 5; i++) {
      await q.enqueue('mixed-chaos-task', { i }, { maxRetries: 5, backoff: 'fixed', backoffBase: 10 })
    }

    for (let round = 0; round < 40; round++) {
      const processed = await q.processNext('default')
      if (!processed) break
    }

    console.log(`  Completed: ${completedCount}/5 jobs despite mixed chaos.`)
    await q.stop()
  }

  console.log('\nDone!')
}

main().catch(console.error)
