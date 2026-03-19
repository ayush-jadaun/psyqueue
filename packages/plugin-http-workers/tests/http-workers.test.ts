import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { httpWorkers } from '../src/index.js'
import { PsyQueue } from '@psyqueue/core'
import { sqlite } from '../../backend-sqlite/src/index.js'

describe('HTTP Workers Plugin', () => {
  let q: PsyQueue
  let port: number
  let baseUrl: string

  beforeEach(async () => {
    port = 9000 + Math.floor(Math.random() * 10000)
    baseUrl = `http://localhost:${port}`
  })

  afterEach(async () => {
    try { await q.stop() } catch (_e) { /* ignore */ }
  })

  it('starts server and responds to requests', async () => {
    q = new PsyQueue()
    q.use(sqlite({ path: ':memory:' }))
    q.use(httpWorkers({ port }))
    await q.start()

    const res = await fetch(`${baseUrl}/jobs/fetch?queue=default&count=1`)
    expect(res.status).toBe(200)
    const body = await res.json() as { jobs: unknown[] }
    expect(body.jobs).toHaveLength(0)
  })

  it('fetches enqueued jobs via HTTP', async () => {
    q = new PsyQueue()
    q.use(sqlite({ path: ':memory:' }))
    q.use(httpWorkers({ port }))
    q.handle('send-email', async () => 'done')
    await q.start()

    await q.enqueue('send-email', { to: 'test@example.com' }, { queue: 'emails' })

    const res = await fetch(`${baseUrl}/jobs/fetch?queue=emails&count=5`)
    expect(res.status).toBe(200)
    const body = await res.json() as { jobs: Array<{ id: string; name: string; queue: string; payload: unknown }> }
    expect(body.jobs).toHaveLength(1)
    expect(body.jobs[0]!.name).toBe('send-email')
    expect(body.jobs[0]!.queue).toBe('emails')
    expect(body.jobs[0]!.payload).toEqual({ to: 'test@example.com' })
  })

  it('acks a job via POST /jobs/:id/ack', async () => {
    q = new PsyQueue()
    q.use(sqlite({ path: ':memory:' }))
    q.use(httpWorkers({ port }))
    q.handle('task', async () => 'ok')
    await q.start()

    await q.enqueue('task', { data: 1 }, { queue: 'work' })

    // Fetch job first
    const fetchRes = await fetch(`${baseUrl}/jobs/fetch?queue=work&count=1`)
    const fetchBody = await fetchRes.json() as { jobs: Array<{ id: string; completionToken: string }> }
    expect(fetchBody.jobs).toHaveLength(1)
    const job = fetchBody.jobs[0]!

    // Ack the job
    const ackRes = await fetch(`${baseUrl}/jobs/${job.id}/ack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ completionToken: job.completionToken }),
    })
    expect(ackRes.status).toBe(200)
    const ackBody = await ackRes.json() as { alreadyCompleted: boolean }
    expect(ackBody.alreadyCompleted).toBe(false)
  })

  it('nacks a job via POST /jobs/:id/nack', async () => {
    q = new PsyQueue()
    q.use(sqlite({ path: ':memory:' }))
    q.use(httpWorkers({ port }))
    q.handle('task', async () => 'ok')
    await q.start()

    await q.enqueue('task', { data: 1 }, { queue: 'work' })

    // Fetch job
    const fetchRes = await fetch(`${baseUrl}/jobs/fetch?queue=work&count=1`)
    const fetchBody = await fetchRes.json() as { jobs: Array<{ id: string }> }
    const job = fetchBody.jobs[0]!

    // Nack with requeue
    const nackRes = await fetch(`${baseUrl}/jobs/${job.id}/nack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requeue: true, delay: 0, reason: 'retry later' }),
    })
    expect(nackRes.status).toBe(200)
    const nackBody = await nackRes.json() as { ok: boolean }
    expect(nackBody.ok).toBe(true)
  })

  it('registers a worker via POST /workers/register', async () => {
    q = new PsyQueue()
    q.use(sqlite({ path: ':memory:' }))
    q.use(httpWorkers({ port }))
    await q.start()

    const res = await fetch(`${baseUrl}/workers/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workerId: 'worker-1', queues: ['emails', 'tasks'] }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { workerId: string; queues: string[]; ok: boolean }
    expect(body.workerId).toBe('worker-1')
    expect(body.queues).toEqual(['emails', 'tasks'])
    expect(body.ok).toBe(true)
  })

  it('rejects requests with invalid auth token', async () => {
    q = new PsyQueue()
    q.use(sqlite({ path: ':memory:' }))
    q.use(httpWorkers({
      port,
      auth: { type: 'bearer', tokens: ['secret-token'] },
    }))
    await q.start()

    const res = await fetch(`${baseUrl}/jobs/fetch?queue=default`, {
      headers: { Authorization: 'Bearer wrong-token' },
    })
    expect(res.status).toBe(401)
  })

  it('accepts requests with valid auth token', async () => {
    q = new PsyQueue()
    q.use(sqlite({ path: ':memory:' }))
    q.use(httpWorkers({
      port,
      auth: { type: 'bearer', tokens: ['secret-token'] },
    }))
    await q.start()

    const res = await fetch(`${baseUrl}/jobs/fetch?queue=default`, {
      headers: { Authorization: 'Bearer secret-token' },
    })
    expect(res.status).toBe(200)
  })

  it('returns 404 for unknown routes', async () => {
    q = new PsyQueue()
    q.use(sqlite({ path: ':memory:' }))
    q.use(httpWorkers({ port }))
    await q.start()

    const res = await fetch(`${baseUrl}/unknown-route`)
    expect(res.status).toBe(404)
  })
})
