export type ActionName = 'log' | 'throttle' | 'pause'

export type ActionFn = (ctx: { setConcurrency: (n: number) => Promise<void> }) => Promise<void>

const builtinActions: Record<string, ActionFn> = {
  log: async () => {
    // Logs pressure — no-op in library, user can subscribe to events
  },
  throttle: async (ctx) => {
    await ctx.setConcurrency(1)
  },
  pause: async (ctx) => {
    await ctx.setConcurrency(0)
  },
}

export function resolveActions(
  names: string[],
  callback?: ActionFn,
): ActionFn {
  if (callback) {
    if (names.length > 0) {
      throw new Error(
        'Backpressure: cannot specify both action names and a callback for the same pressure level. Use one or the other.',
      )
    }
    return callback
  }

  const fns = names.map((name) => {
    const fn = builtinActions[name]
    if (!fn) {
      throw new Error(`Backpressure: unknown action "${name}". Known actions: ${Object.keys(builtinActions).join(', ')}`)
    }
    return fn
  })

  return async (ctx) => {
    for (const fn of fns) {
      await fn(ctx)
    }
  }
}
