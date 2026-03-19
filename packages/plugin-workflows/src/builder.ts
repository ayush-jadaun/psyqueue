import type { JobHandler } from 'psyqueue'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface StepDefinition {
  name: string
  handler: JobHandler
  dependencies: string[]
  when?: (ctx: { results: Record<string, unknown> }) => boolean
  compensate?: JobHandler
}

export interface WorkflowDefinition {
  name: string
  steps: StepDefinition[]
  /** Marker used for duck-type detection */
  __workflow: true
}

export interface StepOpts {
  after?: string | string[]
  when?: (ctx: { results: Record<string, unknown> }) => boolean
  compensate?: JobHandler
}

// ─── Builder ──────────────────────────────────────────────────────────────────

export class WorkflowBuilder {
  private readonly _name: string
  private readonly _steps: StepDefinition[] = []

  constructor(name: string) {
    this._name = name
  }

  step(name: string, handler: JobHandler, opts?: StepOpts): this {
    const dependencies = opts?.after
      ? Array.isArray(opts.after) ? opts.after : [opts.after]
      : []

    this._steps.push({
      name,
      handler,
      dependencies,
      when: opts?.when,
      compensate: opts?.compensate,
    })

    return this
  }

  build(): WorkflowDefinition {
    // Validate: no duplicate step names
    const names = new Set<string>()
    for (const s of this._steps) {
      if (names.has(s.name)) {
        throw new Error(`Duplicate step name: "${s.name}"`)
      }
      names.add(s.name)
    }

    // Validate: all dependency references exist
    for (const s of this._steps) {
      for (const dep of s.dependencies) {
        if (!names.has(dep)) {
          throw new Error(
            `Step "${s.name}" depends on "${dep}" which does not exist`
          )
        }
      }
    }

    // Validate: no cycles via topological sort (Kahn's algorithm)
    const inDegree = new Map<string, number>()
    const adjacency = new Map<string, string[]>() // dep → [dependents]

    for (const s of this._steps) {
      inDegree.set(s.name, s.dependencies.length)
      if (!adjacency.has(s.name)) {
        adjacency.set(s.name, [])
      }
      for (const dep of s.dependencies) {
        if (!adjacency.has(dep)) {
          adjacency.set(dep, [])
        }
        adjacency.get(dep)!.push(s.name)
      }
    }

    const queue: string[] = []
    for (const [name, deg] of inDegree) {
      if (deg === 0) queue.push(name)
    }

    const sorted: string[] = []
    while (queue.length > 0) {
      const current = queue.shift()!
      sorted.push(current)
      for (const dependent of adjacency.get(current) ?? []) {
        const newDeg = inDegree.get(dependent)! - 1
        inDegree.set(dependent, newDeg)
        if (newDeg === 0) queue.push(dependent)
      }
    }

    if (sorted.length !== this._steps.length) {
      const unprocessed = this._steps
        .filter(s => !sorted.includes(s.name))
        .map(s => s.name)
      throw new Error(
        `Cycle detected in workflow "${this._name}": steps [${unprocessed.join(', ')}] form a cycle`
      )
    }

    return {
      name: this._name,
      steps: [...this._steps],
      __workflow: true,
    }
  }
}

/**
 * Creates a new WorkflowBuilder with the given name.
 */
export function workflow(name: string): WorkflowBuilder {
  return new WorkflowBuilder(name)
}
