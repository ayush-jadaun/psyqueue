/**
 * Example 08: Schema Versioning
 *
 * Demonstrates:
 *   - Using schemaVersioning.versioned() to register handlers for multiple schema versions
 *   - Automatic migration from an older payload shape to the current one
 *   - Processing a "legacy" job (v1) and a "current" job (v2) with the same handler
 *   - Zod-based payload validation — invalid payloads are dead-lettered
 *
 * Scenario:
 *   v1 payload: { email: string }
 *   v2 payload: { email: string; name: string; locale: string }
 *   Migration: adds default name='Unknown' and locale='en' when upgrading v1 → v2
 *
 * Run: npx tsx examples/08-schema-versioning/index.ts
 */

import { PsyQueue } from 'psyqueue'
import { sqlite } from '@psyqueue/backend-sqlite'
import { schemaVersioning } from '@psyqueue/plugin-schema-versioning'
import { z } from 'zod'

async function main() {
  console.log('=== Schema Versioning ===\n')

  const q = new PsyQueue()
  q.use(sqlite({ path: ':memory:' }))
  q.use(schemaVersioning())

  // ── Define versioned handler ───────────────────────────────────────────────

  // v1 schema: just an email address
  const v1Schema = z.object({
    email: z.string().email(),
  })

  // v2 schema: email + name + locale
  const v2Schema = z.object({
    email: z.string().email(),
    name: z.string().min(1),
    locale: z.string().min(2),
  })

  q.handle(
    'welcome-email',
    schemaVersioning.versioned({
      current: 2,
      versions: {
        1: {
          schema: v1Schema,
          process: async (ctx) => {
            // This runs if a job was enqueued as v1 AND migration did not upgrade it.
            // In practice, migration always runs first so this is a fallback.
            const payload = ctx.job.payload as z.infer<typeof v1Schema>
            console.log(`  [welcome-email v1] Sending legacy welcome to ${payload.email}`)
            return { sent: true, version: 1, email: payload.email }
          },
          migrate: (payload: unknown) => {
            // Upgrade v1 → v2: fill in default name and locale
            const v1 = payload as z.infer<typeof v1Schema>
            console.log(`  [migrate v1→v2] Adding defaults for ${v1.email}`)
            return {
              email: v1.email,
              name: 'Unknown',
              locale: 'en',
            }
          },
        },
        2: {
          schema: v2Schema,
          process: async (ctx) => {
            const payload = ctx.job.payload as z.infer<typeof v2Schema>
            console.log(`  [welcome-email v2] Sending welcome to ${payload.name} <${payload.email}> (locale: ${payload.locale})`)
            return { sent: true, version: 2, email: payload.email, name: payload.name }
          },
        },
      },
    }),
  )

  // ── Events ────────────────────────────────────────────────────────────────

  q.events.on('job:completed', (e) => {
    const d = e.data as { jobId: string; name: string; result: unknown }
    console.log(`  [event] job:completed  id=${d.jobId.slice(0, 8)}  result=${JSON.stringify(d.result)}`)
  })

  q.events.on('job:dead', (e) => {
    const d = e.data as { jobId: string; name: string }
    console.log(`  [event] job:dead       id=${d.jobId.slice(0, 8)}  name=${d.name}  (schema validation failed)`)
  })

  await q.start()
  console.log('Queue started.\n')

  // ── Enqueue a v2 job (current schema) ─────────────────────────────────────

  console.log('-- Enqueue v2 (current) job --')
  await q.enqueue(
    'welcome-email',
    { email: 'alice@example.com', name: 'Alice', locale: 'fr' },
    { meta: { schemaVersion: 2 } },  // schemaVersion is set on the job object
  )

  // ── Enqueue a v1 job (old payload shape) ──────────────────────────────────

  // Simulate a job that was enqueued before the schema was updated.
  // We explicitly set schemaVersion: 1 to indicate this is a legacy payload.
  console.log('\n-- Enqueue v1 (legacy) job — will be migrated to v2 automatically --')
  const { createJob } = await import('psyqueue')
  const legacyJob = createJob('welcome-email', { email: 'bob@example.com' }, {})
  legacyJob.schemaVersion = 1  // Mark as old schema version

  // Directly enqueue to backend to simulate a pre-existing stale job
  const backend = q.getExposed('backend') as { enqueue: Function }
  await backend.enqueue(legacyJob)

  // ── Enqueue an invalid job (missing required fields) ──────────────────────

  console.log('\n-- Enqueue invalid v2 job (missing name) — will be dead-lettered --')
  const invalidJob = createJob('welcome-email', { email: 'not-an-email' }, {})
  invalidJob.schemaVersion = 2
  await backend.enqueue(invalidJob)

  // ── Process all jobs ──────────────────────────────────────────────────────

  console.log('\n-- Processing jobs --')
  for (let i = 0; i < 5; i++) {
    const processed = await q.processNext('default')
    if (!processed) break
  }

  // Alternative: use startWorker() for continuous processing (production pattern)
  // In production, replace the manual loop with:
  //
  // q.startWorker('default', { concurrency: 5, pollInterval: 50 })
  //
  // Schema versioning middleware runs transparently during process pipeline,
  // migrating payloads from old versions before the handler executes.

  await q.stop()
  console.log('\nDone!')
}

main().catch(console.error)
