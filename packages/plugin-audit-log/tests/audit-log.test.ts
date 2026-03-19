import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { auditLog } from '../src/index.js'
import { verifyChain } from '../src/hash-chain.js'
import { PsyQueue } from 'psyqueue'
import { sqlite } from '../../backend-sqlite/src/index.js'

function makeQueue(pluginOpts: Parameters<typeof auditLog>[0]): {
  q: PsyQueue
  plugin: ReturnType<typeof auditLog>
} {
  const q = new PsyQueue()
  q.use(sqlite({ path: ':memory:' }))
  const plugin = auditLog(pluginOpts)
  q.use(plugin)
  return { q, plugin }
}

describe('auditLog plugin', () => {
  let q: PsyQueue
  let plugin: ReturnType<typeof auditLog>

  afterEach(async () => {
    await q.stop()
  })

  it('records an entry on enqueue (middleware event)', async () => {
    ;({ q, plugin } = makeQueue({ store: 'memory' }))
    q.handle('sendEmail', async () => 'ok')
    await q.start()

    await q.enqueue('sendEmail', { to: 'test@example.com' })

    const entries = plugin.audit.query({ event: 'enqueue' })
    expect(entries.length).toBeGreaterThanOrEqual(1)
    expect(entries[0]!.event).toBe('enqueue')
    expect(entries[0]!.jobName).toBe('sendEmail')
  })

  it('records an entry on process (middleware event)', async () => {
    ;({ q, plugin } = makeQueue({ store: 'memory' }))
    q.handle('processJob', async () => 'done')
    await q.start()

    await q.enqueue('processJob', {})
    await q.processNext('processJob')

    const entries = plugin.audit.query({ event: 'process' })
    expect(entries.length).toBeGreaterThanOrEqual(1)
    expect(entries[0]!.event).toBe('process')
  })

  it('records job:completed event from bus', async () => {
    ;({ q, plugin } = makeQueue({ store: 'memory' }))
    q.handle('job', async () => 'done')
    await q.start()

    await q.enqueue('job', {})
    await q.processNext('job')

    const completedEntries = plugin.audit.query({ event: 'job:completed' })
    expect(completedEntries.length).toBeGreaterThanOrEqual(1)
  })

  it('records job:failed event from bus on failure', async () => {
    ;({ q, plugin } = makeQueue({ store: 'memory' }))
    q.handle('badJob', async () => {
      throw new Error('intentional failure')
    })
    await q.start()

    await q.enqueue('badJob', {}, { maxRetries: 0 })
    await q.processNext('badJob')

    const failedEntries = plugin.audit.query({ event: 'job:failed' })
    expect(failedEntries.length).toBeGreaterThanOrEqual(1)
  })

  it('hash chain is valid for sequential entries', async () => {
    ;({ q, plugin } = makeQueue({ store: 'memory', hashChain: true }))
    q.handle('job', async () => 'ok')
    await q.start()

    await q.enqueue('job', {})
    await q.enqueue('job', {})
    await q.processNext('job')

    const entries = plugin.audit.query()
    expect(entries.length).toBeGreaterThanOrEqual(3)

    const valid = verifyChain(entries)
    expect(valid).toBe(true)
  })

  it('tampered entry breaks hash chain', async () => {
    ;({ q, plugin } = makeQueue({ store: 'memory', hashChain: true }))
    q.handle('job', async () => 'ok')
    await q.start()

    await q.enqueue('job', {})
    await q.enqueue('job', {})

    const entries = plugin.audit.query()
    expect(entries.length).toBeGreaterThanOrEqual(2)

    // Tamper with the first entry's event field
    const tampered = entries.map((e, i) =>
      i === 0 ? { ...e, event: 'TAMPERED' } : e,
    )

    const valid = verifyChain(tampered)
    expect(valid).toBe(false)
  })

  it('excludes payload when includePayload is false', async () => {
    ;({ q, plugin } = makeQueue({ store: 'memory', includePayload: false }))
    q.handle('job', async () => 'ok')
    await q.start()

    await q.enqueue('job', { secret: 'password123' })

    const entries = plugin.audit.query({ event: 'enqueue' })
    expect(entries.length).toBeGreaterThanOrEqual(1)
    expect(entries[0]!.payload).toBeUndefined()
  })

  it('includes payload when includePayload is true', async () => {
    ;({ q, plugin } = makeQueue({ store: 'memory', includePayload: true }))
    q.handle('job', async () => 'ok')
    await q.start()

    await q.enqueue('job', { userId: 42 })

    const entries = plugin.audit.query({ event: 'enqueue' })
    expect(entries.length).toBeGreaterThanOrEqual(1)
    expect(entries[0]!.payload).toEqual({ userId: 42 })
  })

  it('only records filtered events when events array is specified', async () => {
    ;({ q, plugin } = makeQueue({ store: 'memory', events: ['enqueue'] }))
    q.handle('job', async () => 'ok')
    await q.start()

    await q.enqueue('job', {})
    await q.processNext('job')

    const allEntries = plugin.audit.query()
    // Should only have enqueue entries — no process, no job:completed, etc.
    const nonEnqueueEntries = allEntries.filter(e => e.event !== 'enqueue')
    const enqueueEntries = allEntries.filter(e => e.event === 'enqueue')

    expect(enqueueEntries.length).toBeGreaterThanOrEqual(1)
    expect(nonEnqueueEntries).toHaveLength(0)
  })

  it('memory store query works with jobId filter', async () => {
    ;({ q, plugin } = makeQueue({ store: 'memory' }))
    q.handle('job', async () => 'ok')
    await q.start()

    const id1 = await q.enqueue('job', {})
    const id2 = await q.enqueue('job', {})

    const entriesForJob1 = plugin.audit.query({ jobId: id1 })
    const entriesForJob2 = plugin.audit.query({ jobId: id2 })

    expect(entriesForJob1.length).toBeGreaterThanOrEqual(1)
    expect(entriesForJob2.length).toBeGreaterThanOrEqual(1)
    expect(entriesForJob1.every(e => e.jobId === id1)).toBe(true)
    expect(entriesForJob2.every(e => e.jobId === id2)).toBe(true)
  })

  it('memory store query works with queue filter', async () => {
    ;({ q, plugin } = makeQueue({ store: 'memory' }))
    q.handle('job', async () => 'ok')
    await q.start()

    await q.enqueue('job', {}, { queue: 'queue-a' })
    await q.enqueue('job', {}, { queue: 'queue-b' })

    const entriesA = plugin.audit.query({ queue: 'queue-a' })
    const entriesB = plugin.audit.query({ queue: 'queue-b' })

    expect(entriesA.length).toBeGreaterThanOrEqual(1)
    expect(entriesB.length).toBeGreaterThanOrEqual(1)
    expect(entriesA.every(e => e.queue === 'queue-a')).toBe(true)
    expect(entriesB.every(e => e.queue === 'queue-b')).toBe(true)
  })

  it('audit.verify returns true for intact chain', async () => {
    ;({ q, plugin } = makeQueue({ store: 'memory', hashChain: true }))
    q.handle('job', async () => 'ok')
    await q.start()

    await q.enqueue('job', {})
    await q.enqueue('job', {})

    const valid = plugin.audit.verify()
    expect(valid).toBe(true)
  })
})
