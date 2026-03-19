import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { PsyQueue, createJob } from 'psyqueue'
import type { JobContext } from 'psyqueue'
import { sqlite } from '../../backend-sqlite/src/index.js'
import { schemaVersioning } from '../src/index.js'
import { z } from 'zod'

type BackendLike = { enqueue: (job: ReturnType<typeof createJob>) => Promise<string> }

describe('Schema Versioning', () => {
  let q: PsyQueue

  beforeEach(async () => {
    q = new PsyQueue()
    q.use(sqlite({ path: ':memory:' }))
    q.use(schemaVersioning())
    await q.start()
  })

  afterEach(async () => {
    await q.stop()
  })

  it('processes current version payload without migration', async () => {
    const handler = vi.fn(async () => ({ sent: true }))

    q.handle(
      'email.send',
      schemaVersioning.versioned({
        versions: {
          1: { schema: z.object({ to: z.string() }), process: handler },
        },
        current: 1,
      }),
    )

    await q.enqueue('email.send', { to: 'test@example.com' })
    await q.processNext('email.send')
    expect(handler).toHaveBeenCalledOnce()
  })

  it('migrates v1 payload to v2 automatically', async () => {
    const v2Handler = vi.fn(async (ctx: JobContext) => {
      expect(ctx.job.payload).toEqual({ to: ['old@test.com'] })
    })

    q.handle(
      'email',
      schemaVersioning.versioned({
        versions: {
          1: { schema: z.object({ to: z.string() }), process: vi.fn() },
          2: {
            schema: z.object({ to: z.array(z.string()) }),
            process: v2Handler,
            migrate: (v1: unknown) => ({ to: [(v1 as { to: string }).to] }),
          },
        },
        current: 2,
      }),
    )

    // Simulate a v1 job already in the queue (enqueued before code update)
    const backend = (q as unknown as { backend: BackendLike }).backend
    const job = createJob('email', { to: 'old@test.com' })
    job.schemaVersion = 1
    await backend.enqueue(job)

    await q.processNext('email')
    expect(v2Handler).toHaveBeenCalledOnce()
  })

  it('chains migrations v1 → v2 → v3', async () => {
    const v3Handler = vi.fn(async (ctx: JobContext) => {
      expect(ctx.job.payload).toEqual({
        recipients: [{ email: 'a@b.com' }],
        html: false,
      })
    })

    q.handle(
      'email',
      schemaVersioning.versioned({
        versions: {
          1: { schema: z.object({ to: z.string() }), process: vi.fn() },
          2: {
            schema: z.object({ to: z.array(z.string()), html: z.boolean() }),
            process: vi.fn(),
            migrate: (v1: unknown) => ({
              to: [(v1 as { to: string }).to],
              html: false,
            }),
          },
          3: {
            schema: z.object({
              recipients: z.array(z.object({ email: z.string() })),
              html: z.boolean(),
            }),
            process: v3Handler,
            migrate: (v2: unknown) => {
              const payload = v2 as { to: string[]; html: boolean }
              return {
                recipients: payload.to.map((e) => ({ email: e })),
                html: payload.html,
              }
            },
          },
        },
        current: 3,
      }),
    )

    // v1 job
    const backend = (q as unknown as { backend: BackendLike }).backend
    const job = createJob('email', { to: 'a@b.com' })
    job.schemaVersion = 1
    await backend.enqueue(job)

    await q.processNext('email')
    expect(v3Handler).toHaveBeenCalledOnce()
  })

  it('dead-letters on schema validation failure', async () => {
    q.handle(
      'strict',
      schemaVersioning.versioned({
        versions: {
          1: {
            schema: z.object({ required: z.string() }),
            process: vi.fn(),
          },
        },
        current: 1,
      }),
    )

    // Enqueue job with invalid payload
    const backend = (q as unknown as { backend: BackendLike }).backend
    const job = createJob('strict', { wrong: 123 })
    job.schemaVersion = 1
    await backend.enqueue(job)

    await q.processNext('strict')

    // Should be dead-lettered
    const dead = await q.deadLetter.list({ queue: 'strict' })
    expect(dead.data.length).toBeGreaterThan(0)
  })

  it('new jobs get current schema version set during processing', async () => {
    const handler = vi.fn(async (ctx: JobContext) => {
      // During processing, schemaVersion should be set to current (1)
      expect(ctx.job.schemaVersion).toBe(1)
      return { ok: true }
    })

    q.handle(
      'notify',
      schemaVersioning.versioned({
        versions: {
          1: {
            schema: z.object({ message: z.string() }),
            process: handler,
          },
        },
        current: 1,
      }),
    )

    await q.enqueue('notify', { message: 'hello' })
    await q.processNext('notify')
    expect(handler).toHaveBeenCalledOnce()
  })

  it('handles missing schema version (defaults to v1)', async () => {
    const v1Handler = vi.fn(async () => ({ ok: true }))

    q.handle(
      'legacy',
      schemaVersioning.versioned({
        versions: {
          1: {
            schema: z.object({ data: z.string() }),
            process: v1Handler,
          },
        },
        current: 1,
      }),
    )

    // Enqueue a job without schemaVersion set (simulates legacy jobs)
    const backend = (q as unknown as { backend: BackendLike }).backend
    const job = createJob('legacy', { data: 'legacy-value' })
    // schemaVersion is intentionally NOT set — should default to 1
    expect(job.schemaVersion).toBeUndefined()
    await backend.enqueue(job)

    await q.processNext('legacy')
    expect(v1Handler).toHaveBeenCalledOnce()
  })

  it('rejects invalid payload after migration (bad migrate function)', async () => {
    // v2 migrate produces data that fails the v2 schema
    q.handle(
      'badmigrate',
      schemaVersioning.versioned({
        versions: {
          1: {
            schema: z.object({ count: z.number() }),
            process: vi.fn(),
          },
          2: {
            // Expects count to be a string, but migrate returns a number
            schema: z.object({ count: z.string() }),
            process: vi.fn(),
            // Bad migration: returns number instead of string
            migrate: (v1: unknown) => ({
              count: (v1 as { count: number }).count,
            }),
          },
        },
        current: 2,
      }),
    )

    const backend = (q as unknown as { backend: BackendLike }).backend
    const job = createJob('badmigrate', { count: 42 })
    job.schemaVersion = 1
    await backend.enqueue(job)

    await q.processNext('badmigrate')

    const dead = await q.deadLetter.list({ queue: 'badmigrate' })
    expect(dead.data.length).toBeGreaterThan(0)
  })

  it('only calls the current version handler — not prior version handlers', async () => {
    const v1Handler = vi.fn(async () => ({ v: 1 }))
    const v2Handler = vi.fn(async () => ({ v: 2 }))

    q.handle(
      'versioned-dispatch',
      schemaVersioning.versioned({
        versions: {
          1: { schema: z.object({ x: z.number() }), process: v1Handler },
          2: {
            schema: z.object({ x: z.number(), y: z.number() }),
            process: v2Handler,
            migrate: (v1: unknown) => ({ ...(v1 as object), y: 0 }),
          },
        },
        current: 2,
      }),
    )

    // Enqueue a v1 job — should migrate to v2 and call v2Handler only
    const backend = (q as unknown as { backend: BackendLike }).backend
    const job = createJob('versioned-dispatch', { x: 10 })
    job.schemaVersion = 1
    await backend.enqueue(job)

    await q.processNext('versioned-dispatch')

    expect(v1Handler).not.toHaveBeenCalled()
    expect(v2Handler).toHaveBeenCalledOnce()
  })
})
