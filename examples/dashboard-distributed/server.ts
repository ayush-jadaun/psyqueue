/**
 * DISTRIBUTED DASHBOARD DEMO
 *
 * Runs dashboard + enqueuer on THIS process.
 * Workers run as SEPARATE processes (different PIDs).
 * Dashboard shows which worker processed each job in real-time.
 *
 * Run: npx tsx examples/dashboard-distributed/server.ts
 * Then open: http://localhost:4000/events
 */

import { PsyQueue, QueueEvents } from '../../packages/core/src/index.js'
import { redis } from '../../packages/backend-redis/src/index.js'
import { createDashboardServer } from '../../packages/dashboard/src/server.js'
import { spawn } from 'child_process'
import { join } from 'path'
async function main() {
  // Flush Redis using the backend client


  // === ENQUEUER (this process) ===
  const q = new PsyQueue()
  q.use(redis({ url: 'redis://127.0.0.1:6381' }))
  // Register dummy handlers — actual processing happens in worker processes
  q.handle('email.send', async () => ({}))
  q.handle('payment.charge', async () => ({}))
  q.handle('report.generate', async () => ({}))
  q.handle('data.transform', async () => ({}))
  await q.start()

  // Flush old data
  const cl = (q as any).backend.getClient()
  await cl.flushdb()

  // === DASHBOARD ===
  const dash = createDashboardServer({ port: 4000, getBackend: () => (q as any).backend })
  const server = await dash.start()
  const app = (dash as any).app ?? server

  // === QUEUE EVENTS (cross-process listener for ALL queues) ===
  const queues = ['email.send', 'payment.charge', 'report.generate', 'data.transform']
  for (const queueName of queues) {
    const qe = new QueueEvents({ url: 'redis://127.0.0.1:6381', queue: queueName })
    await qe.start()

    qe.on('completed', (data) => {
      if ((app as any)._pushEvent) (app as any)._pushEvent({
        event: 'completed', jobId: data.jobId, queue: queueName, result: data.result, ts: Date.now(),
      })
    })
    qe.on('failed', (data) => {
      if ((app as any)._pushEvent) (app as any)._pushEvent({
        event: 'failed', jobId: data.jobId, queue: queueName, error: data.error, ts: Date.now(),
      })
    })
  }

  // Push enqueue events from this process
  q.events.on('job:enqueued', (e) => {
    const d = e.data as any
    if ((app as any)._pushEvent) {
      (app as any)._pushEvent({
        event: 'enqueued',
        jobId: d.jobId,
        queue: d.queue,
        source: 'server (PID ' + process.pid + ')',
        ts: Date.now(),
      })
    }
  })

  // === SPAWN 2 WORKER PROCESSES ===
  const dir = import.meta.dirname || '.'

  console.log('\n  =====================================================')
  console.log('  DISTRIBUTED DASHBOARD — Proof of Distribution')
  console.log('  =====================================================')
  console.log('  Server/Enqueuer: PID ' + process.pid)

  const w1 = spawn('npx', ['tsx', '"' + join(dir, 'worker.ts') + '"', '1'], {
    cwd: join(dir, '..', '..'),
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, WORKER_ID: '1' },
  })
  w1.stdout.on('data', (d: Buffer) => process.stdout.write('  [W1] ' + d.toString()))
  w1.stderr.on('data', (d: Buffer) => {
    const s = d.toString()
    if (!s.includes('Experimental') && !s.includes('ioredis')) process.stdout.write('  [W1 ERR] ' + s)
  })

  const w2 = spawn('npx', ['tsx', '"' + join(dir, 'worker.ts') + '"', '2'], {
    cwd: join(dir, '..', '..'),
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, WORKER_ID: '2' },
  })
  w2.stdout.on('data', (d: Buffer) => process.stdout.write('  [W2] ' + d.toString()))
  w2.stderr.on('data', (d: Buffer) => {
    const s = d.toString()
    if (!s.includes('Experimental') && !s.includes('ioredis')) process.stdout.write('  [W2 ERR] ' + s)
  })

  // Wait for workers to start
  await new Promise(r => setTimeout(r, 3000))

  console.log('  Dashboard: http://localhost:4000')
  console.log('  Live Events: http://localhost:4000/events')
  console.log('  =====================================================')
  console.log('  Enqueueing jobs every 300ms — watch the Events page!')
  console.log('  Each event shows WHICH WORKER (PID) processed it.')
  console.log('  =====================================================\n')

  // Enqueue varied jobs continuously
  let num = 0
  const interval = setInterval(async () => {
    num++
    try {
      const type = num % 4
      if (type === 0) {
        await q.enqueue('email.send', { to: `user${num}@example.com`, subject: `Welcome #${num}` }, { priority: Math.floor(Math.random() * 10) })
      } else if (type === 1) {
        const amount = num % 7 === 0 ? 999 : Math.floor(Math.random() * 400) + 10
        await q.enqueue('payment.charge', { amount, currency: 'usd', orderId: `ORD-${num}` }, { maxRetries: amount > 500 ? 0 : 3, priority: amount > 200 ? 5 : 0 })
      } else if (type === 2) {
        await q.enqueue('report.generate', { type: 'monthly', month: `2026-${String(num % 12 + 1).padStart(2, '0')}` })
      } else {
        await q.enqueue('data.transform', { format: 'csv', rows: 10 + num % 50, source: `dataset-${num}` }, { priority: 3 })
      }
    } catch {}
  }, 300)

  process.on('SIGINT', async () => {
    clearInterval(interval)
    w1.kill()
    w2.kill()
    await events.stop()
    await q.stop()
    await dash.stop()
    process.exit(0)
  })

  await new Promise(() => {})
}

main().catch(console.error)
