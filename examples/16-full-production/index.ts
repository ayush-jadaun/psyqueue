/**
 * Example 16: Full Production Setup — Kitchen Sink
 *
 * Demonstrates every major plugin composing together:
 *   - SQLite backend (swap to PostgreSQL/Redis with one line in production)
 *   - Scheduler: delayed jobs and cron scheduling
 *   - Crash recovery: WAL-based restart protection
 *   - Multi-tenancy: tier-based rate limiting and fair scheduling
 *   - Workflows + Saga: DAG pipelines with automatic compensation
 *   - Circuit breaker: external API protection
 *   - Schema versioning: forward-compatible payload migration
 *   - Exactly-once: idempotency key deduplication
 *   - Backpressure: dynamic concurrency control
 *   - Audit log: hash-chained tamper-evident event trail
 *   - Metrics: Prometheus counters, histograms, and gauges
 *   - Deadline priority: urgency-based priority boosting
 *   - Job fusion: auto-batching of notifications
 *   - Custom middleware: per-request tracing and SLA enforcement
 *
 * Run: npx tsx examples/16-full-production/index.ts
 */

import { PsyQueue, RateLimitError } from 'psyqueue'
import { sqlite } from '@psyqueue/backend-sqlite'
import { scheduler } from '@psyqueue/plugin-scheduler'
import { crashRecovery } from '@psyqueue/plugin-crash-recovery'
import { tenancy } from '@psyqueue/plugin-tenancy'
import { workflows, workflow } from '@psyqueue/plugin-workflows'
import { saga } from '@psyqueue/plugin-saga'
import { circuitBreaker } from '@psyqueue/plugin-circuit-breaker'
import { schemaVersioning } from '@psyqueue/plugin-schema-versioning'
import { exactlyOnce } from '@psyqueue/plugin-exactly-once'
import { backpressure } from '@psyqueue/plugin-backpressure'
import { auditLog } from '@psyqueue/plugin-audit-log'
import { metrics } from '@psyqueue/plugin-metrics'
import { deadlinePriority } from '@psyqueue/plugin-deadline-priority'
import { jobFusion } from '@psyqueue/plugin-job-fusion'
import { z } from 'zod'
import type { Job } from 'psyqueue'

// ── Tenant tier registry ───────────────────────────────────────────────────

const tenantTiers: Record<string, string> = {
  'acme-corp': 'enterprise',
  'startup-xyz': 'pro',
  'hobby-dev': 'free',
}

// ── Simulated external payment service ────────────────────────────────────

