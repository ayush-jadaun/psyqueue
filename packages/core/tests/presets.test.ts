import { describe, it, expect } from 'vitest'
import { presets, PsyQueue } from '../src/index.js'

describe('Presets', () => {
  it('defines lite preset with correct plugins', () => {
    expect(presets['lite']).toBeDefined()
    expect(presets['lite']!.plugins).toContain('backend-sqlite')
    expect(presets['lite']!.plugins).toContain('scheduler')
    expect(presets['lite']!.plugins).toContain('crash-recovery')
  })

  it('defines saas preset with correct plugins', () => {
    expect(presets['saas']).toBeDefined()
    expect(presets['saas']!.plugins).toContain('backend-redis')
    expect(presets['saas']!.plugins).toContain('tenancy')
    expect(presets['saas']!.plugins).toContain('workflows')
    expect(presets['saas']!.plugins).toContain('dashboard')
    expect(presets['saas']!.plugins).toContain('metrics')
  })

  it('defines enterprise preset with correct plugins', () => {
    expect(presets['enterprise']).toBeDefined()
    expect(presets['enterprise']!.plugins).toContain('backend-postgres')
    expect(presets['enterprise']!.plugins).toContain('exactly-once')
    expect(presets['enterprise']!.plugins).toContain('audit-log')
    expect(presets['enterprise']!.plugins).toContain('otel-tracing')
    expect(presets['enterprise']!.plugins).toContain('schema-versioning')
  })

  it('PsyQueue.from() creates instance from preset name', () => {
    const { queue, config } = PsyQueue.from('lite')
    expect(queue).toBeInstanceOf(PsyQueue)
    expect(config.plugins).toContain('backend-sqlite')
  })

  it('PsyQueue.from() merges overrides', () => {
    const { config } = PsyQueue.from('lite', { plugins: ['custom-plugin'] })
    expect(config.plugins).toContain('backend-sqlite')
    expect(config.plugins).toContain('custom-plugin')
  })

  it('PsyQueue.from() throws for unknown preset', () => {
    expect(() => PsyQueue.from('nonexistent')).toThrow('Unknown preset')
  })

  it('PsyQueue.from() accepts a PresetConfig object', () => {
    const { queue, config } = PsyQueue.from({ plugins: ['backend-sqlite', 'scheduler'] })
    expect(queue).toBeInstanceOf(PsyQueue)
    expect(config.plugins).toEqual(['backend-sqlite', 'scheduler'])
  })
})
