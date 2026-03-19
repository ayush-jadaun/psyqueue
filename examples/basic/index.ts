/**
 * Basic PsyQueue Example — Simple enqueue + process with SQLite
 *
 * Demonstrates:
 *   - Creating a PsyQueue instance
 *   - Registering the SQLite backend
 *   - Defining a job handler
 *   - Enqueueing and processing jobs
 */
import { PsyQueue } from 'psyqueue'
import { sqlite } from '@psyqueue/backend-sqlite'

async function main() {
  // 1. Create queue instance
  const q = new PsyQueue()

  // 2. Register the SQLite backend (in-memory for this demo)
  q.use(sqlite({ path: ':memory:' }))

  // 3. Register a handler for "send-email" jobs
  q.handle('send-email', async (ctx) => {
    const { to, subject } = ctx.job.payload as { to: string; subject: string }
    console.log(`Sending email to ${to}: "${subject}"`)
    return { sent: true, to }
  })

  // 4. Start the queue
  await q.start()
  console.log('Queue started!')

  // 5. Enqueue some jobs
  const id1 = await q.enqueue('send-email', { to: 'alice@example.com', subject: 'Hello!' })
  const id2 = await q.enqueue('send-email', { to: 'bob@example.com', subject: 'Welcome!' })
  console.log(`Enqueued jobs: ${id1}, ${id2}`)

  // 6. Listen for events
  q.events.on('job:completed', (event) => {
    console.log('Job completed:', event.data)
  })

  // 7a. Process jobs manually (one at a time — useful for scripts/tests)
  await q.processNext('default')
  await q.processNext('default')

  // 7b. Alternative: use startWorker() for continuous processing (production pattern)
  // Uncomment the following to use the worker pool instead of manual processNext():
  //
  // q.startWorker('default', { concurrency: 5, pollInterval: 50 })
  //
  // startWorker() automatically dequeues and dispatches jobs to handlers.
  // It uses semaphore-controlled concurrency and blocking reads for Redis.
  // Workers are stopped automatically when q.stop() is called.

  // 8. Stop
  await q.stop()
  console.log('Queue stopped.')
}

main().catch(console.error)
