import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { WriteAheadLog } from '../src/wal.js'
import { tmpdir } from 'os'
import { join } from 'path'
import { mkdtempSync, rmSync } from 'fs'

describe('WriteAheadLog', () => {
  let tmpDir: string
  let walPath: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'psyqueue-wal-'))
    walPath = join(tmpDir, 'test.wal')
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true })
  })

  it('writes and reads entries', () => {
    const wal = new WriteAheadLog(walPath)
    wal.writeEntry({ jobId: 'j1', status: 'active', timestamp: Date.now() })
    wal.writeEntry({ jobId: 'j1', status: 'completed', timestamp: Date.now() })
    const entries = wal.readEntries()
    expect(entries).toHaveLength(2)
    expect(entries[0]!.jobId).toBe('j1')
    expect(entries[0]!.status).toBe('active')
    expect(entries[1]!.status).toBe('completed')
    wal.close()
  })

  it('persists entries across instances (survives crash)', () => {
    const wal1 = new WriteAheadLog(walPath)
    wal1.writeEntry({ jobId: 'j1', status: 'active', timestamp: Date.now() })
    wal1.close()

    const wal2 = new WriteAheadLog(walPath)
    const entries = wal2.readEntries()
    expect(entries).toHaveLength(1)
    expect(entries[0]!.jobId).toBe('j1')
    wal2.close()
  })

  it('clear() removes all entries', () => {
    const wal = new WriteAheadLog(walPath)
    wal.writeEntry({ jobId: 'j1', status: 'active', timestamp: Date.now() })
    wal.clear()
    expect(wal.readEntries()).toHaveLength(0)
    wal.close()
  })

  it('handles empty file gracefully', () => {
    const wal = new WriteAheadLog(walPath)
    expect(wal.readEntries()).toHaveLength(0)
    wal.close()
  })

  it('stores and retrieves workerId field', () => {
    const wal = new WriteAheadLog(walPath)
    wal.writeEntry({ jobId: 'j1', status: 'active', timestamp: 1000, workerId: 'worker-1' })
    const entries = wal.readEntries()
    expect(entries[0]!.workerId).toBe('worker-1')
    wal.close()
  })

  it('can append multiple jobs interleaved', () => {
    const wal = new WriteAheadLog(walPath)
    wal.writeEntry({ jobId: 'j1', status: 'active', timestamp: 1 })
    wal.writeEntry({ jobId: 'j2', status: 'active', timestamp: 2 })
    wal.writeEntry({ jobId: 'j1', status: 'completed', timestamp: 3 })
    wal.writeEntry({ jobId: 'j2', status: 'failed', timestamp: 4 })
    const entries = wal.readEntries()
    expect(entries).toHaveLength(4)
    expect(entries.map(e => e.jobId)).toEqual(['j1', 'j2', 'j1', 'j2'])
    wal.close()
  })

  it('clear() allows writing new entries afterwards', () => {
    const wal = new WriteAheadLog(walPath)
    wal.writeEntry({ jobId: 'j1', status: 'active', timestamp: 1 })
    wal.clear()
    wal.writeEntry({ jobId: 'j2', status: 'active', timestamp: 2 })
    const entries = wal.readEntries()
    expect(entries).toHaveLength(1)
    expect(entries[0]!.jobId).toBe('j2')
    wal.close()
  })

  it('two separate instances both see the same persisted data', () => {
    const wal1 = new WriteAheadLog(walPath)
    wal1.writeEntry({ jobId: 'j1', status: 'active', timestamp: 10 })
    wal1.writeEntry({ jobId: 'j2', status: 'completed', timestamp: 20 })
    wal1.close()

    const wal2 = new WriteAheadLog(walPath)
    const entries = wal2.readEntries()
    expect(entries).toHaveLength(2)
    expect(entries[1]!.status).toBe('completed')
    wal2.close()
  })
})
