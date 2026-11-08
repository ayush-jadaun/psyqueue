import { it, expect } from 'vitest'
import { Pool } from 'pg'
import { PostgresBackendAdapter } from '../src/adapter.js'

const ADMIN_URL = 'postgres://psyqueue:psyqueue@localhost:5432/psyqueue_test'
async function checkPostgres(): Promise<boolean> {
  const pool = new Pool({ connectionString: ADMIN_URL, connectionTimeoutMillis: 1000 })
  try { (await pool.connect()).release(); return true } catch { return false } finally { await pool.end() }
}
const pgAvailable = await checkPostgres()

it.skipIf(!pgAvailable)('many processes can start (and migrate) a fresh database at the same time', async () => {
  // A brand-new database, so every process really runs the CREATE statements
  const db = `psyqueue_race_${Date.now()}`
  const admin = new Pool({ connectionString: ADMIN_URL })
  await admin.query(`CREATE DATABASE ${db}`)
  try {
    const url = `postgres://psyqueue:psyqueue@localhost:5432/${db}`
    const adapters = Array.from({ length: 8 }, () => new PostgresBackendAdapter({ connectionString: url }))
    const results = await Promise.allSettled(adapters.map(a => a.connect()))
    await Promise.all(adapters.map(a => a.disconnect().catch(() => {})))
    const errors = results.flatMap(r => (r.status === 'rejected' ? [String(r.reason)] : []))
    expect(errors).toEqual([])
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`)
    await admin.end()
  }
})

it.skipIf(!pgAvailable)('processes can connect while another process is busy writing', async () => {
  const busy = new PostgresBackendAdapter({ connectionString: ADMIN_URL })
  await busy.connect()
  const queue = `busy_${Date.now()}`
  let stop = false
  const errors: string[] = []
  const writer = (async () => {
    for (let i = 0; !stop; i++) {
      const id = `busy-${queue}-${i}`
      await busy.enqueue({ id, queue, name: 'x', payload: {}, status: 'pending', priority: 0, maxRetries: 1, attempt: 1,
        backoff: 'fixed', timeout: 1000, createdAt: new Date(), meta: {} }).catch(e => errors.push(String(e)))
      await busy.atomic([{ type: 'nack', jobId: id, opts: { requeue: false } }]).catch(e => errors.push(String(e)))
    }
  })()
  const results = await Promise.allSettled(Array.from({ length: 10 }, async () => {
    const a = new PostgresBackendAdapter({ connectionString: ADMIN_URL })
    await a.connect()
    await a.disconnect()
  }))
  stop = true
  await writer
  await busy.disconnect()
  expect([...errors, ...results.flatMap(r => (r.status === 'rejected' ? [String(r.reason)] : []))]).toEqual([])
})
