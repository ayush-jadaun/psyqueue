/**
 * Example 01: Basic Queue
 *
 * Demonstrates:
 *   - Creating a PsyQueue instance with a SQLite backend
 *   - Registering job handlers
 *   - Enqueueing jobs with options (priority, queue, metadata)
 *   - Processing jobs and inspecting results
 *   - Subscribing to lifecycle events (job:enqueued, job:completed, job:failed)
 *   - enqueueBulk for atomic multi-job insertion
 *
 * Run: npx tsx examples/01-basic-queue/index.ts
 */

import { PsyQueue } from 'psyqueue'
import { sqlite } from '@psyqueue/backend-sqlite'

async function main() {
  console.log('=== Basic Queue ===\n')

  // Create a queue instance and attach the SQLite backend (in-memory).
  const q = new PsyQueue()
  q.use(sqlite({ path: ':memory:' }))

  // Register handlers. Each handler receives a JobContext and returns a result.
  q.handle('send-email', async (ctx) => {
    const { to, subject } = ctx.job.payload as { to: string; subject: string }
    console.log(`  [send-email] Sending to ${to}: "${subject}"`)
    // Simulate work
    await new Promise(r => setTimeout(r, 20))
    return { sent: true, to, timestamp: new Date().toISOString() }
  })

  q.handle('resize-image', async (ctx) => {
    const { url, width } = ctx.job.payload as { url: string; width: number }
    console.log(`  [resize-image] Resizing ${url} to ${width}px`)
    return { resized: true, url, width }
  })

  // Subscribe to events before starting so we don't miss early events.
  q.events.on('job:enqueued', (e) => {
    const d = e.data as { jobId: string; name: string; queue: string }
    console.log(`  [event] job:enqueued  id=${d.jobId.slice(0, 8)}  name=${d.name}  queue=${d.queue}`)
  })

  q.events.on('job:completed', (e) => {
    const d = e.data as { jobId: string; name: string; result: unknown }
    console.log(`  [event] job:completed id=${d.jobId.slice(0, 8)}  name=${d.name}  result=${JSON.stringify(d.result)}`)
  })

  q.events.on('job:failed', (e) => {
    const d = e.data as { jobId: string; name: string; error: string }
    console.log(`  [event] job:failed    id=${d.jobId.slice(0, 8)}  error=${d.error}`)
  })

  await q.start()
  console.log('Queue started.\n')

  // --- Single enqueue with options ---
  console.log('-- Enqueue individual jobs --')
  const emailId = await q.enqueue(
    'send-email',
    { to: 'alice@example.com', subject: 'Welcome to PsyQueue!' },
    {
      priority: 10,                       // Higher priority processes first
      queue: 'email',                     // Named queue (default is "default")
      meta: { source: 'signup-flow' },    // Arbitrary metadata attached to the job
    },
  )
  console.log(`  Enqueued email job: ${emailId}`)

  const imageId = await q.enqueue(
    'resize-image',
    { url: 'https://cdn.example.com/photo.jpg', width: 800 },
    { queue: 'default', maxRetries: 3 },  // Retry up to 3 times on failure
  )
  console.log(`  Enqueued image job: ${imageId}`)

  // --- Bulk enqueue (atomic) ---
  console.log('\n-- Bulk enqueue (atomic) --')
  const bulkIds = await q.enqueueBulk([
    { name: 'send-email', payload: { to: 'bob@example.com', subject: 'Digest' } },
    { name: 'send-email', payload: { to: 'carol@example.com', subject: 'Digest' } },
    { name: 'send-email', payload: { to: 'dan@example.com', subject: 'Digest' } },
  ])
  console.log(`  Bulk enqueued ${bulkIds.length} jobs: ${bulkIds.map(id => id.slice(0, 8)).join(', ')}`)

  // --- Process all queued jobs ---
  console.log('\n-- Processing jobs --')

  // Process the email queue
  let processed = true
  while (processed) {
    processed = await q.processNext('email')
  }

  // Process the default queue
  processed = true
  while (processed) {
    processed = await q.processNext('default')
  }

  // --- Inspect the backend directly ---
  const backend = q.getExposed('backend') as { listJobs: Function }
  // (Backends are exposed via kernel.expose('backend', ...) — accessible for debugging)

  await q.stop()
  console.log('\nDone!')
}

main().catch(console.error)
