import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { PsyQueue } from '@psyqueue/core'
import { sqlite } from '../../backend-sqlite/src/index.js'
import { workflows, workflow } from '../../plugin-workflows/src/index.js'
import type { WorkflowEngine } from '../../plugin-workflows/src/index.js'
import { saga } from '../src/index.js'

/**
 * Flush the microtask / timer queue to let async event handlers run.
 * The workflow engine advances the DAG via async event handlers that are
 * fired but not awaited, so we need a small timeout to let them settle.
 */
function tick(ms = 20): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

describe('Saga Compensation Plugin', () => {
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

  // Helper: register workflow definition and handler
  function setup(wf: ReturnType<typeof workflow>['build'] extends (...args: never[]) => infer R ? R : never): void {
    // The build() return type is WorkflowDefinition
    engine.registerDefinition(wf as Parameters<typeof engine.registerDefinition>[0])
    q.handle(wf.name, engine.createHandler(wf.name))
  }

  // ─── Test 1: Reverse order compensation ────────────────────────────────────

  it('runs compensation in reverse order when a step fails', async () => {
    const compensations: string[] = []

    const wf = workflow('booking')
      .step('flight', async () => ({ id: 'FL1' }), {
        compensate: async () => { compensations.push('cancel-flight') },
      })
      .step('hotel', async () => ({ id: 'HT1' }), {
        after: 'flight',
        compensate: async () => { compensations.push('cancel-hotel') },
      })
      .step('payment', async () => { throw new Error('declined') }, {
        after: 'hotel',
      })
      .build()

    setup(wf)

    await q.enqueue('booking', { customer: 'test' })

    // Process flight (success)
    await q.processNext('booking')
    await tick()

    // Process hotel (success)
    await q.processNext('booking')
    await tick()

    // Process payment (fails — maxRetries: 0 so goes dead immediately)
    await q.processNext('booking')
    await tick()

    // Wait for async compensation to run
    await tick(100)

    // Compensation should run in reverse: hotel first, then flight
    expect(compensations).toEqual(['cancel-hotel', 'cancel-flight'])
  })

  // ─── Test 2: Failed step is not compensated ─────────────────────────────────

  it('does not compensate the failed step itself', async () => {
    const compensated: string[] = []

    const wf = workflow('no-comp-fail')
      .step('ok', async () => 'done', {
        compensate: async () => { compensated.push('ok') },
      })
      .step('fail', async () => { throw new Error('boom') }, {
        after: 'ok',
        compensate: async () => { compensated.push('fail') },
      })
      .build()

    setup(wf)

    await q.enqueue('no-comp-fail', {})
    await q.processNext('no-comp-fail') // ok -> success
    await tick()
    await q.processNext('no-comp-fail') // fail -> dead
    await tick(100)

    // Only 'ok' should be compensated; 'fail' never completed
    expect(compensated).toEqual(['ok'])
  })

  // ─── Test 3: Status set to COMPENSATED ─────────────────────────────────────

  it('sets workflow status to COMPENSATED on successful compensation', async () => {
    const wf = workflow('comp-success')
      .step('a', async () => 'done', {
        compensate: async () => { /* no-op */ },
      })
      .step('b', async () => { throw new Error('boom') }, { after: 'a' })
      .build()

    setup(wf)

    const wfId = await q.enqueue('comp-success', {})
    await q.processNext('comp-success') // a -> success
    await tick()
    await q.processNext('comp-success') // b -> dead
    await tick(100)

    const instance = engine.store.get(wfId)
    expect(instance?.status).toBe('COMPENSATED')
  })

  // ─── Test 4: Status set to COMPENSATION_FAILED ─────────────────────────────

  it('sets workflow status to COMPENSATION_FAILED if compensation throws', async () => {
    const wf = workflow('comp-fail')
      .step('a', async () => 'done', {
        compensate: async () => { throw new Error('compensation failed') },
      })
      .step('b', async () => { throw new Error('boom') }, { after: 'a' })
      .build()

    setup(wf)

    const wfId = await q.enqueue('comp-fail', {})
    await q.processNext('comp-fail') // a -> success
    await tick()
    await q.processNext('comp-fail') // b -> dead
    await tick(100)

    const instance = engine.store.get(wfId)
    expect(instance?.status).toBe('COMPENSATION_FAILED')
  })

  // ─── Test 5: Events emitted ─────────────────────────────────────────────────

  it('emits workflow:compensating and workflow:compensated events', async () => {
    const emittedEvents: string[] = []
    q.events.on('workflow:compensating', () => emittedEvents.push('compensating'))
    q.events.on('workflow:compensated', () => emittedEvents.push('compensated'))

    const wf = workflow('ev-comp')
      .step('a', async () => 'done', {
        compensate: async () => { /* no-op */ },
      })
      .step('b', async () => { throw new Error('fail') }, { after: 'a' })
      .build()

    setup(wf)

    await q.enqueue('ev-comp', {})
    await q.processNext('ev-comp')
    await tick()
    await q.processNext('ev-comp')
    await tick(100)

    expect(emittedEvents).toContain('compensating')
    expect(emittedEvents).toContain('compensated')
  })

  // ─── Test 6: workflow:compensation-failed event ─────────────────────────────

  it('emits workflow:compensation-failed when a compensation handler throws', async () => {
    const emittedEvents: string[] = []
    q.events.on('workflow:compensation-failed', () => emittedEvents.push('compensation-failed'))

    const wf = workflow('ev-comp-fail')
      .step('a', async () => 'done', {
        compensate: async () => { throw new Error('oops') },
      })
      .step('b', async () => { throw new Error('fail') }, { after: 'a' })
      .build()

    setup(wf)

    await q.enqueue('ev-comp-fail', {})
    await q.processNext('ev-comp-fail')
    await tick()
    await q.processNext('ev-comp-fail')
    await tick(100)

    expect(emittedEvents).toContain('compensation-failed')
  })

  // ─── Test 7: Skips steps without compensate handler ────────────────────────

  it('skips steps without compensate handler', async () => {
    const compensated: string[] = []

    const wf = workflow('partial-comp')
      .step('a', async () => 'result-a', {
        compensate: async () => { compensated.push('a') },
      })
      .step('b', async () => 'result-b', {
        after: 'a',
        // No compensate handler
      })
      .step('c', async () => { throw new Error('fail') }, {
        after: 'b',
      })
      .build()

    setup(wf)

    await q.enqueue('partial-comp', {})
    await q.processNext('partial-comp') // a -> success
    await tick()
    await q.processNext('partial-comp') // b -> success
    await tick()
    await q.processNext('partial-comp') // c -> dead
    await tick(100)

    // Only 'a' has a compensate handler; 'b' does not; 'c' failed
    expect(compensated).toEqual(['a'])
  })

  // ─── Test 8: Compensation receives original step results ───────────────────

  it('compensation receives original step results', async () => {
    let receivedResult: unknown

    const wf = workflow('result-comp')
      .step('a', async () => ({ bookingRef: 'XYZ' }), {
        compensate: async (ctx) => {
          receivedResult = ctx.results?.['a']
        },
      })
      .step('b', async () => { throw new Error('fail') }, { after: 'a' })
      .build()

    setup(wf)

    await q.enqueue('result-comp', {})
    await q.processNext('result-comp') // a -> success
    await tick()
    await q.processNext('result-comp') // b -> dead
    await tick(100)

    expect(receivedResult).toEqual({ bookingRef: 'XYZ' })
  })

  // ─── Test 9: No compensation when no completed steps ───────────────────────

  it('handles workflows where the first step fails gracefully', async () => {
    const compensated: string[] = []

    const wf = workflow('first-fail')
      .step('only', async () => { throw new Error('fail') }, {
        compensate: async () => { compensated.push('only') },
      })
      .build()

    setup(wf)

    const wfId = await q.enqueue('first-fail', {})
    await q.processNext('first-fail') // only -> dead
    await tick(100)

    // The step never completed so nothing to compensate
    expect(compensated).toEqual([])
    // Workflow should still be FAILED (no compensation ran), or could be COMPENSATED
    // Since no steps have completed, COMPENSATED is valid (vacuous truth)
    const instance = engine.store.get(wfId)
    expect(['COMPENSATED', 'FAILED']).toContain(instance?.status)
  })

  // ─── Test 10: Three-step chain in correct reverse order ────────────────────

  it('compensates a three-step chain in strict reverse order', async () => {
    const order: string[] = []

    const wf = workflow('three-chain')
      .step('step1', async () => 'r1', {
        compensate: async () => { order.push('undo-step1') },
      })
      .step('step2', async () => 'r2', {
        after: 'step1',
        compensate: async () => { order.push('undo-step2') },
      })
      .step('step3', async () => { throw new Error('fail') }, {
        after: 'step2',
        compensate: async () => { order.push('undo-step3') },
      })
      .build()

    setup(wf)

    await q.enqueue('three-chain', {})
    await q.processNext('three-chain') // step1
    await tick()
    await q.processNext('three-chain') // step2
    await tick()
    await q.processNext('three-chain') // step3 fails
    await tick(100)

    // step3 failed (not compensated); step2 and step1 completed
    // Reverse order: undo-step2 first, then undo-step1
    expect(order).toEqual(['undo-step2', 'undo-step1'])
  })

  // ─── Test 11: workflowId in compensation event data ────────────────────────

  it('emits compensation events with correct workflowId', async () => {
    const compensatingData: unknown[] = []
    q.events.on('workflow:compensating', (e) => compensatingData.push(e.data))

    const wf = workflow('ev-data-comp')
      .step('x', async () => 'ok', {
        compensate: async () => { /* no-op */ },
      })
      .step('y', async () => { throw new Error('fail') }, { after: 'x' })
      .build()

    setup(wf)

    const wfId = await q.enqueue('ev-data-comp', {})
    await q.processNext('ev-data-comp')
    await tick()
    await q.processNext('ev-data-comp')
    await tick(100)

    expect(compensatingData.length).toBeGreaterThanOrEqual(1)
    const data = compensatingData[0] as Record<string, unknown>
    expect(data['workflowId']).toBe(wfId)
    expect(data['definitionName']).toBe('ev-data-comp')
  })
})
