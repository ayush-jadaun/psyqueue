/**
 * Dashboard with LIVE Events Demo
 *
 * Run: npx tsx examples/dashboard-live/index.ts
 * Then open: http://localhost:4000/events
 *
 * Watch events fire in real-time as jobs are enqueued and processed!
 * Requires Redis on localhost:6381
 */

import { PsyQueue, QueueEvents } from '@psyqueue/core'
import { redis } from '@psyqueue/backend-redis'
import { createDashboardServer } from '@psyqueue/dashboard'

async function main() {
  const q = new PsyQueue()
  q.use(redis({ url: 'redis://127.0.0.1:6381' }))

  const { writeFileSync, mkdirSync, existsSync } = await import('fs')
  const { join } = await import('path')
  const { createHash } = await import('crypto')
  const workDir = join(import.meta.dirname || '.', 'work-output')
  if (!existsSync(workDir)) mkdirSync(workDir, { recursive: true })

  // Handler 1: WRITES A REAL FILE TO DISK
  q.handle('email.send', async (ctx) => {
    const { to, subject } = ctx.job.payload as any
    const content = `To: ${to}\nSubject: ${subject}\nDate: ${new Date().toISOString()}\n\nThis email was processed by PsyQueue job ${ctx.job.id}`
    const filename = 'email-' + ctx.job.id.substring(0, 8) + '.txt'
    writeFileSync(join(workDir, filename), content)
    console.log('    [email] Wrote ' + filename)
    return { sent: true, to, file: filename }
  })

  // Handler 2: COMPUTES HASH + WRITES RECEIPT FILE
  q.handle('payment.charge', async (ctx) => {
    const { amount, orderId } = ctx.job.payload as any
    if (amount > 500) throw new Error('Amount $' + amount + ' exceeds limit — DECLINED')
    const receipt = createHash('sha256').update(orderId + ':' + amount + ':' + Date.now()).digest('hex')
    const filename = 'receipt-' + receipt.substring(0, 8) + '.txt'
    writeFileSync(join(workDir, filename), `Receipt: ${receipt}\nOrder: ${orderId}\nAmount: $${amount}\nProcessed: ${new Date().toISOString()}`)
    console.log('    [payment] $' + amount + ' charged, receipt: ' + filename)
    return { charged: true, amount, receipt: receipt.substring(0, 16), file: filename }
  })

  // Handler 3: GENERATES A REAL REPORT FILE (CSV)
  q.handle('report.generate', async (ctx) => {
    const { type, month } = ctx.job.payload as any
    await new Promise(r => setTimeout(r, 100 + Math.random() * 200))
    const rows = Array.from({ length: 20 }, (_, i) =>
      `${month},item-${i},${Math.floor(Math.random() * 1000)},${(Math.random() * 100).toFixed(2)}`
    )
    const csv = 'month,item,quantity,revenue\n' + rows.join('\n')
    const filename = 'report-' + month + '.csv'
    writeFileSync(join(workDir, filename), csv)
    console.log('    [report] Generated ' + filename + ' (' + rows.length + ' rows)')
    return { generated: true, file: filename, rows: rows.length }
  })

  await q.start()

  // Flush old data
  const cl = (q as any).backend.getClient()
  await cl.flushdb()

  // Start dashboard
  const dash = createDashboardServer({ port: 4000, getBackend: () => (q as any).backend })
  const server = await dash.start()

  // Wire QueueEvents → Dashboard SSE
  const pushEvent = (server as any)._app?._pushEvent ?? ((dash as any).app as any)?._pushEvent
  const app = (dash as any).app ?? server

  // Connect QueueEvents for each queue
  for (const queue of ['email.send', 'payment.charge', 'report.generate']) {
    const events = new QueueEvents({ url: 'redis://127.0.0.1:6381', queue })
    await events.start()

    events.on('completed', (data) => {
      const evt = { event: 'completed', jobId: data.jobId, queue, result: data.result, ts: Date.now() }
      // Push to SSE clients
      if ((app as any)._pushEvent) (app as any)._pushEvent(evt)
    })
    events.on('failed', (data) => {
      const evt = { event: 'failed', jobId: data.jobId, queue, error: data.error, ts: Date.now() }
      if ((app as any)._pushEvent) (app as any)._pushEvent(evt)
    })
  }

  // Also push enqueue events from in-process bus
  q.events.on('job:enqueued', (e) => {
    const d = e.data as any
    const evt = { event: 'enqueued', jobId: d.jobId, queue: d.queue, ts: Date.now() }
    if ((app as any)._pushEvent) (app as any)._pushEvent(evt)
  })

  // Start workers
  const be = (q as any).backend; be.supportsBlocking = false
  q.startWorker('email.send', { concurrency: 3, pollInterval: 5 })
  q.startWorker('payment.charge', { concurrency: 2, pollInterval: 5 })
  q.startWorker('report.generate', { concurrency: 1, pollInterval: 5 })

  console.log('\n  =============================================')
  console.log('  Dashboard with LIVE Events')
  console.log('  =============================================')
  console.log('  Dashboard: http://localhost:4000')
  console.log('  Live Events: http://localhost:4000/events')
  console.log('  =============================================\n')

  // Continuously enqueue jobs so you can watch events fire
  console.log('  Enqueueing jobs every 500ms — watch the Events page!\n')

  let jobNum = 0
  const interval = setInterval(async () => {
    jobNum++
    try {
      const type = jobNum % 3
      if (type === 0) {
        await q.enqueue('email.send', { to: `user${jobNum}@example.com`, subject: `Email #${jobNum}` })
        console.log(`  [enqueue] email.send #${jobNum}`)
      } else if (type === 1) {
        const amount = Math.random() > 0.3 ? Math.floor(Math.random() * 400) : 999
        await q.enqueue('payment.charge', { amount, currency: 'usd', orderId: `ORD-${jobNum}` },
          { maxRetries: amount > 500 ? 0 : 3 })
        console.log(`  [enqueue] payment.charge $${amount} #${jobNum}${amount > 500 ? ' (will fail!)' : ''}`)
      } else {
        await q.enqueue('report.generate', { type: 'monthly', month: `2026-${String(jobNum % 12 + 1).padStart(2, '0')}` })
        console.log(`  [enqueue] report.generate #${jobNum}`)
      }
    } catch {}
  }, 500)

  // Keep alive
  process.on('SIGINT', async () => {
    clearInterval(interval)
    await q.stop()
    await dash.stop()
    process.exit(0)
  })

  await new Promise(() => {})
}

main().catch(console.error)
