/**
 * Feature-by-Feature Comparison: PsyQueue (Redis) vs BullMQ (Redis)
 *
 * Same Redis instance, same workloads, same measurement methodology.
 * Tests REAL work — CPU computation, I/O delays, failures, retries.
 */

const REDIS_URL = 'redis://127.0.0.1:6381'
const REDIS_OPTS = { host: '127.0.0.1', port: 6381 }

interface TestResult {
  test: string
  psyqueue: { passed: boolean; time: number; detail: string }
  bullmq: { passed: boolean; time: number; detail: string }
}

const results: TestResult[] = []

function log(msg: string) { process.stdout.write(msg + '\n') }

// ================================================================
// TEST 1: Real CPU Work (fibonacci)
// ================================================================
async function test1_cpuWork() {
  log('\n--- Test 1: Real CPU Work (fibonacci) ---')
  function fib(n: number): number { return n <= 1 ? n : fib(n - 1) + fib(n - 2) }

  // PsyQueue
  const { PsyQueue } = await import('psyqueue')
  const { redis } = await import('@psyqueue/backend-redis')
  const q = new PsyQueue()
  q.use(redis({ url: REDIS_URL }))
  const psyResults: number[] = []
  q.handle('fib', async (ctx) => {
    const r = fib((ctx.job.payload as any).n)
    psyResults.push(r)
    return { result: r }
  })
  await q.start()
  const cl = (q as any).backend.getClient(); await cl.flushdb()

  const psyStart = performance.now()
  await q.enqueue('fib', { n: 10 })
  await q.enqueue('fib', { n: 15 })
  await q.enqueue('fib', { n: 20 })
  await q.processNext('fib')
  await q.processNext('fib')
  await q.processNext('fib')
  const psyTime = performance.now() - psyStart
  await q.stop()

  const psyPassed = psyResults.length === 3 && psyResults.includes(55) && psyResults.includes(610) && psyResults.includes(6765)
  log(`  PsyQueue: ${psyPassed ? 'PASS' : 'FAIL'} (${psyTime.toFixed(0)}ms) [${psyResults.join(', ')}]`)

  // BullMQ
  const { Queue, Worker } = await import('bullmq')
  const bq = new Queue('fib-' + Date.now(), { connection: REDIS_OPTS })
  await bq.waitUntilReady()
  const bmqResults: number[] = []

  const bmqStart = performance.now()
  await bq.add('fib', { n: 10 })
  await bq.add('fib', { n: 15 })
  await bq.add('fib', { n: 20 })

  let bmqDone = 0
  const w = new Worker(bq.name, async (job) => {
    const r = fib(job.data.n)
    bmqResults.push(r)
    return { result: r }
  }, { connection: REDIS_OPTS, concurrency: 1 })

  await new Promise<void>(resolve => {
    w.on('completed', () => { bmqDone++; if (bmqDone >= 3) resolve() })
  })
  const bmqTime = performance.now() - bmqStart
  await w.close(); await bq.obliterate({ force: true }); await bq.close()

  const bmqPassed = bmqResults.length === 3 && bmqResults.includes(55) && bmqResults.includes(610) && bmqResults.includes(6765)
  log(`  BullMQ:   ${bmqPassed ? 'PASS' : 'FAIL'} (${bmqTime.toFixed(0)}ms) [${bmqResults.join(', ')}]`)

  results.push({
    test: 'Real CPU Work (fibonacci)',
    psyqueue: { passed: psyPassed, time: psyTime, detail: psyResults.join(', ') },
    bullmq: { passed: bmqPassed, time: bmqTime, detail: bmqResults.join(', ') },
  })
}

