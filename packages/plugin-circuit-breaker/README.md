# @psyqueue/plugin-circuit-breaker

> Circuit breaker pattern for PsyQueue. Protect downstream services from cascading failures.

## Installation

```bash
npm install @psyqueue/plugin-circuit-breaker
```

## Usage

```typescript
import { circuitBreaker } from '@psyqueue/plugin-circuit-breaker'

q.use(circuitBreaker({
  breakers: {
    'payment-api': {
      failureThreshold: 5,
      failureWindow: 30_000,
      resetTimeout: 60_000,
      halfOpenRequests: 3,
      onOpen: 'requeue',
    },
  },
}))

q.handle('payment.charge', async (ctx) => {
  return ctx.breaker('payment-api', async () => {
    return await chargePayment(ctx.job.payload)
  })
})
```

## Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `failureThreshold` | `number` | *required* | Failures to trip the breaker |
| `failureWindow` | `number` | *required* | Failure counting window (ms) |
| `resetTimeout` | `number` | *required* | Time before OPEN to HALF_OPEN (ms) |
| `halfOpenRequests` | `number` | *required* | Successes in HALF_OPEN to close |
| `onOpen` | `'requeue' \| 'fail'` | `'requeue'` | Action when circuit is open |

## Exports

- `circuitBreaker(opts)` -- Plugin factory
- `Breaker` -- Individual breaker class

## Documentation

See [Reliability Plugins](../../docs/plugins/reliability.md#circuit-breaker) for detailed usage.

## License

MIT
