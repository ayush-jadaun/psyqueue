import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventBus } from '../src/event-bus.js'
import type { PsyEvent } from '../src/types.js'

describe('EventBus', () => {
  let bus: EventBus

  beforeEach(() => {
    bus = new EventBus()
  })

  describe('basic emit and subscribe', () => {
    it('delivers event to a subscriber with the correct PsyEvent shape', () => {
      const handler = vi.fn()
      bus.on('job:created', handler)
      bus.emit('job:created', { id: 'j1' })

      expect(handler).toHaveBeenCalledOnce()
      const event: PsyEvent = handler.mock.calls[0][0]
      expect(event.type).toBe('job:created')
      expect(event.source).toBe('kernel')
      expect(event.data).toEqual({ id: 'j1' })
      expect(event.timestamp).toBeInstanceOf(Date)
    })

    it('uses custom source when provided', () => {
      const handler = vi.fn()
      bus.on('job:done', handler)
      bus.emit('job:done', null, 'worker-1')

      const event: PsyEvent = handler.mock.calls[0][0]
      expect(event.source).toBe('worker-1')
    })

    it('defaults source to "kernel" when omitted', () => {
      const handler = vi.fn()
      bus.on('test:event', handler)
      bus.emit('test:event', {})

      const event: PsyEvent = handler.mock.calls[0][0]
      expect(event.source).toBe('kernel')
    })

    it('does not throw when emitting with no subscribers', () => {
      expect(() => bus.emit('no:subscribers', { x: 1 })).not.toThrow()
    })

    it('does not deliver event to handlers for a different event', () => {
      const handler = vi.fn()
      bus.on('job:failed', handler)
      bus.emit('job:created', {})
      expect(handler).not.toHaveBeenCalled()
    })
  })

  describe('multiple subscribers', () => {
    it('fires all subscribers for the same event', () => {
      const h1 = vi.fn()
      const h2 = vi.fn()
      const h3 = vi.fn()
      bus.on('job:created', h1)
      bus.on('job:created', h2)
      bus.on('job:created', h3)
      bus.emit('job:created', { id: 'j2' })

      expect(h1).toHaveBeenCalledOnce()
      expect(h2).toHaveBeenCalledOnce()
      expect(h3).toHaveBeenCalledOnce()
    })

    it('each subscriber receives the same event object', () => {
      const received: PsyEvent[] = []
      bus.on('job:created', (e) => received.push(e))
      bus.on('job:created', (e) => received.push(e))
      bus.emit('job:created', 'payload')

      expect(received).toHaveLength(2)
      expect(received[0]).toBe(received[1])
    })
  })

  describe('unsubscribe with off()', () => {
    it('stops delivering events after off() is called', () => {
      const handler = vi.fn()
      bus.on('job:created', handler)
      bus.emit('job:created', {})
      expect(handler).toHaveBeenCalledOnce()

      bus.off('job:created', handler)
      bus.emit('job:created', {})
      expect(handler).toHaveBeenCalledOnce() // still only once
    })

    it('only removes the specific handler, not all handlers', () => {
      const h1 = vi.fn()
      const h2 = vi.fn()
      bus.on('job:created', h1)
      bus.on('job:created', h2)

      bus.off('job:created', h1)
      bus.emit('job:created', {})

      expect(h1).not.toHaveBeenCalled()
      expect(h2).toHaveBeenCalledOnce()
    })

    it('does not throw when calling off() for a handler that was never registered', () => {
      const handler = vi.fn()
      expect(() => bus.off('nonexistent:event', handler)).not.toThrow()
    })
  })

  describe('wildcard subscriptions', () => {
    it('wildcard matches all events with the same prefix (workflow:*)', () => {
      const handler = vi.fn()
      bus.on('workflow:*', handler)

      bus.emit('workflow:started', { wfId: '1' })
      bus.emit('workflow:completed', { wfId: '1' })
      bus.emit('workflow:failed', { wfId: '1' })

      expect(handler).toHaveBeenCalledTimes(3)
    })

    it('wildcard does NOT match events with a different prefix', () => {
      const handler = vi.fn()
      bus.on('workflow:*', handler)

      bus.emit('job:created', {})
      bus.emit('job:failed', {})

      expect(handler).not.toHaveBeenCalled()
    })

    it('wildcard does NOT match nested segments (a:* does not match a:b:c)', () => {
      const handler = vi.fn()
      bus.on('workflow:*', handler)

      bus.emit('workflow:step:completed', {})

      expect(handler).not.toHaveBeenCalled()
    })

    it('both exact and wildcard handlers fire for the same event', () => {
      const exact = vi.fn()
      const wildcard = vi.fn()
      bus.on('job:created', exact)
      bus.on('job:*', wildcard)

      bus.emit('job:created', {})

      expect(exact).toHaveBeenCalledOnce()
      expect(wildcard).toHaveBeenCalledOnce()
    })

    it('wildcard handler receives correct PsyEvent shape', () => {
      const handler = vi.fn()
      bus.on('job:*', handler)
      bus.emit('job:retry', { attempt: 2 }, 'scheduler')

      const event: PsyEvent = handler.mock.calls[0][0]
      expect(event.type).toBe('job:retry')
      expect(event.source).toBe('scheduler')
      expect(event.data).toEqual({ attempt: 2 })
      expect(event.timestamp).toBeInstanceOf(Date)
    })

    it('unsubscribing wildcard with off() stops delivery', () => {
      const handler = vi.fn()
      bus.on('job:*', handler)
      bus.emit('job:created', {})
      expect(handler).toHaveBeenCalledOnce()

      bus.off('job:*', handler)
      bus.emit('job:created', {})
      expect(handler).toHaveBeenCalledOnce() // still only once
    })
  })

  describe('error isolation', () => {
    it('a throwing handler does not prevent other subscribers from firing', () => {
      const thrower = vi.fn(() => {
        throw new Error('boom')
      })
      const good = vi.fn()

      bus.on('job:created', thrower)
      bus.on('job:created', good)

      expect(() => bus.emit('job:created', {})).not.toThrow()
      expect(thrower).toHaveBeenCalledOnce()
      expect(good).toHaveBeenCalledOnce()
    })

    it('a rejecting async handler is caught silently', async () => {
      const rejecter = vi.fn(async () => {
        throw new Error('async boom')
      })
      const good = vi.fn()

      bus.on('job:created', rejecter)
      bus.on('job:created', good)

      expect(() => bus.emit('job:created', {})).not.toThrow()
      expect(good).toHaveBeenCalledOnce()

      // Give the rejected promise a tick to settle — it must not surface as unhandled
      await new Promise((resolve) => setTimeout(resolve, 10))
    })

    it('wildcard throwing handler does not break other wildcard handlers', () => {
      const thrower = vi.fn(() => {
        throw new Error('wildcard boom')
      })
      const good = vi.fn()

      bus.on('job:*', thrower)
      bus.on('job:*', good)

      expect(() => bus.emit('job:created', {})).not.toThrow()
      expect(good).toHaveBeenCalledOnce()
    })
  })

  describe('timestamp accuracy', () => {
    it('timestamp is close to the time of emit', () => {
      const handler = vi.fn()
      bus.on('ts:test', handler)
      const before = new Date()
      bus.emit('ts:test', {})
      const after = new Date()

      const event: PsyEvent = handler.mock.calls[0][0]
      expect(event.timestamp.getTime()).toBeGreaterThanOrEqual(before.getTime())
      expect(event.timestamp.getTime()).toBeLessThanOrEqual(after.getTime())
    })
  })
})
