import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { PsyQueue } from '@psyqueue/core'
import { sqlite } from '../../backend-sqlite/src/index.js'
import { workflows, workflow } from '../../plugin-workflows/src/index.js'
import type { WorkflowEngine, WorkflowDefinition } from '../../plugin-workflows/src/index.js'
import { saga } from '../src/index.js'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const once = { maxRetries: 1 } // single attempt: fail straight to dead-letter

describe('Saga compensation', () => {
  let q: PsyQueue
  let engine: WorkflowEngine

  beforeEach(async () => {
    q = new PsyQueue()
    const wfPlugin = workflows()
    engine = wfPlugin.engine
    q.use(sqlite({ path: ':memory:' }))
    q.use(wfPlugin)
    q.use(saga())
    await q.start()
  })

  afterEach(async () => {
    await q.stop()
  })

  function setup(wf: WorkflowDefinition): void {
    engine.registerDefinition(wf)
    q.handle(wf.name, engine.createHandler(wf.name))
  }

  /** Process jobs until the queue stays empty (steps and compensation jobs). */
  async function drain(queue: string): Promise<void> {
    for (let idle = 0; idle < 3;) {
      if (await q.processNext(queue)) idle = 0
      else { idle++; await sleep(5) }
    }
  }

  it('compensates completed steps in reverse order when a step fails', async () => {
    const compensations: string[] = []
    setup(workflow('booking')
      .step('flight', async () => ({ id: 'FL1' }), { compensate: async () => { compensations.push('flight') } })
      .step('hotel', async () => ({ id: 'HT1' }), { after: 'flight', compensate: async () => { compensations.push('hotel') } })
      .step('payment', async () => { throw new Error('declined') }, { after: 'hotel', ...once })
      .build())

    const id = await q.enqueue('booking', {})
    await drain('booking')

    expect(compensations).toEqual(['hotel', 'flight'])
    expect((await engine.store.get(id))!.status).toBe('COMPENSATED')
  })

  it('does not compensate the failed step or steps without a compensate handler', async () => {
    const compensated: string[] = []
    setup(workflow('partial')
      .step('a', async () => 1, { compensate: async () => { compensated.push('a') } })
      .step('b', async () => 2, { after: 'a' })
      .step('c', async () => { throw new Error('boom') }, { after: 'b', ...once, compensate: async () => { compensated.push('c') } })
      .build())

    await q.enqueue('partial', {})
    await drain('partial')
    expect(compensated).toEqual(['a'])
  })

  it('passes the original step results to compensate handlers', async () => {
    let seen: unknown
    setup(workflow('results')
      .step('reserve', async () => ({ ref: 'R-1' }), { compensate: async (ctx) => { seen = ctx.results?.['reserve'] } })
      .step('fail', async () => { throw new Error('x') }, { after: 'reserve', ...once })
      .build())

    await q.enqueue('results', {})
    await drain('results')
    expect(seen).toEqual({ ref: 'R-1' })
  })

  it('emits compensating and compensated events with the workflow id', async () => {
    const events: Array<[string, unknown]> = []
    for (const name of ['workflow:failed', 'workflow:compensating', 'workflow:compensated']) {
      q.events.on(name, e => { events.push([name, (e.data as { workflowId: string }).workflowId]) })
    }
    setup(workflow('events')
      .step('a', async () => 1, { compensate: async () => {} })
      .step('b', async () => { throw new Error('x') }, { after: 'a', ...once })
      .build())

    const id = await q.enqueue('events', {})
    await drain('events')
    expect(events).toEqual([['workflow:failed', id], ['workflow:compensating', id], ['workflow:compensated', id]])
  })

  it('keeps compensating the remaining steps when one compensation fails', async () => {
    const compensated: string[] = []
    let failedEvent: unknown
    q.events.on('workflow:compensation-failed', e => { failedEvent = e.data })
    setup(workflow('continue')
      .step('a', async () => 1, { compensate: async () => { compensated.push('a') } })
      .step('b', async () => 2, { after: 'a', ...once, compensate: async () => { throw new Error('refund API down') } })
      .step('c', async () => { throw new Error('x') }, { after: 'b', ...once })
      .build())

    const id = await q.enqueue('continue', {})
    await drain('continue')

    expect(compensated).toEqual(['a'])
    const inst = (await engine.store.get(id))!
    expect(inst.status).toBe('COMPENSATION_FAILED')
    expect(inst.compensation).toMatchObject({ done: ['a'], failed: ['b'], pending: [] })
    expect(failedEvent).toMatchObject({ workflowId: id, failedSteps: ['b'] })
  })

  it('retries a flaky compensation before giving up', async () => {
    let attempts = 0
    setup(workflow('flaky-comp')
      .step('a', async () => 1, { maxRetries: 3, backoff: 'fixed', backoffBase: 1, compensate: async () => {
        if (++attempts < 3) throw new Error('timeout')
      } })
      .step('b', async () => { throw new Error('x') }, { after: 'a', ...once })
      .build())

    const id = await q.enqueue('flaky-comp', {})
    await drain('flaky-comp')
    expect(attempts).toBe(3)
    expect((await engine.store.get(id))!.status).toBe('COMPENSATED')
  })

  it('compensates a parallel step that finishes after its sibling failed', async () => {
    const compensated: string[] = []
    setup(workflow('parallel')
      .step('slow', async () => { await sleep(150); return 'S' }, { compensate: async () => { compensated.push('slow') } })
      .step('bad', async () => { throw new Error('x') }, once)
      .build())

    const id = await q.enqueue('parallel', {})
    q.startWorker('parallel', { concurrency: 2, pollInterval: 5 })
    const deadline = Date.now() + 3000
    while (Date.now() < deadline) {
      const s = (await engine.store.get(id))!.status
      if (s === 'COMPENSATED' || s === 'COMPENSATION_FAILED') break
      await sleep(20)
    }
    expect(compensated).toEqual(['slow'])
    expect((await engine.store.get(id))!.status).toBe('COMPENSATED')
  })

  it('compensates in reverse completion order, not definition order', async () => {
    const compensated: string[] = []
    // 'early' is defined first but completes last
    setup(workflow('order')
      .step('early', async () => { await sleep(80); return 1 }, { compensate: async () => { compensated.push('early') } })
      .step('late', async () => 2, { compensate: async () => { compensated.push('late') } })
      .step('fail', async () => { throw new Error('x') }, { after: ['early', 'late'], ...once })
      .build())

    const id = await q.enqueue('order', {})
    q.startWorker('order', { concurrency: 2, pollInterval: 5 })
    const deadline = Date.now() + 3000
    while (Date.now() < deadline && (await engine.store.get(id))!.status !== 'COMPENSATED') await sleep(20)
    expect(compensated).toEqual(['early', 'late'])
  })
})
