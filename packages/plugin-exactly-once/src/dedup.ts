export interface DedupEntry {
  jobId: string
  expiresAt: number
}

/**
 * In-memory deduplication store with window-based expiry.
 *
 * Handles the common case of duplicate webhook retries and network retry
 * storms. The window-based expiry naturally cleans up stale entries.
 */
export class DedupStore {
  private readonly keys = new Map<string, DedupEntry>()

  /**
   * Returns the existing jobId if the key exists and has not expired.
   * Automatically deletes the entry if it has expired.
   */
  check(key: string): string | null {
    const entry = this.keys.get(key)
    if (!entry) return null
    if (Date.now() > entry.expiresAt) {
      this.keys.delete(key)
      return null
    }
    return entry.jobId
  }

  /**
   * Stores a new dedup key mapping to the given jobId, expiring after windowMs.
   */
  store(key: string, jobId: string, windowMs: number): void {
    this.keys.set(key, { jobId, expiresAt: Date.now() + windowMs })
  }

  /**
   * Removes a specific key from the store.
   */
  remove(key: string): void {
    this.keys.delete(key)
  }

  /**
   * Removes all expired entries and returns the count of entries deleted.
   */
  cleanup(): number {
    const now = Date.now()
    let count = 0
    for (const [key, entry] of this.keys) {
      if (now > entry.expiresAt) {
        this.keys.delete(key)
        count++
      }
    }
    return count
  }

  /**
   * Returns the current number of entries (including potentially expired ones
   * that haven't been cleaned up yet).
   */
  get size(): number {
    return this.keys.size
  }
}
