import type { WriteAheadLog } from './wal.js'

export interface RecoveryBackend {
  nack(jobId: string, opts?: { requeue?: boolean; deadLetter?: boolean; reason?: string }): Promise<void>
}

export interface RecoveryOpts {
  onRecoverActiveJob?:
    | 'requeue'
    | 'fail'
    | ((job: { jobId: string; attempt: number }) => Promise<'requeue' | 'fail' | 'dead-letter'>)
}

/**
 * Scan the WAL and recover any orphaned active jobs.
 *
 * Algorithm:
 *   1. Read all WAL entries.
 *   2. Group entries by jobId.
 *   3. For each jobId find the latest entry (by timestamp).
 *   4. If the latest entry status is 'active', the job was orphaned (process
 *      crashed before writing 'completed' or 'failed').
 *   5. Apply the configured recovery action.
 *   6. Clear the WAL so we start fresh.
 *
 * Returns the list of recovered job IDs.
 */
export async function recoverFromWal(
  wal: WriteAheadLog,
  backend: RecoveryBackend,
  opts: RecoveryOpts,
): Promise<string[]> {
  const entries = wal.readEntries()

  // Group entries by jobId, preserving insertion order
  const grouped = new Map<string, typeof entries>()
  for (const entry of entries) {
    if (!grouped.has(entry.jobId)) {
      grouped.set(entry.jobId, [])
    }
    grouped.get(entry.jobId)!.push(entry)
  }

  const recovered: string[] = []

  for (const [jobId, jobEntries] of grouped) {
    // Find the latest entry by timestamp
    const latest = jobEntries.reduce((prev, curr) =>
      curr.timestamp >= prev.timestamp ? curr : prev,
    )

    if (latest.status !== 'active') {
      // Job completed or failed normally — nothing to recover
      continue
    }

    // Job was orphaned — apply recovery action
    const action = opts.onRecoverActiveJob ?? 'requeue'

    let decision: 'requeue' | 'fail' | 'dead-letter'
    if (typeof action === 'function') {
      decision = await action({ jobId, attempt: 0 })
    } else {
      decision = action
    }

    if (decision === 'requeue') {
      await backend.nack(jobId, { requeue: true })
    } else if (decision === 'dead-letter') {
      await backend.nack(jobId, { requeue: false, deadLetter: true })
    } else {
      // 'fail'
      await backend.nack(jobId, { requeue: false })
    }

    recovered.push(jobId)
  }

  // Clear the WAL after a successful recovery pass
  wal.clear()

  return recovered
}
