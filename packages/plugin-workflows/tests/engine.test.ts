import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { PsyQueue } from 'psyqueue'
import { sqlite } from '../../backend-sqlite/src/index.js'
import { workflows, workflow } from '../src/index.js'
import type { WorkflowDefinition } from '../src/builder.js'
import type { WorkflowEngine } from '../src/engine.js'

/**
 * Flush microtask queue — gives async event handlers time to complete.
 * The workflow engine uses events to advance the DAG, and the event bus
 * fires handlers but doesn't await their promises.
 */
function tick(): Promise<void> {
  return new Promise(r => setTimeout(r, 5))
}

describe('Workflow Engine', () => {
  let q: PsyQueue
  let engine: WorkflowEngine

  function setup(wf: WorkflowDefinition): void {
    engine.registerDefinition(wf)
    q.handle(wf.name, engine.createHandler(wf.name))
  }

  beforeEach(async () => {
    q = new PsyQueue()
    const wfPlugin = workflows()
    engine = wfPlugin.engine
    q.use(sqlite({ path: ':memory:' }))
    q.use(wfPlugin)
    await q.start()
  })

  afterEach(async () => {
    await q.stop()
  })

  // ─── Sequential Execution ──────────────────────────────────────────────────

  it('executes a single-step workflow', async () => {
    const handler = vi.fn(async () => 'done')
    const wf = workflow('single').step('only', handler).build()
    setup(wf)

    await q.enqueue('single', { x: 1 })
    await q.processNext('single')
    await tick()

    expect(handler).toHaveBeenCalledTimes(1)

    const instance = engine.store.list()[0]!
    expect(instance.status).toBe('COMPLETED')
    expect(instance.stepStates['only']!.status).toBe('completed')
  })

  it('executes sequential steps in order', async () => {
    const order: string[] = []
    const wf = workflow('seq')
      .step('a', async () => { order.push('a'); return 'A' })
      .step('b', async () => { order.push('b'); return 'B' }, { after: 'a' })
      .step('c', async () => { order.push('c'); return 'C' }, { after: 'b' })
      .build()
    setup(wf)

    await q.enqueue('seq', {})
    await q.processNext('seq') // step a
    await tick()
    await q.processNext('seq') // step b
    await tick()
    await q.processNext('seq') // step c
    await tick()

    expect(order).toEqual(['a', 'b', 'c'])

    const instance = engine.store.list()[0]!
    expect(instance.status).toBe('COMPLETED')
  })

  // ─── Parallel Execution ────────────────────────────────────────────────────

  it('executes parallel branches after root completes', async () => {
    const order: string[] = []
    const wf = workflow('par')
      .step('root', async () => { order.push('root') })
      .step('left', async () => { order.push('left') }, { after: 'root' })
      .step('right', async () => { order.push('right') }, { after: 'root' })
      .build()
    setup(wf)

    await q.enqueue('par', {})
    await q.processNext('par') // root
    await tick()

    // Both left and right should be enqueued now
    await q.processNext('par')
    await tick()
    await q.processNext('par')
    await tick()

    expect(order).toContain('root')
    expect(order).toContain('left')
    expect(order).toContain('right')
    expect(order[0]).toBe('root')
  })

  it('executes diamond DAG correctly', async () => {
    const order: string[] = []
    const wf = workflow('diamond')
      .step('start', async () => { order.push('start') })
      .step('left', async () => { order.push('left') }, { after: 'start' })
      .step('right', async () => { order.push('right') }, { after: 'start' })
      .step('end', async () => { order.push('end') }, { after: ['left', 'right'] })
      .build()
    setup(wf)

    await q.enqueue('diamond', {})
    await q.processNext('diamond') // start
    await tick()
    await q.processNext('diamond') // left or right
    await tick()
    await q.processNext('diamond') // the other
    await tick()
    await q.processNext('diamond') // end
    await tick()

    expect(order[0]).toBe('start')
    expect(order).toContain('left')
    expect(order).toContain('right')
    expect(order[3]).toBe('end')

    const instance = engine.store.list()[0]!
    expect(instance.status).toBe('COMPLETED')
  })

  // ─── Conditional Steps ─────────────────────────────────────────────────────

  it('skips step when condition returns false', async () => {
    const skippedHandler = vi.fn(async () => 'should not run')
    const doneHandler = vi.fn(async () => 'done')

    const wf = workflow('cond')
      .step('check', async () => ({ tier: 'basic' }))
      .step('premium', skippedHandler, {
        after: 'check',
        when: (ctx) => (ctx.results['check'] as { tier: string })?.tier === 'premium',
      })
      .step('done', doneHandler, { after: 'premium' })
      .build()
    setup(wf)

    await q.enqueue('cond', {})
    await q.processNext('cond') // check
    await tick()
    // premium should be skipped, done should be enqueued
    await q.processNext('cond') // done (premium was skipped)
    await tick()

    expect(skippedHandler).not.toHaveBeenCalled()
    expect(doneHandler).toHaveBeenCalled()

    const instance = engine.store.list()[0]!
    expect(instance.stepStates['premium']!.status).toBe('skipped')
    expect(instance.status).toBe('COMPLETED')
  })

  it('runs step when condition returns true', async () => {
    const premiumHandler = vi.fn(async () => 'premium ran')

    const wf = workflow('cond-true')
      .step('check', async () => ({ tier: 'premium' }))
      .step('premium', premiumHandler, {
        after: 'check',
        when: (ctx) => (ctx.results['check'] as { tier: string })?.tier === 'premium',
      })
      .build()
    setup(wf)

    await q.enqueue('cond-true', {})
    await q.processNext('cond-true') // check
    await tick()
    await q.processNext('cond-true') // premium
    await tick()

    expect(premiumHandler).toHaveBeenCalled()
  })

  // ─── Step Results ──────────────────────────────────────────────────────────

  it('provides prior step results via context', async () => {
    let received: Record<string, unknown> | undefined
    const wf = workflow('results')
      .step('a', async () => ({ value: 42 }))
      .step('b', async (ctx) => { received = ctx.results }, { after: 'a' })
      .build()
    setup(wf)

    await q.enqueue('results', {})
    await q.processNext('results')
    await tick()
    await q.processNext('results')
    await tick()

    expect(received).toBeDefined()
    expect(received!['a']).toEqual({ value: 42 })
  })

  it('provides workflow context to step handlers', async () => {
    let capturedWorkflow: { workflowId: string; stepId: string; results: Record<string, unknown> } | undefined
    const wf = workflow('wf-ctx')
      .step('a', async () => 'first')
      .step('b', async (ctx) => { capturedWorkflow = ctx.workflow }, { after: 'a' })
      .build()
    setup(wf)

    const wfId = await q.enqueue('wf-ctx', {})
    await q.processNext('wf-ctx')
    await tick()
    await q.processNext('wf-ctx')
    await tick()

    expect(capturedWorkflow).toBeDefined()
    expect(capturedWorkflow!.workflowId).toBe(wfId)
    expect(capturedWorkflow!.stepId).toBe('b')
    expect(capturedWorkflow!.results['a']).toBe('first')
  })

  // ─── Workflow Status ───────────────────────────────────────────────────────

  it('marks workflow COMPLETED when all steps done', async () => {
    const wf = workflow('complete')
      .step('only', async () => 'done')
      .build()
    setup(wf)

    const wfId = await q.enqueue('complete', {})
    await q.processNext('complete')
    await tick()

    const instance = engine.store.get(wfId)!
    expect(instance.status).toBe('COMPLETED')
  })

  it('marks workflow FAILED when step fails', async () => {
    const wf = workflow('fail')
      .step('bomb', async () => { throw new Error('boom') })
      .build()
    setup(wf)

    await q.enqueue('fail', {})
    await q.processNext('fail') // attempt 1 -> fails -> dead letter (maxRetries: 0)
    await tick()

    const instance = engine.store.list()[0]!
    expect(instance.status).toBe('FAILED')
    expect(instance.stepStates['bomb']!.status).toBe('failed')
  })

  // ─── Events ────────────────────────────────────────────────────────────────

  it('emits workflow:completed event', async () => {
    const events: unknown[] = []
    q.events.on('workflow:completed', (e) => events.push(e.data))

    const wf = workflow('ev-complete')
      .step('a', async () => 'done')
      .build()
    setup(wf)

    await q.enqueue('ev-complete', {})
    await q.processNext('ev-complete')
    await tick()

    expect(events.length).toBeGreaterThanOrEqual(1)
    expect((events[0] as Record<string, unknown>)['definitionName']).toBe('ev-complete')
  })

  it('emits workflow:failed event', async () => {
    const events: unknown[] = []
    q.events.on('workflow:failed', (e) => events.push(e.data))

    const wf = workflow('ev-fail')
      .step('bomb', async () => { throw new Error('boom') })
      .build()
    setup(wf)

    await q.enqueue('ev-fail', {})
    await q.processNext('ev-fail')
    await tick()

    expect(events.length).toBeGreaterThanOrEqual(1)
    expect((events[0] as Record<string, unknown>)['failedStep']).toBe('bomb')
  })

  it('emits workflow:started event', async () => {
    const events: unknown[] = []
    q.events.on('workflow:started', (e) => events.push(e.data))

    const wf = workflow('ev-start')
      .step('a', async () => 'ok')
      .build()
    setup(wf)

    await q.enqueue('ev-start', {})

    expect(events.length).toBeGreaterThanOrEqual(1)
    expect((events[0] as Record<string, unknown>)['definitionName']).toBe('ev-start')
  })

  // ─── Edge Cases ────────────────────────────────────────────────────────────

  it('runs step when ALL deps are skipped', async () => {
    const finalHandler = vi.fn(async () => 'ran')
    const wf = workflow('all-skip')
      .step('root', async () => ({ x: 1 }))
      .step('never1', vi.fn(), { after: 'root', when: () => false })
      .step('never2', vi.fn(), { after: 'root', when: () => false })
      .step('final', finalHandler, { after: ['never1', 'never2'] })
      .build()
    setup(wf)

    await q.enqueue('all-skip', {})
    await q.processNext('all-skip') // root
    await tick()
    // never1 and never2 skipped, final should be enqueued
    await q.processNext('all-skip') // final
    await tick()

    expect(finalHandler).toHaveBeenCalled()

    const instance = engine.store.list()[0]!
    expect(instance.stepStates['never1']!.status).toBe('skipped')
    expect(instance.stepStates['never2']!.status).toBe('skipped')
    expect(instance.status).toBe('COMPLETED')
  })

  it('returns workflow instance ID from enqueue', async () => {
    const wf = workflow('id-test')
      .step('a', async () => 'ok')
      .build()
    setup(wf)

    const wfId = await q.enqueue('id-test', {})
    expect(typeof wfId).toBe('string')
    expect(wfId.length).toBeGreaterThan(0)

    const instance = engine.store.get(wfId)
    expect(instance).toBeDefined()
    expect(instance!.definitionName).toBe('id-test')
  })

  it('cancels a running workflow', async () => {
    const wf = workflow('cancel-test')
      .step('a', async () => 'ok')
      .step('b', async () => 'ok', { after: 'a' })
      .build()
    setup(wf)

    const wfId = await q.enqueue('cancel-test', {})
    const cancelled = engine.cancel(wfId)
    expect(cancelled).toBe(true)

    const instance = engine.store.get(wfId)!
    expect(instance.status).toBe('CANCELLED')
  })

  it('preserves original payload in workflow instance', async () => {
    const wf = workflow('payload-test')
      .step('a', async () => 'ok')
      .build()
    setup(wf)

    const payload = { orderId: 'abc', amount: 99 }
    const wfId = await q.enqueue('payload-test', payload)

    const instance = engine.store.get(wfId)!
    expect(instance.payload).toEqual(payload)
  })

  it('does not interfere with non-workflow jobs', async () => {
    const normalHandler = vi.fn(async () => 'normal result')
    q.handle('normal-job', normalHandler)

    await q.enqueue('normal-job', { data: 1 })
    await q.processNext('normal-job')

    expect(normalHandler).toHaveBeenCalledTimes(1)
  })
})
