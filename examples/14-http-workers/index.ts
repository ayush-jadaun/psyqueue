/**
 * Example 14: HTTP Workers
 *
 * Demonstrates:
 *   - Starting an HTTP worker server that external processes can poll for jobs
 *   - Bearer token authentication for the worker endpoint
 *   - Fetching and acknowledging jobs via HTTP (curl-compatible)
 *   - http:listening event when the server starts
 *   - How external workers interact: GET /dequeue → process → POST /ack or /nack
 *
 * The HTTP API (served by the plugin):
 *   GET  /dequeue?queue=<name>          → Returns the next job (JSON)
 *   POST /ack    { jobId, completionToken } → Acknowledge success
 *   POST /nack   { jobId, requeue?, reason? } → Acknowledge failure
 *
 * Equivalent curl commands:
 *   # Fetch next job
 *   curl -H "Authorization: Bearer worker-secret" http://localhost:3100/dequeue?queue=default
 *
 *   # Acknowledge job
 *   curl -X POST -H "Authorization: Bearer worker-secret" \
 *        -H "Content-Type: application/json" \
 *        -d '{"jobId":"<id>","completionToken":"<token>"}' \
 *        http://localhost:3100/ack
 *
 * Run: npx tsx examples/14-http-workers/index.ts
 */

import { PsyQueue } from '@psyqueue/core'
import { sqlite } from '@psyqueue/backend-sqlite'
import { httpWorkers } from '@psyqueue/plugin-http-workers'

const WORKER_PORT = 3100
const BEARER_TOKEN = 'worker-secret-token'

async function main() {
  console.log('=== HTTP Workers ===\n')

  const q = new PsyQueue()
  q.use(sqlite({ path: ':memory:' }))

  // Start an HTTP server that exposes a dequeue/ack/nack API.
  // External workers (any language) can fetch and process jobs via HTTP.
  q.use(httpWorkers({
    port: WORKER_PORT,
    auth: {
      type: 'bearer',
      tokens: [BEARER_TOKEN],   // Multiple tokens supported for key rotation
    },
    queues: ['default', 'high-priority', 'email'],  // Allowed queues
  }))

  // Also register an in-process handler as fallback.
  q.handle('process-order', async (ctx) => {
    const { orderId } = ctx.job.payload as { orderId: string }
    console.log(`  [in-process] Processing order ${orderId}`)
    return { processed: true, orderId, processor: 'in-process' }
  })

  // ── Events ─────────────────────────────────────────────────────────────────

  q.events.on('http:listening', (e) => {
    const d = e.data as { port: number }
    console.log(`  [event] http:listening  port=${d.port}`)
    console.log(`  HTTP worker server accepting connections on :${d.port}`)
  })

  q.events.on('job:enqueued', (e) => {
    const d = e.data as { jobId: string; name: string }
    console.log(`  [event] job:enqueued  id=${d.jobId.slice(0, 8)}  name=${d.name}`)
  })

  q.events.on('job:completed', (e) => {
    const d = e.data as { jobId: string; name: string; result: unknown }
    console.log(`  [event] job:completed id=${d.jobId.slice(0, 8)}  name=${d.name}`)
  })

  await q.start()

  // ── Enqueue some jobs ─────────────────────────────────────────────────────

  console.log('\n-- Enqueueing jobs --')
  const id1 = await q.enqueue('process-order', { orderId: 'ORD-001', items: ['book', 'pen'] })
  const id2 = await q.enqueue('process-order', { orderId: 'ORD-002', items: ['laptop'] })
  const id3 = await q.enqueue('process-order', { orderId: 'ORD-003', items: ['headphones'] })

  // ── Show curl commands ────────────────────────────────────────────────────

  console.log('\n-- HTTP API is now available. Use these curl commands: --')
  console.log(`
  # Dequeue the next job from the default queue:
  curl -s \\
    -H "Authorization: Bearer ${BEARER_TOKEN}" \\
    "http://localhost:${WORKER_PORT}/dequeue?queue=default" | jq .

  # Acknowledge a completed job (replace <jobId> and <completionToken>):
  curl -s -X POST \\
    -H "Authorization: Bearer ${BEARER_TOKEN}" \\
    -H "Content-Type: application/json" \\
    -d '{"jobId":"<jobId>","completionToken":"<completionToken>"}' \\
    "http://localhost:${WORKER_PORT}/ack"

  # Nack a failed job (requeue it):
  curl -s -X POST \\
    -H "Authorization: Bearer ${BEARER_TOKEN}" \\
    -H "Content-Type: application/json" \\
    -d '{"jobId":"<jobId>","requeue":true,"reason":"Worker error"}' \\
    "http://localhost:${WORKER_PORT}/nack"
  `)

  // ── Simulate an external HTTP worker using the Node built-in fetch ────────

  console.log('-- Simulating HTTP worker via fetch() --\n')

  const baseUrl = `http://localhost:${WORKER_PORT}`
  const headers = {
    'Authorization': `Bearer ${BEARER_TOKEN}`,
    'Content-Type': 'application/json',
  }

  // Process all 3 jobs via HTTP
  for (let i = 0; i < 3; i++) {
    // Step 1: Fetch the next job
    const dequeueRes = await fetch(`${baseUrl}/dequeue?queue=default`, { headers })

    if (dequeueRes.status === 204) {
      console.log('  Queue is empty.')
      break
    }

    if (!dequeueRes.ok) {
      console.log(`  Dequeue failed: ${dequeueRes.status} ${dequeueRes.statusText}`)
      break
    }

    const job = await dequeueRes.json() as {
      id: string
      name: string
      payload: unknown
      completionToken: string
    }

    console.log(`  Fetched job: id=${job.id.slice(0, 8)}  name=${job.name}  payload=${JSON.stringify(job.payload)}`)

    // Step 2: "Process" the job (simulate work)
    await new Promise(r => setTimeout(r, 30))
    const result = { processed: true, processor: 'http-worker', orderId: (job.payload as any).orderId }

    // Step 3: Acknowledge the job as completed
    const ackRes = await fetch(`${baseUrl}/ack`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jobId: job.id, completionToken: job.completionToken, result }),
    })

    if (ackRes.ok) {
      console.log(`  Acked job: id=${job.id.slice(0, 8)}`)
    } else {
      console.log(`  Ack failed: ${ackRes.status}`)
    }
  }

  // ── Show what happens with an unauthorized request ────────────────────────

  console.log('\n-- Unauthorized request (missing token) --')
  const unauthorizedRes = await fetch(`${baseUrl}/dequeue?queue=default`)
  console.log(`  Status: ${unauthorizedRes.status} (expected: 401)`)

  await q.stop()
  console.log('\nDone!')
}

main().catch(console.error)
