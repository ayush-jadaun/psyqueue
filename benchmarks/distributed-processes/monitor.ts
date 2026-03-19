// MONITOR — Separate process, watches events via QueueEvents
import { QueueEvents } from '../../packages/core/src/index.js'

const events = new QueueEvents({ url: 'redis://127.0.0.1:6381', queue: 'dist-work' })

let completed = 0
let failed = 0
const seenIds = new Set<string>()

events.on('completed', (data) => {
  completed++
  seenIds.add(data.jobId)
  if (completed % 50 === 0) {
    process.stdout.write('MONITOR: ' + completed + ' completed events received\n')
  }
})

events.on('failed', () => { failed++ })

await events.start()
process.stdout.write('MONITOR STARTED (PID ' + process.pid + ') — listening for events\n')

// Run for 20 seconds then report
setTimeout(async () => {
  await events.stop()
  process.stdout.write('\nMONITOR FINAL: ' + completed + ' completed, ' + failed + ' failed, ' + seenIds.size + ' unique job IDs\n')
  process.exit(0)
}, 20000)
