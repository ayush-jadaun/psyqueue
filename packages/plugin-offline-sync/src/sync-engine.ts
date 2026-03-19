import Database from 'better-sqlite3'
import type { BackendAdapter, Job } from 'psyqueue'

export interface SyncEngineOpts {
  localPath: string
  remote: BackendAdapter
  maxLocalJobs?: number
  onEvent?: (event: string, data: Record<string, unknown>) => void
}

export class SyncEngine {
  private db: Database.Database
  private readonly remote: BackendAdapter
  private readonly maxLocalJobs: number
  private readonly onEvent?: (event: string, data: Record<string, unknown>) => void

  constructor(opts: SyncEngineOpts) {
    this.remote = opts.remote
    this.maxLocalJobs = opts.maxLocalJobs ?? 10000
    this.onEvent = opts.onEvent
    this.db = new Database(opts.localPath)
    this.init()
  }

  private init(): void {
    this.db.pragma('journal_mode = WAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS local_jobs (
        id TEXT PRIMARY KEY,
        queue TEXT NOT NULL,
        name TEXT NOT NULL,
        payload TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 0,
        max_retries INTEGER NOT NULL DEFAULT 3,
        timeout INTEGER NOT NULL DEFAULT 30000,
        idempotency_key TEXT,
        meta TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        synced INTEGER NOT NULL DEFAULT 0
      )
    `)
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_local_jobs_synced ON local_jobs(synced)
    `)
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_local_jobs_idempotency ON local_jobs(idempotency_key) WHERE idempotency_key IS NOT NULL
    `)
  }

  /**
   * Buffer a job locally. If remote is available, try to enqueue directly.
   * Returns the job ID.
   */
  async enqueueLocal(job: Job): Promise<string> {
    // Check buffer limit
    const countResult = this.db.prepare('SELECT COUNT(*) as cnt FROM local_jobs WHERE synced = 0').get() as { cnt: number }
    if (countResult.cnt >= this.maxLocalJobs) {
      throw new Error(`Local buffer full: ${countResult.cnt} unsynced jobs (max: ${this.maxLocalJobs})`)
    }

    // Check idempotency dedup
    if (job.idempotencyKey) {
      const existing = this.db.prepare('SELECT id FROM local_jobs WHERE idempotency_key = ?').get(job.idempotencyKey) as { id: string } | undefined
      if (existing) {
        this.onEvent?.('offline:dedup', { jobId: existing.id, idempotencyKey: job.idempotencyKey })
        return existing.id
      }
    }

    // Insert locally
    this.db.prepare(`
      INSERT INTO local_jobs (id, queue, name, payload, priority, max_retries, timeout, idempotency_key, meta, created_at, synced)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `).run(
      job.id,
      job.queue,
      job.name,
      JSON.stringify(job.payload),
      job.priority,
      job.maxRetries,
      job.timeout,
      job.idempotencyKey ?? null,
      JSON.stringify(job.meta),
      job.createdAt.toISOString(),
    )

    this.onEvent?.('offline:buffered', { jobId: job.id, queue: job.queue })
    return job.id
  }

  /**
   * Push all unsynced local jobs to the remote backend.
   * Returns the number of jobs synced.
   */
  async push(): Promise<number> {
    const unsynced = this.db.prepare(
      'SELECT * FROM local_jobs WHERE synced = 0 ORDER BY created_at ASC',
    ).all() as Array<{
      id: string
      queue: string
      name: string
      payload: string
      priority: number
      max_retries: number
      timeout: number
      idempotency_key: string | null
      meta: string
      created_at: string
    }>

    let synced = 0
    const markSynced = this.db.prepare('UPDATE local_jobs SET synced = 1 WHERE id = ?')

    for (const row of unsynced) {
      try {
        const job: Job = {
          id: row.id,
          queue: row.queue,
          name: row.name,
          payload: JSON.parse(row.payload),
          priority: row.priority,
          maxRetries: row.max_retries,
          timeout: row.timeout,
          attempt: 0,
          backoff: 'exponential',
          status: 'pending',
          createdAt: new Date(row.created_at),
          meta: JSON.parse(row.meta) as Record<string, unknown>,
          idempotencyKey: row.idempotency_key ?? undefined,
        }

        await this.remote.enqueue(job)
        markSynced.run(row.id)
        synced++
        this.onEvent?.('offline:synced', { jobId: row.id })
      } catch (_err) {
        // Remote still unavailable for this job, stop syncing
        this.onEvent?.('offline:sync-error', { jobId: row.id, error: _err instanceof Error ? _err.message : String(_err) })
        break
      }
    }

    return synced
  }

  /**
   * Get the count of unsynced local jobs.
   */
  unsyncedCount(): number {
    const result = this.db.prepare('SELECT COUNT(*) as cnt FROM local_jobs WHERE synced = 0').get() as { cnt: number }
    return result.cnt
  }

  /**
   * Get all local jobs (for inspection/debugging).
   */
  listLocal(): Array<{ id: string; queue: string; name: string; synced: boolean }> {
    const rows = this.db.prepare('SELECT id, queue, name, synced FROM local_jobs ORDER BY created_at ASC').all() as Array<{
      id: string
      queue: string
      name: string
      synced: number
    }>
    return rows.map((r) => ({
      id: r.id,
      queue: r.queue,
      name: r.name,
      synced: r.synced === 1,
    }))
  }

  /**
   * Close the local database.
   */
  close(): void {
    this.db.close()
  }
}