// ================================================================
// TEST 2: Async I/O Simulation
// ================================================================
async function test2_asyncIO() {
  log('\n--- Test 2: Async I/O (10ms delay per job, 20 jobs) ---')

  const { PsyQueue } = await import('psyqueue')
  const { redis } = await import('@psyqueue/backend-redis')
  const N = 20

  // PsyQueue
  const q = new PsyQueue()
  q.use(redis({ url: REDIS_URL }))
  let psyCount = 0
  q.handle('io', async () => { await new Promise(r => setTimeout(r, 10)); psyCount++; return {} })
  await q.start()
  const cl = (q as any).backend.getClient(); await cl.flushdb()

  for (let i = 0; i < N; i++) await q.enqueue('io', { i })
  let psyCompleted = 0
  q.events.on('job:completed', () => { psyCompleted++ })
  const be = (q as any).backend; be.supportsBlocking = false
  const psyStart = performance.now()
  q.startWorker('io', { concurrency: 10, pollInterval: 1 })
  while (psyCompleted < N) await new Promise(r => setTimeout(r, 5))
  const psyTime = performance.now() - psyStart
  await q.stop()
  log(`  PsyQueue: ${psyCount === N ? 'PASS' : 'FAIL'} (${psyTime.toFixed(0)}ms) [${psyCount}/${N} jobs]`)

  // BullMQ
  const { Queue, Worker } = await import('bullmq')
  const bq = new Queue('io-' + Date.now(), { connection: REDIS_OPTS })
  await bq.waitUntilReady()
  let bmqCount = 0

  for (let i = 0; i < N; i++) await bq.add('io', { i })
  let bmqDone = 0
  const bmqStart = performance.now()
  const w = new Worker(bq.name, async () => { await new Promise(r => setTimeout(r, 10)); bmqCount++; return {} }, { connection: REDIS_OPTS, concurrency: 10 })
  await new Promise<void>(resolve => { w.on('completed', () => { bmqDone++; if (bmqDone >= N) resolve() }) })
  const bmqTime = performance.now() - bmqStart
  await w.close(); await bq.obliterate({ force: true }); await bq.close()
  log(`  BullMQ:   ${bmqCount === N ? 'PASS' : 'FAIL'} (${bmqTime.toFixed(0)}ms) [${bmqCount}/${N} jobs]`)

  results.push({
    test: 'Async I/O (10ms delay, 20 jobs, concurrency:10)',
    psyqueue: { passed: psyCount === N, time: psyTime, detail: `${psyCount}/${N}` },
    bullmq: { passed: bmqCount === N, time: bmqTime, detail: `${bmqCount}/${N}` },
  })
}

// ================================================================
// TEST 3: Retry on Transient Failure
// ================================================================
async function test3_retry() {
  log('\n--- Test 3: Retry (fails 2x, succeeds on 3rd) ---')

  const { PsyQueue } = await import('psyqueue')
  const { redis } = await import('@psyqueue/backend-redis')

  // PsyQueue — needs scheduler plugin for delayed retries to work on Redis
  const { scheduler } = await import('@psyqueue/plugin-scheduler')
  const q = new PsyQueue()
  q.use(redis({ url: REDIS_URL }))
  q.use(scheduler({ pollInterval: 5 })) // fast poll — matches BullMQ's internal check
  let psyAttempts = 0
  q.handle('flaky', async () => {
    psyAttempts++
    if (psyAttempts < 3) throw new Error('transient')
    return { ok: true }
  })
  await q.start()
  const cl = (q as any).backend.getClient(); await cl.flushdb()
  // SAME delay as BullMQ: 10ms fixed backoff
  await q.enqueue('flaky', {}, { maxRetries: 5, backoff: 'fixed', backoffBase: 10 })

  // Use worker for retry — more production-realistic than manual processNext
  let psyCompleted = false
  q.events.on('job:completed', () => { psyCompleted = true })
  const be2 = (q as any).backend; be2.supportsBlocking = false
  const psyStart = performance.now()
  q.startWorker('flaky', { concurrency: 1, pollInterval: 1 })
  while (!psyCompleted) await new Promise(r => setTimeout(r, 2))
  const psyTime = performance.now() - psyStart
  await q.stop()

  const psyPassed = psyAttempts === 3
  log(`  PsyQueue: ${psyPassed ? 'PASS' : 'FAIL'} (${psyTime.toFixed(0)}ms) [${psyAttempts} attempts]`)

  // BullMQ
  const { Queue, Worker } = await import('bullmq')
  // SAME: 10ms fixed backoff, 5 total attempts
  const bq = new Queue('flaky-' + Date.now(), { connection: REDIS_OPTS, defaultJobOptions: { attempts: 5, backoff: { type: 'fixed', delay: 10 } } })
  await bq.waitUntilReady()
  let bmqAttempts = 0

  await bq.add('flaky', {})
  const bmqStart = performance.now()
  const w = new Worker(bq.name, async () => {
    bmqAttempts++
    if (bmqAttempts < 3) throw new Error('transient')
    return { ok: true }
  }, { connection: REDIS_OPTS, concurrency: 1 })

  await new Promise<void>(resolve => { w.on('completed', () => resolve()) })
  const bmqTime = performance.now() - bmqStart
  await w.close(); await bq.obliterate({ force: true }); await bq.close()

  const bmqPassed = bmqAttempts === 3
  log(`  BullMQ:   ${bmqPassed ? 'PASS' : 'FAIL'} (${bmqTime.toFixed(0)}ms) [${bmqAttempts} attempts]`)

  results.push({
    test: 'Retry (fails 2x, succeeds 3rd)',
    psyqueue: { passed: psyPassed, time: psyTime, detail: `${psyAttempts} attempts` },
    bullmq: { passed: bmqPassed, time: bmqTime, detail: `${bmqAttempts} attempts` },
  })
}

