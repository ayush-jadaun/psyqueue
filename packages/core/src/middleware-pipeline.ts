import type { Middleware, MiddlewarePhase, LifecycleEvent, JobContext } from './types.js'

const PHASE_ORDER: MiddlewarePhase[] = ['guard', 'validate', 'transform', 'observe', 'execute', 'finalize']

interface StoredMiddleware {
  phase: MiddlewarePhase
  fn: Middleware
  pluginName: string
  index: number
}

export class MiddlewarePipeline {
  private chains = new Map<LifecycleEvent, StoredMiddleware[]>()
  private counter = 0

  add(event: LifecycleEvent, fn: Middleware, opts: { phase?: MiddlewarePhase; pluginName: string }): void {
    if (!this.chains.has(event)) this.chains.set(event, [])
    this.chains.get(event)!.push({
      phase: opts.phase ?? 'execute',
      fn,
      pluginName: opts.pluginName,
      index: this.counter++,
    })
  }

  async run(event: LifecycleEvent, ctx: JobContext): Promise<void> {
    const chain = this.chains.get(event)
    if (!chain || chain.length === 0) return
    const sorted = [...chain].sort((a, b) => {
      const phaseA = PHASE_ORDER.indexOf(a.phase)
      const phaseB = PHASE_ORDER.indexOf(b.phase)
      if (phaseA !== phaseB) return phaseA - phaseB
      return a.index - b.index
    })
    const dispatch = (i: number): Promise<void> => {
      if (i >= sorted.length) return Promise.resolve()
      const mw = sorted[i]!
      return mw.fn(ctx, () => dispatch(i + 1))
    }
    await dispatch(0)
  }
}
