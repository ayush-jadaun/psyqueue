import { describe, it, expect } from 'vitest'
import { SlidingWindowRateLimiter } from '../src/rate-limiter.js'

describe('SlidingWindowRateLimiter', () => {
  it('allows requests within limit', () => {
    const limiter = new SlidingWindowRateLimiter()
    limiter.configure('t1', { max: 5, window: '1m' })
    for (let i = 0; i < 5; i++) {
      expect(limiter.check('t1').allowed).toBe(true)
      limiter.record('t1')
    }
  })

  it('blocks requests exceeding limit', () => {
    const limiter = new SlidingWindowRateLimiter()
    limiter.configure('t1', { max: 2, window: '1m' })
    limiter.record('t1')
    limiter.record('t1')
    const result = limiter.check('t1')
    expect(result.allowed).toBe(false)
    expect(result.retryAfter).toBeGreaterThan(0)
  })

  it('allows after window slides', async () => {
    const limiter = new SlidingWindowRateLimiter()
    limiter.configure('t1', { max: 1, window: '100ms' })
    limiter.record('t1')
    expect(limiter.check('t1').allowed).toBe(false)
    await new Promise(r => setTimeout(r, 150))
    expect(limiter.check('t1').allowed).toBe(true)
  })

  it('tracks tenants independently', () => {
    const limiter = new SlidingWindowRateLimiter()
    limiter.configure('t1', { max: 1, window: '1m' })
    limiter.configure('t2', { max: 1, window: '1m' })
    limiter.record('t1')
    expect(limiter.check('t1').allowed).toBe(false)
    expect(limiter.check('t2').allowed).toBe(true)
  })

  it('allows unconfigured tenants by default', () => {
    const limiter = new SlidingWindowRateLimiter()
    expect(limiter.check('unknown').allowed).toBe(true)
  })

  it('retryAfter is a positive number when blocked', () => {
    const limiter = new SlidingWindowRateLimiter()
    limiter.configure('t1', { max: 1, window: '1m' })
    limiter.record('t1')
    const result = limiter.check('t1')
    expect(result.allowed).toBe(false)
    expect(typeof result.retryAfter).toBe('number')
    expect(result.retryAfter!).toBeGreaterThan(0)
    // retryAfter should be at most 1 minute in ms
    expect(result.retryAfter!).toBeLessThanOrEqual(60_000)
  })

  it('uses sub-windows so sliding is smooth', () => {
    const limiter = new SlidingWindowRateLimiter()
    limiter.configure('t1', { max: 3, window: '1m' })
    // Fill to limit
    limiter.record('t1')
    limiter.record('t1')
    limiter.record('t1')
    expect(limiter.check('t1').allowed).toBe(false)
  })

  it('reconfiguring a tenant resets their window', () => {
    const limiter = new SlidingWindowRateLimiter()
    limiter.configure('t1', { max: 2, window: '1m' })
    limiter.record('t1')
    limiter.record('t1')
    expect(limiter.check('t1').allowed).toBe(false)
    // Reconfigure with higher limit
    limiter.configure('t1', { max: 10, window: '1m' })
    expect(limiter.check('t1').allowed).toBe(true)
  })

  it('handles multiple tenants correctly', () => {
    const limiter = new SlidingWindowRateLimiter()
    limiter.configure('enterprise', { max: 100, window: '1m' })
    limiter.configure('free', { max: 2, window: '1m' })

    // Fill free tier
    limiter.record('free')
    limiter.record('free')
    expect(limiter.check('free').allowed).toBe(false)

    // Enterprise should still be fine
    for (let i = 0; i < 10; i++) {
      expect(limiter.check('enterprise').allowed).toBe(true)
      limiter.record('enterprise')
    }
  })

  it('supports 1s window', () => {
    const limiter = new SlidingWindowRateLimiter()
    limiter.configure('t1', { max: 3, window: '1s' })
    limiter.record('t1')
    limiter.record('t1')
    limiter.record('t1')
    expect(limiter.check('t1').allowed).toBe(false)
  })

  it('supports 1h window', () => {
    const limiter = new SlidingWindowRateLimiter()
    limiter.configure('t1', { max: 1000, window: '1h' })
    for (let i = 0; i < 999; i++) {
      limiter.record('t1')
    }
    expect(limiter.check('t1').allowed).toBe(true)
    limiter.record('t1')
    expect(limiter.check('t1').allowed).toBe(false)
  })
})
