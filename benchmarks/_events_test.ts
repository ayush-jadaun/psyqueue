import { PsyQueue, QueueEvents } from '../packages/core/src/index.js'
import { redis } from '../packages/backend-redis/src/index.js'
import RedisModule from 'ioredis'
const Redis = (RedisModule as any).default ?? RedisModule

const REDIS = 'redis://127.0.0.1:6381'
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
let passed = 0, failed = 0

function assert(ok: boolean, name: string, detail = '') {
  if (ok) { passed++; process.stdout.write('  PASS: ' + name + (detail ? ' — ' + detail : '') + '\n') }
  else { failed++; process.stdout.write('  FAIL: ' + name + (detail ? ' — ' + detail : '') + '\n') }
}

async function flush() { const c = new Redis({ host: '127.0.0.1', port: 6381 }); await c.flushdb(); await c.quit() }

process.stdout.write('\n=== Cross-Process Events Test (Real Redis) ===\n\n')

// TEST 1: QueueEvents receives completed from separate PsyQueue instance
await flush()
const enqueuer = new PsyQueue()
enqueuer.use(redis({ url: REDIS }))
enqueuer.handle('evt', async () => ({}))
await enqueuer.start()

const worker = new PsyQueue()
worker.use(redis({ url: REDIS }))
worker.handle('evt', async () => ({ answer: 42 }))
await worker.start()

const events = new QueueEvents({ url: REDIS, queue: 'evt' })
await events.start()

let received: any = null
events.on('completed', (data) => { received = data })

const jobId = await enqueuer.enqueue('evt', { test: 1 })
await worker.processNext('evt')
await sleep(200)

assert(received !== null, 'Completed event received cross-process', received ? 'jobId=' + received.jobId : 'null')
assert(received?.jobId === jobId, 'Event has correct jobId', 'expected=' + jobId + ' got=' + received?.jobId)

await events.stop()
await worker.stop()
await enqueuer.stop()

// TEST 2: Failed event received
await flush()
const q2 = new PsyQueue()
q2.use(redis({ url: REDIS }))
q2.handle('fail-evt', async () => { throw new Error('boom') })
await q2.start()

const events2 = new QueueEvents({ url: REDIS, queue: 'fail-evt' })
await events2.start()

let failReceived: any = null
events2.on('failed', (data) => { failReceived = data })

await q2.enqueue('fail-evt', {}, { maxRetries: 0 })
await q2.processNext('fail-evt')
await sleep(200)

assert(failReceived !== null, 'Failed event received cross-process')
await events2.stop()
await q2.stop()

// TEST 3: waitUntilFinished
await flush()
const q3 = new PsyQueue()
q3.use(redis({ url: REDIS }))
q3.handle('wait-test', async () => ({ magic: 99 }))
await q3.start()

const events3 = new QueueEvents({ url: REDIS, queue: 'wait-test' })
await events3.start()

const jid = await q3.enqueue('wait-test', {})
const resultPromise = events3.waitUntilFinished(jid, 5000)

// Process after starting the wait
setTimeout(async () => { await q3.processNext('wait-test') }, 50)

const result = await resultPromise
assert(result !== undefined, 'waitUntilFinished resolves', 'result=' + JSON.stringify(result))

await events3.stop()
await q3.stop()

// TEST 4: waitUntilFinished timeout
const events4 = new QueueEvents({ url: REDIS, queue: 'timeout-test' })
await events4.start()
let timedOut = false
try { await events4.waitUntilFinished('nonexistent', 500) }
catch (e: any) { timedOut = e.message.includes('did not finish') }
assert(timedOut, 'waitUntilFinished times out correctly')
await events4.stop()

// TEST 5: Multiple events
await flush()
const q5 = new PsyQueue()
q5.use(redis({ url: REDIS }))
q5.handle('multi', async () => ({ ok: true }))
await q5.start()

const events5 = new QueueEvents({ url: REDIS, queue: 'multi' })
await events5.start()
const ids: string[] = []
events5.on('completed', (d) => ids.push(d.jobId))

for (let i = 0; i < 10; i++) await q5.enqueue('multi', { i })
for (let i = 0; i < 10; i++) await q5.processNext('multi')
await sleep(300)

assert(ids.length === 10, '10 completed events received', 'got=' + ids.length)
await events5.stop()
await q5.stop()

process.stdout.write('\n  Results: ' + passed + ' passed, ' + failed + ' failed\n\n')
process.exit(failed > 0 ? 1 : 0)