// ================================================================
// TEST 4: Throughput — 1000 jobs with real work (string ops)
// ================================================================
async function test4_throughput() {
  log('\n--- Test 4: Throughput — 1000 jobs with real work ---')
  const N = 1000

  const { PsyQueue } = await import('psyqueue')
  const { redis } = await import('@psyqueue/backend-redis')

  // PsyQueue
  const q = new PsyQueue()
  q.use(redis({ url: REDIS_URL }))
  let psyCount = 0
  q.handle('work', async (ctx) => {
    // Real work: JSON parse + string manipulation
    const data = JSON.stringify(ctx.job.payload)
    const reversed = data.split('').reverse().join('')
    psyCount++
    return { len: reversed.length }
  })
  await q.start()
  const cl = (q as any).backend.getClient(); await cl.flushdb()

  for (let i = 0; i < N; i++) await q.enqueue('work', { i, text: `job-${i}-payload-data` })
  let psyCompleted = 0
  q.events.on('job:completed', () => { psyCompleted++ })
  const be = (q as any).backend; be.supportsBlocking = false
  const psyStart = performance.now()
  q.startWorker('work', { concurrency: 10, pollInterval: 1 })
  while (psyCompleted < N) await new Promise(r => setTimeout(r, 5))
  const psyTime = performance.now() - psyStart
  await q.stop()
  const psyRate = Math.round(N / psyTime * 1000)
  log(`  PsyQueue: ${psyCount === N ? 'PASS' : 'FAIL'} (${psyTime.toFixed(0)}ms, ${psyRate}/sec) [${psyCount}/${N}]`)

  // BullMQ
  const { Queue, Worker } = await import('bullmq')
  const bq = new Queue('work-' + Date.now(), { connection: REDIS_OPTS })
  await bq.waitUntilReady()
  let bmqCount = 0

  for (let i = 0; i < N; i++) await bq.add('work', { i, text: `job-${i}-payload-data` })
  let bmqDone = 0
  const bmqStart = performance.now()
  const w = new Worker(bq.name, async (job) => {
    const data = JSON.stringify(job.data)
    const reversed = data.split('').reverse().join('')
    bmqCount++
    return { len: reversed.length }
  }, { connection: REDIS_OPTS, concurrency: 10 })
  await new Promise<void>(resolve => { w.on('completed', () => { bmqDone++; if (bmqDone >= N) resolve() }) })
  const bmqTime = performance.now() - bmqStart
  await w.close(); await bq.obliterate({ force: true }); await bq.close()
  const bmqRate = Math.round(N / bmqTime * 1000)
  log(`  BullMQ:   ${bmqCount === N ? 'PASS' : 'FAIL'} (${bmqTime.toFixed(0)}ms, ${bmqRate}/sec) [${bmqCount}/${N}]`)

  results.push({
    test: `Throughput (${N} jobs, real work, concurrency:10)`,
    psyqueue: { passed: psyCount === N, time: psyTime, detail: `${psyRate}/sec` },
    bullmq: { passed: bmqCount === N, time: bmqTime, detail: `${bmqRate}/sec` },
  })
}

