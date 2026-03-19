/**
 * DISTRIBUTED WORKER — Runs as a SEPARATE process
 *
 * Connects to the SAME Redis as the server.
 * Tags every job result with this worker's PID to prove distribution.
 */

import { PsyQueue } from '../../packages/core/src/index.js'
import { redis } from '../../packages/backend-redis/src/index.js'
import { createHash } from 'crypto'
import { writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'

const WORKER_ID = process.env.WORKER_ID || process.argv[2] || '?'
const workDir = join(import.meta.dirname || '.', 'work-output')
if (!existsSync(workDir)) mkdirSync(workDir, { recursive: true })

const q = new PsyQueue()
q.use(redis({ url: 'redis://127.0.0.1:6381' }))

let jobCount = 0
const tag = () => 'W' + WORKER_ID + ':PID' + process.pid

// EMAIL: writes an email file to disk
q.handle('email.send', async (ctx) => {
  jobCount++
  const { to, subject } = ctx.job.payload as any
  const filename = 'email-' + ctx.job.id.substring(0, 8) + '-w' + WORKER_ID + '.txt'
  writeFileSync(join(workDir, filename), `To: ${to}\nSubject: ${subject}\nWorker: ${tag()}\nDate: ${new Date().toISOString()}`)
  return { worker: tag(), file: filename, sent: true }
})

// PAYMENT: computes receipt hash, may fail
q.handle('payment.charge', async (ctx) => {
  jobCount++
  const { amount, orderId } = ctx.job.payload as any
  if (amount > 500) throw new Error('DECLINED by ' + tag() + ' — amount $' + amount)
  const receipt = createHash('sha256').update(orderId + ':' + amount).digest('hex').substring(0, 16)
  const filename = 'receipt-' + receipt.substring(0, 8) + '-w' + WORKER_ID + '.txt'
  writeFileSync(join(workDir, filename), `Receipt: ${receipt}\nAmount: $${amount}\nWorker: ${tag()}`)
  return { worker: tag(), file: filename, receipt, charged: true }
})

// REPORT: generates CSV file
q.handle('report.generate', async (ctx) => {
  jobCount++
  const { month } = ctx.job.payload as any
  await new Promise(r => setTimeout(r, 50 + Math.random() * 100))
  const rows = Array.from({ length: 15 }, (_, i) => `${month},item-${i},${Math.floor(Math.random() * 500)}`)
  const filename = 'report-' + month + '-w' + WORKER_ID + '.csv'
  writeFileSync(join(workDir, filename), 'month,item,qty\n' + rows.join('\n'))
  return { worker: tag(), file: filename, rows: rows.length }
})

// DATA TRANSFORM: JSON transform + file
q.handle('data.transform', async (ctx) => {
  jobCount++
  const { format, rows, source } = ctx.job.payload as any
  const data = Array.from({ length: rows }, (_, i) => ({ id: i, source, value: Math.random() }))
  const hash = createHash('md5').update(JSON.stringify(data)).digest('hex').substring(0, 12)
  const filename = 'transform-' + hash + '-w' + WORKER_ID + '.json'
  writeFileSync(join(workDir, filename), JSON.stringify(data, null, 2))
  return { worker: tag(), file: filename, format, rows: data.length, hash }
})

await q.start()
const be = (q as any).backend
be.supportsBlocking = false
q.startWorker('email.send', { concurrency: 3, pollInterval: 2 })
q.startWorker('payment.charge', { concurrency: 3, pollInterval: 2 })
q.startWorker('report.generate', { concurrency: 2, pollInterval: 2 })
q.startWorker('data.transform', { concurrency: 2, pollInterval: 2 })

process.stdout.write('Worker-' + WORKER_ID + ' STARTED (PID ' + process.pid + ')\n')

// Keep alive
process.on('SIGINT', async () => {
  process.stdout.write('Worker-' + WORKER_ID + ' stopping... processed ' + jobCount + ' jobs\n')
  await q.stop()
  process.exit(0)
})

await new Promise(() => {})
