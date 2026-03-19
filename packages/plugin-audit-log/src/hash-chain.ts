import { createHash } from 'node:crypto'
import type { AuditEntry } from './types.js'

/**
 * Compute SHA-256 hash of an audit entry combined with the previous hash.
 * The entry fields are serialized deterministically (excluding the 'hash' field).
 */
export function computeHash(entry: Omit<AuditEntry, 'hash'>, prevHash: string): string {
  const data = JSON.stringify({
    id: entry.id,
    timestamp: entry.timestamp,
    event: entry.event,
    jobId: entry.jobId,
    jobName: entry.jobName,
    queue: entry.queue,
    tenantId: entry.tenantId,
    payload: entry.payload,
    prevHash,
  })
  return createHash('sha256').update(data).digest('hex')
}

/**
 * Verify the integrity of an audit entry chain.
 * Returns true if all hashes are valid and chain is intact.
 */
export function verifyChain(entries: AuditEntry[]): boolean {
  if (entries.length === 0) return true

  let prevHash = ''
  for (const entry of entries) {
    const { hash, ...rest } = entry
    const expectedHash = computeHash(rest, prevHash)
    if (expectedHash !== hash) {
      return false
    }
    prevHash = hash
  }

  return true
}
