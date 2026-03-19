import type { EventBusInterface, EventHandler, PsyEvent } from './types.js'

export class EventBus implements EventBusInterface {
  private handlers = new Map<string, Set<EventHandler>>()
  private wildcardHandlers = new Map<string, Set<EventHandler>>()

  on(event: string, handler: EventHandler): void {
    if (event.includes('*')) {
      const prefix = event.replace(':*', '')
      if (!this.wildcardHandlers.has(prefix)) {
        this.wildcardHandlers.set(prefix, new Set())
      }
      this.wildcardHandlers.get(prefix)!.add(handler)
    } else {
      if (!this.handlers.has(event)) {
        this.handlers.set(event, new Set())
      }
      this.handlers.get(event)!.add(handler)
    }
  }

  off(event: string, handler: EventHandler): void {
    if (event.includes('*')) {
      const prefix = event.replace(':*', '')
      this.wildcardHandlers.get(prefix)?.delete(handler)
    } else {
      this.handlers.get(event)?.delete(handler)
    }
  }

  emit(event: string, data: unknown, source: string = 'kernel'): void {
    const psyEvent: PsyEvent = {
      type: event,
      timestamp: new Date(),
      source,
      data,
    }

    const exact = this.handlers.get(event)
    if (exact) {
      for (const handler of exact) {
        this.safeCall(handler, psyEvent)
      }
    }

    // Wildcard: "workflow:started" matches "workflow:*"
    // Only if event has exactly 2 segments (prefix:name)
    const parts = event.split(':')
    if (parts.length === 2) {
      const prefix = parts[0]!
      const wildcards = this.wildcardHandlers.get(prefix)
      if (wildcards) {
        for (const handler of wildcards) {
          this.safeCall(handler, psyEvent)
        }
      }
    }
  }

  private safeCall(handler: EventHandler, event: PsyEvent): void {
    try {
      const result = handler(event)
      if (result instanceof Promise) {
        result.catch(() => {})
      }
    } catch {
      // One bad handler must not break others
    }
  }
}
