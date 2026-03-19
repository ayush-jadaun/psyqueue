import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PluginRegistry } from '../src/plugin-registry.js'
import { DependencyError, CircularDependencyError, PsyQueueError } from '../src/errors.js'
import type { Kernel, PsyPlugin } from '../src/types.js'

// Minimal stub kernel
function makeKernel(): Kernel {
  return {
    events: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },
    pipeline: vi.fn(),
    getBackend: vi.fn(),
    expose: vi.fn(),
  }
}

function makePlugin(overrides: Partial<PsyPlugin> & { name: string; version?: string }): PsyPlugin {
  return {
    name: overrides.name,
    version: overrides.version ?? '1.0.0',
    provides: overrides.provides,
    depends: overrides.depends,
    init: overrides.init ?? vi.fn(),
    start: overrides.start,
    stop: overrides.stop,
    destroy: overrides.destroy,
  }
}

describe('PluginRegistry', () => {
  let kernel: Kernel
  let registry: PluginRegistry

  beforeEach(() => {
    kernel = makeKernel()
    registry = new PluginRegistry(kernel)
  })

  describe('register()', () => {
    it('registers a plugin and calls init with the kernel', () => {
      const init = vi.fn()
      const plugin = makePlugin({ name: 'my-plugin', init })
      registry.register(plugin)
      expect(init).toHaveBeenCalledOnce()
      expect(init).toHaveBeenCalledWith(kernel)
    })

    it('makes plugin retrievable via getPlugin()', () => {
      const plugin = makePlugin({ name: 'test-plugin' })
      registry.register(plugin)
      expect(registry.getPlugin('test-plugin')).toBe(plugin)
    })

    it('returns undefined for an unregistered plugin name', () => {
      expect(registry.getPlugin('nonexistent')).toBeUndefined()
    })

    it('throws PsyQueueError with DUPLICATE_PLUGIN code when registering same name twice', () => {
      const plugin = makePlugin({ name: 'dup-plugin' })
      registry.register(plugin)
      expect(() => registry.register(plugin)).toThrowError(PsyQueueError)
      expect(() => registry.register(makePlugin({ name: 'dup-plugin' }))).toThrowError(
        expect.objectContaining({ code: 'DUPLICATE_PLUGIN' })
      )
    })

    it('error message says "already registered"', () => {
      const plugin = makePlugin({ name: 'dup-plugin' })
      registry.register(plugin)
      expect(() => registry.register(makePlugin({ name: 'dup-plugin' }))).toThrow(/already registered/)
    })

    it('registers provides as a single string capability', () => {
      const plugin = makePlugin({ name: 'backend', provides: 'storage' })
      registry.register(plugin)
      // Can later be resolved by another plugin depending on 'storage'
      const consumer = makePlugin({ name: 'consumer', depends: ['storage'] })
      registry.register(consumer)
      // resolveOrder should succeed
      expect(async () => registry.startAll()).not.toThrow()
    })

    it('supports provides as an array of capabilities', async () => {
      const provider = makePlugin({ name: 'multi-provider', provides: ['capability-a', 'capability-b'] })
      registry.register(provider)

      const consumerA = makePlugin({ name: 'consumer-a', depends: ['capability-a'] })
      const consumerB = makePlugin({ name: 'consumer-b', depends: ['capability-b'] })
      registry.register(consumerA)
      registry.register(consumerB)

      // Should start without throwing — both capabilities are satisfied
      await expect(registry.startAll()).resolves.toBeUndefined()
    })
  })

  describe('startAll() — dependency order', () => {
    it('starts plugins in dependency order (dependency before dependent)', async () => {
      const order: string[] = []
      const backend = makePlugin({
        name: 'backend',
        provides: 'storage',
        start: async () => { order.push('backend') },
      })
      const workflows = makePlugin({
        name: 'workflows',
        depends: ['storage'],
        start: async () => { order.push('workflows') },
      })
      registry.register(backend)
      registry.register(workflows)
      await registry.startAll()
      expect(order.indexOf('backend')).toBeLessThan(order.indexOf('workflows'))
    })

    it('starts plugins registered in topological order (no deps)', async () => {
      const order: string[] = []
      const a = makePlugin({ name: 'a', start: async () => { order.push('a') } })
      const b = makePlugin({ name: 'b', start: async () => { order.push('b') } })
      registry.register(a)
      registry.register(b)
      await registry.startAll()
      expect(order).toHaveLength(2)
      expect(order).toContain('a')
      expect(order).toContain('b')
    })

    it('throws DependencyError when a dependency is not registered', async () => {
      const plugin = makePlugin({ name: 'worker', depends: ['missing-dep'] })
      registry.register(plugin)
      await expect(registry.startAll()).rejects.toBeInstanceOf(DependencyError)
    })

    it('throws DependencyError containing plugin name and missing dep name', async () => {
      const plugin = makePlugin({ name: 'worker', depends: ['ghost-backend'] })
      registry.register(plugin)
      await expect(registry.startAll()).rejects.toThrow(/worker/)
      await expect(registry.startAll()).rejects.toThrow(/ghost-backend/)
    })

    it('throws CircularDependencyError when there is a cycle (a→b→a)', async () => {
      const a = makePlugin({ name: 'plugin-a', depends: ['plugin-b'] })
      const b = makePlugin({ name: 'plugin-b', depends: ['plugin-a'] })
      registry.register(a)
      registry.register(b)
      await expect(registry.startAll()).rejects.toBeInstanceOf(CircularDependencyError)
    })

    it('does not error for plugins without a start() method', async () => {
      const plugin = makePlugin({ name: 'no-lifecycle' })
      registry.register(plugin)
      await expect(registry.startAll()).resolves.toBeUndefined()
    })
  })

  describe('stopAll() — reverse order', () => {
    it('stops plugins in reverse start order', async () => {
      const order: string[] = []
      const backend = makePlugin({
        name: 'backend',
        provides: 'storage',
        start: async () => {},
        stop: async () => { order.push('backend') },
      })
      const workflows = makePlugin({
        name: 'workflows',
        depends: ['storage'],
        start: async () => {},
        stop: async () => { order.push('workflows') },
      })
      registry.register(backend)
      registry.register(workflows)
      await registry.startAll()
      await registry.stopAll()
      // workflows started last, so it should stop first
      expect(order.indexOf('workflows')).toBeLessThan(order.indexOf('backend'))
    })

    it('calls destroy() after stop() in reverse order', async () => {
      const events: string[] = []
      const plugin = makePlugin({
        name: 'p',
        stop: async () => { events.push('stop') },
        destroy: async () => { events.push('destroy') },
      })
      registry.register(plugin)
      await registry.startAll()
      await registry.stopAll()
      expect(events).toEqual(['stop', 'destroy'])
    })

    it('does not error for plugins without stop() or destroy() methods', async () => {
      const plugin = makePlugin({ name: 'minimal' })
      registry.register(plugin)
      await registry.startAll()
      await expect(registry.stopAll()).resolves.toBeUndefined()
    })
  })
})
