import { describe, it, expect, vi } from 'vitest'
import { workflow } from '../src/builder.js'
import type { JobContext } from '@psyqueue/core'

const h = async (_ctx: JobContext) => 'ok'

describe('WorkflowBuilder', () => {
  it('builds a single-step workflow', () => {
    const wf = workflow('test').step('a', h).build()
    expect(wf.name).toBe('test')
    expect(wf.steps).toHaveLength(1)
    expect(wf.steps[0]!.name).toBe('a')
    expect(wf.steps[0]!.dependencies).toEqual([])
  })

  it('builds a linear DAG (A -> B)', () => {
    const wf = workflow('test')
      .step('a', h)
      .step('b', h, { after: 'a' })
      .build()
    expect(wf.steps).toHaveLength(2)
    expect(wf.steps[1]!.dependencies).toEqual(['a'])
  })

  it('builds parallel branches', () => {
    const wf = workflow('test')
      .step('root', h)
      .step('left', h, { after: 'root' })
      .step('right', h, { after: 'root' })
      .step('join', h, { after: ['left', 'right'] })
      .build()
    expect(wf.steps.find(s => s.name === 'join')!.dependencies).toEqual(['left', 'right'])
  })

  it('throws on cycle (A -> B -> A)', () => {
    expect(() =>
      workflow('test')
        .step('a', h, { after: 'b' })
        .step('b', h, { after: 'a' })
        .build()
    ).toThrow(/[Cc]ycle/)
  })

  it('throws on self-referencing cycle', () => {
    expect(() =>
      workflow('test')
        .step('a', h, { after: 'a' })
        .build()
    ).toThrow(/[Cc]ycle/)
  })

  it('throws on three-node cycle (A -> B -> C -> A)', () => {
    expect(() =>
      workflow('test')
        .step('a', h, { after: 'c' })
        .step('b', h, { after: 'a' })
        .step('c', h, { after: 'b' })
        .build()
    ).toThrow(/[Cc]ycle/)
  })

  it('throws on duplicate step name', () => {
    expect(() =>
      workflow('test')
        .step('a', h)
        .step('a', h)
        .build()
    ).toThrow(/[Dd]uplicate/)
  })

  it('throws on dependency referencing non-existent step', () => {
    expect(() =>
      workflow('test')
        .step('a', h, { after: 'nonexistent' })
        .build()
    ).toThrow(/does not exist/)
  })

  it('stores when condition', () => {
    const when = () => true
    const wf = workflow('test')
      .step('a', h)
      .step('b', h, { after: 'a', when })
      .build()
    expect(wf.steps[1]!.when).toBe(when)
  })

  it('stores compensate handler', () => {
    const comp = vi.fn()
    const wf = workflow('test')
      .step('a', h, { compensate: comp })
      .build()
    expect(wf.steps[0]!.compensate).toBe(comp)
  })

  it('marks the result with __workflow: true', () => {
    const wf = workflow('test').step('a', h).build()
    expect(wf.__workflow).toBe(true)
  })

  it('supports diamond DAG shape', () => {
    const wf = workflow('diamond')
      .step('start', h)
      .step('left', h, { after: 'start' })
      .step('right', h, { after: 'start' })
      .step('end', h, { after: ['left', 'right'] })
      .build()
    expect(wf.steps).toHaveLength(4)
    expect(wf.steps.find(s => s.name === 'end')!.dependencies).toEqual(['left', 'right'])
  })

  it('supports deeply nested linear chain', () => {
    const builder = workflow('deep')
    builder.step('s0', h)
    for (let i = 1; i <= 10; i++) {
      builder.step(`s${i}`, h, { after: `s${i - 1}` })
    }
    const wf = builder.build()
    expect(wf.steps).toHaveLength(11)
    expect(wf.steps[10]!.dependencies).toEqual(['s9'])
  })

  it('supports multiple root nodes (no dependencies)', () => {
    const wf = workflow('multi-root')
      .step('a', h)
      .step('b', h)
      .step('c', h, { after: ['a', 'b'] })
      .build()
    expect(wf.steps[0]!.dependencies).toEqual([])
    expect(wf.steps[1]!.dependencies).toEqual([])
    expect(wf.steps[2]!.dependencies).toEqual(['a', 'b'])
  })

  it('preserves step handler references', () => {
    const handler1 = vi.fn()
    const handler2 = vi.fn()
    const wf = workflow('test')
      .step('a', handler1)
      .step('b', handler2, { after: 'a' })
      .build()
    expect(wf.steps[0]!.handler).toBe(handler1)
    expect(wf.steps[1]!.handler).toBe(handler2)
  })

  it('is chainable (returns this)', () => {
    const builder = workflow('test')
    const result = builder.step('a', h)
    expect(result).toBe(builder)
  })
})