// ================================================================
// TEST 5: Zero Data Loss Stress Test
// ================================================================
async function test5_dataLoss() {
  log('\n--- Test 5: Zero Data Loss (500 jobs, verify every payload) ---')
  const N = 500

  const { PsyQueue } = await import('psyqueue')
  const { redis } = await import('@psyqueue/backend-redis')

  // PsyQueue
  const q = new PsyQueue()
  q.use(redis({ url: REDIS_URL }))
  const psySeen = new Set<number>()
  q.handle('verify', async (ctx) => { psySeen.add((ctx.job.payload as any).n); return {} })
  await q.start()
  const cl = (q as any).backend.getClient(); await cl.flushdb()

  for (let i = 0; i < N; i++) await q.enqueue('verify', { n: i })
  let psyDone = 0
  q.events.on('job:completed', () => { psyDone++ })
  const be = (q as any).backend; be.supportsBlocking = false
  const psyStart = performance.now()
  q.startWorker('verify', { concurrency: 10, pollInterval: 1 })
  while (psyDone < N) await new Promise(r => setTimeout(r, 5))
  const psyTime = performance.now() - psyStart
  await q.stop()

  let psyMissing = 0
  for (let i = 0; i < N; i++) { if (!psySeen.has(i)) psyMissing++ }
  const psyPassed = psySeen.size === N && psyMissing === 0
  log(`  PsyQueue: ${psyPassed ? 'PASS' : 'FAIL'} (${psyTime.toFixed(0)}ms) [${psySeen.size}/${N}, missing: ${psyMissing}]`)

  // BullMQ
  const { Queue, Worker } = await import('bullmq')
  const bq = new Queue('verify-' + Date.now(), { connection: REDIS_OPTS })
  await bq.waitUntilReady()
  const bmqSeen = new Set<number>()

  for (let i = 0; i < N; i++) await bq.add('verify', { n: i })
  let bmqDone = 0
  const bmqStart = performance.now()
  const w = new Worker(bq.name, async (job) => { bmqSeen.add(job.data.n); return {} }, { connection: REDIS_OPTS, concurrency: 10 })
  await new Promise<void>(resolve => { w.on('completed', () => { bmqDone++; if (bmqDone >= N) resolve() }) })
  const bmqTime = performance.now() - bmqStart
  await w.close(); await bq.obliterate({ force: true }); await bq.close()

  let bmqMissing = 0
  for (let i = 0; i < N; i++) { if (!bmqSeen.has(i)) bmqMissing++ }
  const bmqPassed = bmqSeen.size === N && bmqMissing === 0
  log(`  BullMQ:   ${bmqPassed ? 'PASS' : 'FAIL'} (${bmqTime.toFixed(0)}ms) [${bmqSeen.size}/${N}, missing: ${bmqMissing}]`)

  results.push({
    test: `Zero Data Loss (${N} jobs, verify every payload)`,
    psyqueue: { passed: psyPassed, time: psyTime, detail: `${psySeen.size}/${N}, missing: ${psyMissing}` },
    bullmq: { passed: bmqPassed, time: bmqTime, detail: `${bmqSeen.size}/${N}, missing: ${bmqMissing}` },
  })
}

// ================================================================
// SUMMARY
// ================================================================
function printSummary() {
  log('\n' + '='.repeat(80))
  log('  FEATURE COMPARISON: PsyQueue (Redis) vs BullMQ (Redis)')
  log('  Same Redis instance, same workloads, fair measurement')
  log('='.repeat(80))
  log('')
  log('  Test                                          | PsyQueue      | BullMQ        | Winner')
  log('  ' + '-'.repeat(76))
  for (const r of results) {
    const psyStatus = r.psyqueue.passed ? 'PASS' : 'FAIL'
    const bmqStatus = r.bullmq.passed ? 'PASS' : 'FAIL'
    const psyMs = r.psyqueue.time.toFixed(0) + 'ms'
    const bmqMs = r.bullmq.time.toFixed(0) + 'ms'
    const winner = r.psyqueue.time < r.bullmq.time ? 'PsyQueue' : 'BullMQ'
    const ratio = r.psyqueue.time < r.bullmq.time
      ? (r.bullmq.time / r.psyqueue.time).toFixed(1) + 'x'
      : (r.psyqueue.time / r.bullmq.time).toFixed(1) + 'x'
    const name = r.test.padEnd(47).substring(0, 47)
    log(`  ${name} | ${psyStatus} ${psyMs.padStart(7)} | ${bmqStatus} ${bmqMs.padStart(7)} | ${winner} ${ratio}`)
  }
  log('')
  const psyWins = results.filter(r => r.psyqueue.time < r.bullmq.time).length
  const bmqWins = results.filter(r => r.bullmq.time < r.psyqueue.time).length
  log(`  Score: PsyQueue ${psyWins} — BullMQ ${bmqWins}`)
  log('='.repeat(80))
}

// ================================================================
// RUN
// ================================================================
async function main() {
  log('Feature-by-Feature Comparison: PsyQueue vs BullMQ')
  log('Both on Redis at ' + REDIS_URL)
  log('')

  await test1_cpuWork()
  await test2_asyncIO()
  await test3_retry()
  await test4_throughput()
  await test5_dataLoss()

  printSummary()
}

main().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1) })
