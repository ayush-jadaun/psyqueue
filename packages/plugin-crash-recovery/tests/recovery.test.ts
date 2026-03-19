import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { WriteAheadLog } from '../src/wal.js'
import { recoverFromWal, type RecoveryBackend } from '../src/recovery.js'
import { tmpdir } from 'os'
import { join } from 'path'
import { mkdtempSync, rmSync } from 'fs'

describe('Recovery', () => {
  let tmpDir: string
  let walPath: string
  let wal: WriteAheadLog
  let mockBackend: RecoveryBackend

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'psyqueue-recovery-'))
    walPath = join(tmpDir, 'recovery.wal')
    wal = new WriteAheadLog(walPath)
    mockBackend = {
      nack: vi.fn(async () => {}),
    }
  })

  afterEach(() => {
    wal.close()
    rmSync(tmpDir, { recursive: true })
  })

  it('detects orphaned active jobs and requeues them', async () => {
    wal.writeEntry({ jobId: 'j1', status: 'active', timestamp: Date.now() })
    const recovered = await recoverFromWal(wal, mockBackend, { onRecoverActiveJob: 'requeue' })
    expect(recovered).toEqual(['j1'])
    expect(mockBackend.nack).toHaveBeenCalledWith('j1', expect.objectContaining({ requeue: true }))
  })

  it('does not recover jobs that completed normally', async () => {
    wal.writeEntry({ jobId: 'j1', status: 'active', timestamp: 1 })
    wal.writeEntry({ jobId: 'j1', status: 'completed', timestamp: 2 })
    const recovered = await recoverFromWal(wal, mockBackend, { onRecoverActiveJob: 'requeue' })
    expect(recovered).toEqual([])
    expect(mockBackend.nack).not.toHaveBeenCalled()
  })

  it('does not recover jobs that failed normally', async () => {
    wal.writeEntry({ jobId: 'j1', status: 'active', timestamp: 1 })
    wal.writeEntry({ jobId: 'j1', status: 'failed', timestamp: 2 })
    const recovered = await recoverFromWal(wal, mockBackend, { onRecoverActiveJob: 'requeue' })
    expect(recovered).toEqual([])
    expect(mockBackend.nack).not.toHaveBeenCalled()
  })

  it('respects onRecoverActiveJob: fail', async () => {
    wal.writeEntry({ jobId: 'j1', status: 'active', timestamp: Date.now() })
    await recoverFromWal(wal, mockBackend, { onRecoverActiveJob: 'fail' })
    expect(mockBackend.nack).toHaveBeenCalledWith('j1', expect.objectContaining({ requeue: false }))
  })

  it('supports custom recovery function returning requeue', async () => {
    wal.writeEntry({ jobId: 'j1', status: 'active', timestamp: Date.now() })
    const custom = vi.fn(async () => 'requeue' as const)
    const recovered = await recoverFromWal(wal, mockBackend, { onRecoverActiveJob: custom })
    expect(custom).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'j1' }))
    expect(recovered).toEqual(['j1'])
    expect(mockBackend.nack).toHaveBeenCalledWith('j1', expect.objectContaining({ requeue: true }))
  })

  it('supports custom recovery function returning dead-letter', async () => {
    wal.writeEntry({ jobId: 'j1', status: 'active', timestamp: Date.now() })
    const custom = vi.fn(async () => 'dead-letter' as const)
    await recoverFromWal(wal, mockBackend, { onRecoverActiveJob: custom })
    expect(custom).toHaveBeenCalled()
    expect(mockBackend.nack).toHaveBeenCalledWith('j1', expect.objectContaining({ deadLetter: true }))
  })

  it('supports custom recovery function returning fail', async () => {
    wal.writeEntry({ jobId: 'j1', status: 'active', timestamp: Date.now() })
    const custom = vi.fn(async () => 'fail' as const)
    await recoverFromWal(wal, mockBackend, { onRecoverActiveJob: custom })
    expect(custom).toHaveBeenCalled()
    expect(mockBackend.nack).toHaveBeenCalledWith('j1', expect.objectContaining({ requeue: false }))
  })

  it('clears WAL after successful recovery', async () => {
    wal.writeEntry({ jobId: 'j1', status: 'active', timestamp: Date.now() })
    await recoverFromWal(wal, mockBackend, { onRecoverActiveJob: 'requeue' })
    expect(wal.readEntries()).toHaveLength(0)
  })

  it('recovers multiple orphaned jobs', async () => {
    wal.writeEntry({ jobId: 'j1', status: 'active', timestamp: 1 })
    wal.writeEntry({ jobId: 'j2', status: 'active', timestamp: 2 })
    wal.writeEntry({ jobId: 'j2', status: 'completed', timestamp: 3 }) // j2 completed
    const recovered = await recoverFromWal(wal, mockBackend, { onRecoverActiveJob: 'requeue' })
    expect(recovered).toEqual(['j1']) // only j1 orphaned
    expect(mockBackend.nack).toHaveBeenCalledTimes(1)
    expect(mockBackend.nack).toHaveBeenCalledWith('j1', expect.objectContaining({ requeue: true }))
  })

  it('returns empty array when WAL is empty', async () => {
    const recovered = await recoverFromWal(wal, mockBackend, { onRecoverActiveJob: 'requeue' })
    expect(recovered).toEqual([])
    expect(mockBackend.nack).not.toHaveBeenCalled()
  })

  it('uses latest timestamp entry to determine job state', async () => {
    // Simulates a re-queued job that was active again at crash
    const t = Date.now()
    wal.writeEntry({ jobId: 'j1', status: 'active', timestamp: t })
    wal.writeEntry({ jobId: 'j1', status: 'completed', timestamp: t + 100 })
    wal.writeEntry({ jobId: 'j1', status: 'active', timestamp: t + 200 }) // second attempt was active at crash
    const recovered = await recoverFromWal(wal, mockBackend, { onRecoverActiveJob: 'requeue' })
    expect(recovered).toEqual(['j1'])
  })

  it('clears WAL even if no orphaned jobs were found', async () => {
    wal.writeEntry({ jobId: 'j1', status: 'active', timestamp: 1 })
    wal.writeEntry({ jobId: 'j1', status: 'completed', timestamp: 2 })
    await recoverFromWal(wal, mockBackend, { onRecoverActiveJob: 'requeue' })
    expect(wal.readEntries()).toHaveLength(0)
  })
})
