import type { PsyPlugin, Kernel } from './types.js'
import { DependencyError, CircularDependencyError, PsyQueueError } from './errors.js'

export class PluginRegistry {
  private plugins = new Map<string, PsyPlugin>()
  private provides = new Map<string, string>() // capability → plugin name
  private startOrder: string[] = []

  constructor(private kernel: Kernel) {}

  register(plugin: PsyPlugin): void {
    if (this.plugins.has(plugin.name)) {
      throw new PsyQueueError('DUPLICATE_PLUGIN', `Plugin "${plugin.name}" is already registered`)
    }
    this.plugins.set(plugin.name, plugin)
    const caps = plugin.provides
      ? Array.isArray(plugin.provides) ? plugin.provides : [plugin.provides]
      : []
    for (const cap of caps) {
      this.provides.set(cap, plugin.name)
    }
    plugin.init(this.kernel)
  }

  async startAll(): Promise<void> {
    this.startOrder = this.resolveOrder()
    for (const name of this.startOrder) {
      const plugin = this.plugins.get(name)!
      if (plugin.start) await plugin.start()
    }
  }

  async stopAll(): Promise<void> {
    const reversed = [...this.startOrder].reverse()
    for (const name of reversed) {
      const plugin = this.plugins.get(name)!
      if (plugin.stop) await plugin.stop()
    }
    for (const name of reversed) {
      const plugin = this.plugins.get(name)!
      if (plugin.destroy) await plugin.destroy()
    }
  }

  getPlugin(name: string): PsyPlugin | undefined {
    return this.plugins.get(name)
  }

  private resolveOrder(): string[] {
    // Build adjacency: plugin → [plugins it depends on]
    const depGraph = new Map<string, string[]>()
    for (const [name, plugin] of this.plugins) {
      const deps: string[] = []
      if (plugin.depends) {
        for (const dep of plugin.depends) {
          const resolvedName = this.plugins.has(dep) ? dep : this.provides.get(dep)
          if (!resolvedName) throw new DependencyError(name, dep)
          deps.push(resolvedName)
        }
      }
      depGraph.set(name, deps)
    }

    // Topological sort (Kahn's algorithm)
    const inDeg = new Map<string, number>()
    for (const [name, deps] of depGraph) {
      inDeg.set(name, deps.length)
    }
    const queue: string[] = []
    for (const [name, deg] of inDeg) {
      if (deg === 0) queue.push(name)
    }
    const order: string[] = []
    while (queue.length > 0) {
      const current = queue.shift()!
      order.push(current)
      for (const [name, deps] of depGraph) {
        if (deps.includes(current)) {
          const newDeg = inDeg.get(name)! - 1
          inDeg.set(name, newDeg)
          if (newDeg === 0) queue.push(name)
        }
      }
    }
    if (order.length !== this.plugins.size) {
      const remaining = [...this.plugins.keys()].filter(n => !order.includes(n))
      throw new CircularDependencyError(remaining)
    }
    return order
  }
}
