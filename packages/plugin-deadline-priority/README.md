# @psyqueue/plugin-deadline-priority

> Dynamic priority boosting for PsyQueue jobs approaching their deadlines.

## Installation

```bash
npm install @psyqueue/plugin-deadline-priority
```

## Usage

```typescript
import { deadlinePriority } from '@psyqueue/plugin-deadline-priority'

q.use(deadlinePriority({
  urgencyCurve: 'exponential',
  boostThreshold: 0.5,
  maxBoost: 95,
  interval: 5000,
  onDeadlineMiss: 'process-anyway',
}))

// Enqueue with a deadline
await q.enqueue('order.process', { orderId: '123' }, {
  priority: 5,
  deadline: new Date(Date.now() + 30 * 60 * 1000),
})
```

## Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `urgencyCurve` | `'linear' \| 'exponential' \| 'step' \| Function` | *required* | Priority scaling curve |
| `boostThreshold` | `number` | `0.5` | Start boosting at this fraction of time remaining |
| `maxBoost` | `number` | `95` | Maximum priority value |
| `interval` | `number` | `5000` | Recalculation interval (ms) |
| `onDeadlineMiss` | `'process-anyway' \| 'fail' \| 'move-to-dead-letter'` | `'process-anyway'` | Deadline miss action |

## Documentation

See [Scheduling Plugins](../../docs/plugins/scheduling.md#deadline-priority) for detailed usage.

## License

MIT