let paymentCallCount = 0
async function callPaymentService(amount: number): Promise<{ txId: string }> {
  paymentCallCount++
  if (paymentCallCount <= 2) throw new Error(`Payment gateway timeout #${paymentCallCount}`)
  return { txId: `TXN-PROD-${paymentCallCount}` }
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== Full Production Setup ===\n')

  const q = new PsyQueue()

  // ── 1. Backend ─────────────────────────────────────────────────────────────
  // In production swap ':memory:' for a file path or use PostgreSQL/Redis.
  q.use(sqlite({ path: ':memory:' }))

  // ── 2. Scheduler ──────────────────────────────────────────────────────────
  q.use(scheduler({ pollInterval: 500, cronLockTtl: 60_000 }))

  // ── 3. Crash recovery ─────────────────────────────────────────────────────
  // Writes a WAL file before/after each job. On startup, re-queues any jobs
  // that were 'active' when the process crashed.
  q.use(crashRecovery({
    walPath: '/tmp/psyqueue-prod.wal',
    autoRecover: true,
    onRecoverActiveJob: 'requeue',
    shutdownTimeout: 15_000,
  }))

  // ── 4. Multi-tenancy ──────────────────────────────────────────────────────
  q.use(tenancy({
    tiers: {
      free: {
        weight: 1,
        rateLimit: { max: 10, window: 60_000 },
        maxConcurrency: 2,
        maxJobsPerMinute: 10,
        features: ['basic'],
      },
      pro: {
        weight: 5,
        rateLimit: { max: 100, window: 60_000 },
        maxConcurrency: 20,
        maxJobsPerMinute: 100,
        features: ['basic', 'priority', 'webhooks'],
      },
      enterprise: {
        weight: 20,
        rateLimit: { max: 1000, window: 60_000 },
        maxConcurrency: 100,
        maxJobsPerMinute: 1000,
        features: ['basic', 'priority', 'webhooks', 'dedicated', 'sla'],
      },
    },
    resolveTier: async (tenantId) => tenantTiers[tenantId] ?? 'free',
    scheduling: 'weighted-round-robin',
  }))

  // ── 5. Workflows + Saga ───────────────────────────────────────────────────
  const wfPlugin = workflows()
  q.use(wfPlugin)
  q.use(saga())

  // ── 6. Circuit breaker ────────────────────────────────────────────────────
  const cbPlugin = circuitBreaker({
    breakers: {
      'payment-gateway': {
        failureThreshold: 2,
        failureWindow: 10_000,
        resetTimeout: 1_500,
        halfOpenRequests: 1,
        onOpen: 'requeue',
      },
    },
  })
  q.use(cbPlugin)

  // ── 7. Schema versioning ───────────────────────────────────────────────────
  q.use(schemaVersioning())

  // ── 8. Exactly-once ───────────────────────────────────────────────────────
  q.use(exactlyOnce({ window: '1h', onDuplicate: 'ignore' }))

  // ── 9. Backpressure ───────────────────────────────────────────────────────
  const bpPlugin = backpressure({
    signals: {
      queueDepth: { pressure: 50, critical: 100 },
      errorRate: { pressure: 0.3, critical: 0.6 },
    },
    onPressure: async ({ setConcurrency }) => {
      await setConcurrency(5)
      console.log('  [backpressure] PRESSURE: concurrency throttled to 5')
    },
    onCritical: async ({ setConcurrency }) => {
      await setConcurrency(1)
      console.log('  [backpressure] CRITICAL: concurrency throttled to 1')
    },
    recovery: { cooldown: 2_000, stepUp: 5 },
  }) as ReturnType<typeof backpressure> & {
    updateMetrics(m: { queueDepth?: number; errorRate?: number }): Promise<void>
    getState(): string
  }
  q.use(bpPlugin)

  // ── 10. Audit log ─────────────────────────────────────────────────────────
  const auditPlugin = auditLog({
    store: 'memory',
    events: 'all',
    hashChain: true,
    includePayload: false,  // Avoid logging sensitive data in production
  })
  q.use(auditPlugin)

  // ── 11. Metrics ────────────────────────────────────────────────────────────
  const metricsPlugin = metrics({ prefix: 'myapp_queue' })
  q.use(metricsPlugin)

  // ── 12. Deadline priority ─────────────────────────────────────────────────
  q.use(deadlinePriority({
    urgencyCurve: 'exponential',
    boostThreshold: 0.4,
    maxBoost: 95,
    interval: 500,
    onDeadlineMiss: 'move-to-dead-letter',
  }))

  // ── 13. Job fusion ────────────────────────────────────────────────────────
  q.use(jobFusion({
    rules: [
      {
        match: 'send-notification',
        groupBy: (job: Job) => job.tenantId ?? 'default',
        window: 300,
        maxBatch: 25,
        fuse: (jobs: Job[]) => ({
          notifications: jobs.map(j => j.payload),
          count: jobs.length,
        }),
      },
    ],
  }))

  // ── Custom middleware: request tracing ────────────────────────────────────
  q.pipeline('process', async (ctx, next) => {
    const traceId = ctx.job.traceId ?? `trace-${Date.now()}`
    ctx.job.traceId = traceId
    const startMs = Date.now()
    await next()
    const durationMs = Date.now() - startMs
    if (durationMs > 500) {
      ctx.log.warn('Slow job detected', { traceId, durationMs, jobName: ctx.job.name })
    }
  }, { phase: 'observe' })

  // ── Workflow definition ────────────────────────────────────────────────────

  const orderSchema = z.object({
    orderId: z.string(),
    total: z.number().positive(),
    tenantId: z.string(),
  })

  const orderWorkflow = workflow('process-order-full')
    .step('validate-order-full', async (ctx) => {
      const payload = ctx.job.payload as z.infer<typeof orderSchema>
      console.log(`  [validate-order] orderId=${payload.orderId}  total=$${payload.total}`)
      return orderSchema.parse(payload)
    })
    .step('charge-payment-full', async (ctx) => {
      const order = ctx.results?.['validate-order-full'] as { orderId: string; total: number }
      console.log(`  [charge-payment] Charging $${order.total}...`)
      const result = await ctx.breaker('payment-gateway', () => callPaymentService(order.total))
      if (!result) return { skipped: true, reason: 'circuit-open' }
      return { charged: true, txId: (result as { txId: string }).txId }
    }, {
      after: 'validate-order-full',
      compensate: async (ctx) => {
        const charge = ctx.results?.['charge-payment-full'] as { txId?: string } | undefined
        if (charge?.txId) {
          console.log(`  [COMPENSATE charge] Refunding txId=${charge.txId}`)
        }
        return { refunded: true }
      },
    })
    .step('fulfill-order-full', async (ctx) => {
      const charge = ctx.results?.['charge-payment-full'] as { txId: string }
      console.log(`  [fulfill-order] Fulfilling for txId=${charge.txId}`)
      return { fulfilled: true, shippingLabel: `SHIP-${Date.now()}` }
    }, { after: 'charge-payment-full' })
    .build()

  wfPlugin.engine.registerDefinition(orderWorkflow)
  for (const step of orderWorkflow.steps) {
    q.handle(step.name, step.handler)
  }

  // ── Standalone job handlers ────────────────────────────────────────────────

  q.handle(
    'send-notification',
    schemaVersioning.versioned({
      current: 1,
      versions: {
        1: {
          schema: z.object({ userId: z.string(), message: z.string() }),
          process: async (ctx) => {
            const { notifications, count } = ctx.job.payload as {
              notifications?: Array<{ userId: string; message: string }>
              count?: number
              userId?: string
              message?: string
            }
            const isBatch = count !== undefined
            if (isBatch) {
              console.log(`  [send-notification] BATCH count=${count}`)
            } else {
              console.log(`  [send-notification] SINGLE userId=${ctx.job.payload ? (ctx.job.payload as any).userId : '?'}`)
            }
            return { delivered: count ?? 1 }
          },
        },
      },
    }),
  )

  q.handle('run-analytics', async (ctx) => {
    const { query } = ctx.job.payload as { query: string }
    console.log(`  [run-analytics] Running: ${query}`)
    await new Promise(r => setTimeout(r, 15))
    return { rows: Math.floor(Math.random() * 1000) }
  })

  // ── Events ─────────────────────────────────────────────────────────────────

  q.events.on('kernel:started', () => console.log('  [event] kernel:started'))
  q.events.on('workflow:completed', (e) => {
    const d = e.data as { workflowId: string; definitionName: string }
    console.log(`  [event] workflow:completed  id=${d.workflowId.slice(0, 8)}`)
  })
  q.events.on('workflow:failed', (e) => {
    const d = e.data as { failedStep: string; error: string }
    console.log(`  [event] workflow:failed  step=${d.failedStep}`)
  })
  q.events.on('circuit:open', (e) => {
    const d = e.data as { name: string }
    console.log(`  [event] circuit:open  breaker=${d.name}`)
  })
  q.events.on('circuit:close', (e) => {
    const d = e.data as { name: string }
    console.log(`  [event] circuit:close  breaker=${d.name}`)
  })
  q.events.on('job:fused', (e) => {
    const d = e.data as { groupKey: string; count: number }
    console.log(`  [event] job:fused  tenant=${d.groupKey}  count=${d.count}`)
  })
  q.events.on('tenancy:rate-limited', (e) => {
    const d = e.data as { tenantId: string }
    console.log(`  [event] tenancy:rate-limited  tenant=${d.tenantId}`)
  })

  // ── Start ─────────────────────────────────────────────────────────────────

  await q.start()
  console.log('All plugins initialised.\n')

  // ─────────────────────────────────────────────────────────────────────────
  // DEMO SECTION 1: Multi-tenant jobs with rate limiting
  // ─────────────────────────────────────────────────────────────────────────

  console.log('=== 1. Multi-tenant analytics jobs ===')

  await q.enqueue('run-analytics', { query: 'SELECT * FROM orders WHERE ...' }, {
    tenantId: 'acme-corp',
    priority: 10,
    deadline: new Date(Date.now() + 30_000),
  })
  await q.enqueue('run-analytics', { query: 'SELECT COUNT(*) FROM events' }, {
    tenantId: 'startup-xyz',
    priority: 5,
  })
  await q.enqueue('run-analytics', { query: 'SELECT * FROM logs LIMIT 100' }, {
    tenantId: 'hobby-dev',
    priority: 1,
  })

  // Try to exceed hobby-dev rate limit to show the error
  try {
    for (let i = 0; i < 15; i++) {
      await q.enqueue('run-analytics', { query: `query-${i}` }, { tenantId: 'hobby-dev' })
    }
  } catch (err) {
    if (err instanceof RateLimitError) {
      console.log(`  Rate limit hit for hobby-dev: retryAfter=${err.retryAfter}ms`)
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // DEMO SECTION 2: Workflow with saga compensation
  // ─────────────────────────────────────────────────────────────────────────

  console.log('\n=== 2. Order workflow (payment circuit breaker will trip, then recover) ===')
  const wfId = await q.enqueue('process-order-full', {
    orderId: 'PROD-ORD-001',
    total: 299.99,
    tenantId: 'acme-corp',
  }, { tenantId: 'acme-corp' })
  console.log(`  Started workflow: ${wfId.slice(0, 8)}`)

  // ─────────────────────────────────────────────────────────────────────────
  // DEMO SECTION 3: Notifications fused into batches
  // ─────────────────────────────────────────────────────────────────────────

  console.log('\n=== 3. Notification batching (50 jobs → 2 batches) ===')
  for (let i = 0; i < 25; i++) {
    await q.enqueue('send-notification', { userId: `user-acme-${i}`, message: `Update ${i}` }, {
      tenantId: 'acme-corp',
    })
  }
  for (let i = 0; i < 25; i++) {
    await q.enqueue('send-notification', { userId: `user-startup-${i}`, message: `Alert ${i}` }, {
      tenantId: 'startup-xyz',
    })
  }

  // ─────────────────────────────────────────────────────────────────────────
  // DEMO SECTION 4: Idempotent job (exactly-once)
  // ─────────────────────────────────────────────────────────────────────────

  console.log('\n=== 4. Exactly-once analytics job ===')
  const key = 'analytics:daily:2026-03-19'
  const a1 = await q.enqueue('run-analytics', { query: 'DAILY REPORT' }, { idempotencyKey: key })
  const a2 = await q.enqueue('run-analytics', { query: 'DAILY REPORT' }, { idempotencyKey: key })
  console.log(`  First enqueue:  ${a1.slice(0, 8)}`)
  console.log(`  Second enqueue: ${a2.slice(0, 8)}`)
  console.log(`  Deduplicated: ${a1 === a2}`)

  // ─────────────────────────────────────────────────────────────────────────
  // DEMO SECTION 5: Process everything
  // ─────────────────────────────────────────────────────────────────────────

  console.log('\n=== 5. Processing all jobs (using startWorker) ===')

  // Wait for fusions to batch
  await new Promise(r => setTimeout(r, 400))

  // Use startWorker() for continuous processing with concurrency control.
  // This is the production-recommended approach -- it manages the dequeue loop
  // automatically, uses blocking reads for Redis backends, and applies
  // semaphore-controlled concurrency.
  let completedCount = 0
  const expectedJobs = 20 // approximate -- some jobs are fused, some rate-limited

  q.events.on('job:completed', () => { completedCount++ })
  q.events.on('job:dead', () => { completedCount++ })

  q.startWorker('default', {
    concurrency: 10,
    pollInterval: 50,
  })

  // Wait for jobs to be processed (with timeout for safety)
  const deadline = Date.now() + 15_000
  while (completedCount < expectedJobs && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 100))
    // Allow circuit breaker recovery time
    if (completedCount >= 3 && completedCount <= 6) {
      await new Promise(r => setTimeout(r, 1_600))
    }
  }

  // Stop workers before inspecting results
  await q.stopWorkers()

  // ─────────────────────────────────────────────────────────────────────────
  // DEMO SECTION 6: Inspect results
  // ─────────────────────────────────────────────────────────────────────────

  console.log('\n=== 6. Production health summary ===')

  // Audit log summary
  const auditEntries = auditPlugin.audit.query()
  console.log(`  Audit entries: ${auditEntries.length}`)
  const chainValid = auditPlugin.audit.verify()
  console.log(`  Chain integrity: ${chainValid ? 'VALID' : 'COMPROMISED'}`)

  // Metrics
  const registry = metricsPlugin.getRegistry()
  const metricsText = await registry.metrics()
  const enqueuedLine = metricsText.split('\n').find(l => l.startsWith('myapp_queue_jobs_enqueued_total{'))
  const completedLine = metricsText.split('\n').find(l => l.startsWith('myapp_queue_jobs_completed_total{'))
  if (enqueuedLine) console.log(`  Metrics - ${enqueuedLine}`)
  if (completedLine) console.log(`  Metrics - ${completedLine}`)

  // Dead letter check
  const dead = await q.deadLetter.list()
  console.log(`  Dead letter jobs: ${dead.total}`)

  // Circuit breaker state
  const breaker = cbPlugin.getBreaker('payment-gateway')
  console.log(`  Circuit breaker state: ${breaker?.currentState}`)

  // Workflow states
  const instances = wfPlugin.engine.store.list()
  for (const inst of instances) {
    console.log(`  Workflow ${inst.id.slice(0, 8)}: ${inst.status}`)
  }

  await q.stop()
  console.log('\n=== Done — all plugins shutdown cleanly ===')
}

main().catch(console.error)
