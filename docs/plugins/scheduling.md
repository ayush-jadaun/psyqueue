# Scheduling Plugins

## Scheduler

Handles delayed jobs and cron-based recurring jobs.

### Installation

```bash
npm install @psyqueue/plugin-scheduler
```

### Configuration

```typescript
import { scheduler } from '@psyqueue/plugin-scheduler'

q.use(scheduler({
  pollInterval: 1000,
  cronLockTtl: 60_000,
}))
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `pollInterval` | `number` | `1000` | Milliseconds between polling for due scheduled jobs |
| `cronLockTtl` | `number` | `60000` | Lock TTL in ms for cron leader election (prevents duplicate scheduling in multi-worker setups) |

**Depends on:** `backend`

### Delayed Jobs

Enqueue a job with a future `runAt` to delay its execution:

```typescript
// Run 5 minutes from now
await q.enqueue('report.generate', { type: 'daily' }, {
  runAt: new Date(Date.now() + 5 * 60 * 1000),
})

// Run at a specific time
await q.enqueue('meeting.reminder', { meetingId: '123' }, {
  runAt: new Date('2025-06-15T09:00:00Z'),
})
```

The scheduler intercepts enqueue calls for jobs with a `runAt` and routes them through `backend.scheduleAt()`. A poller periodically checks for due jobs and promotes them to `pending`.

### Cron Jobs

Enqueue a job with a `cron` expression for recurring execution:

```typescript
// Every day at 2 AM
await q.enqueue('cleanup.expired', {}, {
  cron: '0 2 * * *',
})

// Every 15 minutes
await q.enqueue('sync.data', { source: 'api' }, {
  cron: '*/15 * * * *',
})

// Every Monday at 9 AM
await q.enqueue('report.weekly', {}, {
  cron: '0 9 * * 1',
})
```

After a cron job completes, the scheduler automatically computes and schedules the next occurrence. Uses standard 5-field cron expressions.

### How It Works

1. **Enqueue intercept** (transform phase): Jobs with `runAt` are stored via `scheduleAt()` instead of the normal enqueue path.
2. **Polling**: A `DelayedJobPoller` runs every `pollInterval` ms, calling `backend.pollScheduled()` to find and promote due jobs.
3. **Cron scheduling**: On `job:completed`, if the job has a `cron` field, the `CronManager` computes the next run time and schedules it.
4. **Leader election**: In multi-worker setups, cron scheduling uses `backend.acquireLock()` to ensure only one worker schedules the next occurrence.

---

## Deadline Priority

Dynamically boosts job priority as deadlines approach. Jobs that are about to miss their deadline get processed first.

### Installation

```bash
npm install @psyqueue/plugin-deadline-priority
```

### Configuration

```typescript
import { deadlinePriority } from '@psyqueue/plugin-deadline-priority'

q.use(deadlinePriority({
  urgencyCurve: 'exponential',
  boostThreshold: 0.5,
  maxBoost: 95,
  interval: 5000,
  onDeadlineMiss: 'process-anyway',
}))
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `urgencyCurve` | `'linear' \| 'exponential' \| 'step' \| Function` | *required* | How priority scales as the deadline approaches |
| `boostThreshold` | `number` | `0.5` | Start boosting when this fraction of time remains (0.0-1.0) |
| `maxBoost` | `number` | `95` | Maximum priority value after boosting |
| `interval` | `number` | `5000` | How often to recalculate priorities (ms) |
| `onDeadlineMiss` | `'process-anyway' \| 'fail' \| 'move-to-dead-letter'` | `'process-anyway'` | What to do when a job's deadline has passed |

### Usage

```typescript
// Enqueue a job with a 30-minute deadline
await q.enqueue('order.process', { orderId: '456' }, {
  priority: 5,
  deadline: new Date(Date.now() + 30 * 60 * 1000),
})
```

As the deadline approaches, the plugin recalculates the job's priority using the configured curve.

### Urgency Curves

**Linear:** Priority increases linearly as time runs out.

```
Priority
  ^
  |        /
  |      /
  |    /
  |  /
  +---------> Time remaining
  100%    0%
```

**Exponential:** Priority increases slowly at first, then rapidly near the deadline.

```
Priority
  ^
  |      /|
  |     / |
  |   /   |
  | /     |
  +---------> Time remaining
  100%    0%
```

**Step:** Priority jumps at the threshold.

```
Priority
  ^
  |  _____|
  | |
  | |
  | |
  +---------> Time remaining
  100%    0%
```

**Custom function:**

```typescript
q.use(deadlinePriority({
  urgencyCurve: (timeRemainingPct, basePriority) => {
    if (timeRemainingPct < 0.1) return 99
    if (timeRemainingPct < 0.3) return 80
    return basePriority
  },
}))
```

### Events

| Event | Data | When |
|-------|------|------|
| `job:priority-boosted` | `{ jobId, oldPriority, newPriority, timeRemainingPct }` | Priority was recalculated |
| `job:deadline-missed` | `{ jobId, deadline, action }` | Deadline has passed |

### Deadline Miss Handling

| Action | Behavior |
|--------|----------|
| `process-anyway` | Emits event but continues processing normally |
| `fail` | Sends the job to dead letter |
| `move-to-dead-letter` | Sends the job to dead letter |
