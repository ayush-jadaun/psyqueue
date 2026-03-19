/**
 * Dashboard Demo
 *
 * Run: cd examples/dashboard-demo && npx tsx index.ts
 * Then open: http://localhost:4000
 */

import { PsyQueue } from '@psyqueue/core' // use relative '../../packages/core/src/index.js' for monorepo dev
import { sqlite } from '@psyqueue/backend-sqlite'
import { createDashboardServer } from '@psyqueue/dashboard'

async function main() {
  const q = new PsyQueue()
  q.use(sqlite({ path: ':memory:' }))
  // Dashboard started separately after q.start()

  // Register some handlers
  q.handle('email.send', async (ctx) => {
    await new Promise(r => setTimeout(r, 50))
    return { sent: true, to: (ctx.job.payload as any).to }
  })

  q.handle('payment.charge', async (ctx) => {
    const amount = (ctx.job.payload as any).amount
    if (amount > 500) throw new Error('Amount too large')
    return { charged: true, amount }
  })

  q.handle('report.generate', async () => {
    await new Promise(r => setTimeout(r, 200))
    return { pages: 42 }
  })

  await q.start()

  // Start dashboard server
  const dash = createDashboardServer({ port: 4000, getBackend: () => (q as any).backend })
  await dash.start()
  console.log('\n  Dashboard running at http://localhost:4000\n')

  // Seed some jobs to make the dashboard interesting
  console.log('  Seeding jobs...')

  // Completed emails
  for (let i = 0; i < 10; i++) {
    await q.enqueue('email.send', { to: `user${i}@example.com`, subject: `Welcome #${i}` })
    await q.processNext('email.send')
  }

  // Some pending emails
  for (let i = 10; i < 15; i++) {
    await q.enqueue('email.send', { to: `user${i}@example.com`, subject: `Newsletter #${i}` })
  }

  // Successful payments
  for (let i = 0; i < 5; i++) {
    await q.enqueue('payment.charge', { amount: (i + 1) * 50, currency: 'usd' })
    await q.processNext('payment.charge')
  }

  // Failed payment (amount > 500) → dead letter
  await q.enqueue('payment.charge', { amount: 999, currency: 'usd' }, { maxRetries: 0 })
  await q.processNext('payment.charge')

  // Pending reports
  for (let i = 0; i < 3; i++) {
    await q.enqueue('report.generate', { type: 'monthly', month: `2026-0${i + 1}` })
  }

  console.log('  Seeded: 10 completed emails, 5 pending emails, 5 completed payments,')
  console.log('          1 dead-lettered payment, 3 pending reports\n')
  console.log('  API endpoints:')
  console.log('    GET  http://localhost:4000/api/health')
  console.log('    GET  http://localhost:4000/api/overview')
  console.log('    GET  http://localhost:4000/api/queues')
  console.log('    GET  http://localhost:4000/api/jobs?status=pending')
  console.log('    GET  http://localhost:4000/api/jobs?status=completed')
  console.log('    GET  http://localhost:4000/api/jobs?status=dead')
  console.log('    POST http://localhost:4000/api/jobs/:id/retry')
  console.log('\n  Dashboard UI: http://localhost:4000/\n')
  console.log('  Press Ctrl+C to stop.\n')

  // Keep process alive — dashboard server is listening
  await new Promise(() => {})
}

main().catch(console.error)
