import { appendFileSync, readFileSync, writeFileSync, openSync, closeSync, existsSync } from 'fs'

export interface WalEntry {
  jobId: string
  status: 'active' | 'completed' | 'failed'
  timestamp: number
  workerId?: string
}

export class WriteAheadLog {
  private readonly filePath: string
  private fd: number

  constructor(filePath: string) {
    this.filePath = filePath
    // Open or create the file; flag 'a' creates if not exists and positions at end
    this.fd = openSync(filePath, 'a')
  }

  /**
   * Append a WAL entry as a JSON line to the file.
   * Uses appendFileSync for durability (no buffering).
   */
  writeEntry(entry: WalEntry): void {
    appendFileSync(this.filePath, JSON.stringify(entry) + '\n', { encoding: 'utf8' })
  }

  /**
   * Read all entries from the WAL file.
   * Returns an empty array if the file is empty or does not exist.
   */
  readEntries(): WalEntry[] {
    if (!existsSync(this.filePath)) {
      return []
    }

    const content = readFileSync(this.filePath, { encoding: 'utf8' })
    if (!content.trim()) {
      return []
    }

    const entries: WalEntry[] = []
    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        entries.push(JSON.parse(trimmed) as WalEntry)
      } catch {
        // Skip malformed lines (e.g. partial write at time of crash)
      }
    }
    return entries
  }

  /**
   * Truncate the WAL file, removing all entries.
   * Called after successful recovery.
   */
  clear(): void {
    writeFileSync(this.filePath, '', { encoding: 'utf8' })
  }

  /**
   * Close the underlying file descriptor.
   */
  close(): void {
    try {
      closeSync(this.fd)
    } catch {
      // Ignore errors on close (e.g. already closed)
    }
  }
}
