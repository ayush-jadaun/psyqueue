/**
 * Dashboard & CLI Integration Test — REAL Redis
 *
 * Tests the dashboard API with actual PsyQueue + Redis backend,
 * and verifies CLI commands parse correctly.
 */

const REDIS_URL = 'redis://127.0.0.1:6381'
function log(msg: string) { process.stdout.write(msg + '\n') }

let passed = 0
let failed = 0

function assert(condition: boolean, name: string, detail: string = '') {
  if (condition) {
    passed++
    log(`  PASS: ${name}${detail ? ' — ' + detail : ''}`)
  } else {
    failed++
    log(`  FAIL: ${name}${detail ? ' — ' + detail : ''}`)
  }
}

// ================================================================
// DASHBOARD INTEGRATION TESTS (Real Redis)
// ================================================================
async function testDashboard() {
  log('\n=== Dashboard API (Real PsyQueue + Redis) ===\n')

  const { PsyQueue } = await import('psyqueue')
  const { redis } = await import('@psyqueue/backend-redis')
  const { createDashboardServer } = await import('@psyqueue/dashboard')

  // Create real PsyQueue with Redis
  const q = new PsyQueue()
  q.use(redis({ url: REDIS_URL }))
  q.handle('email', async () => ({ sent: true }))
  q.handle('payment', async () => { throw new Error('declined') })
  await q.start()
  const cl = (q as any).backend.getClient()
  await cl.flushdb()

  // Enqueue real jobs
  await q.enqueue('email', { to: 'alice@test.com' })
  await q.enqueue('email', { to: 'bob@test.com' })
  await q.enqueue('payment', { amount: 99 }, { maxRetries: 0 })

  // Process them
  await q.processNext('email')
  await q.processNext('email')
  await q.processNext('payment') // fails → dead letter

  // Start dashboard server
  const dashboard = createDashboardServer({
    port: 0,
    getBackend: () => (q as any).backend,
  })
  const server = await dashboard.start()
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 9999
  const base = `http://localhost:${port}`

  // Test 1: Health check
  const health = await fetch(`${base}/api/health`)
  assert(health.status === 200, 'Health check returns 200')

  // Test 2: Overview with real data
  const overview = await fetch(`${base}/api/overview`)
  const ovData = await overview.json() as any
  assert(overview.status === 200, 'Overview returns 200')
  assert(ovData.totalCompleted >= 2, 'Overview shows completed jobs', `completed=${ovData.totalCompleted}`)

  // Test 3: List queues
  const queues = await fetch(`${base}/api/queues`)
  const qData = await queues.json() as any
  assert(queues.status === 200, 'Queues endpoint returns 200')
  assert(qData.queues && qData.queues.length >= 1, 'Has at least 1 queue', `queues=${qData.queues?.length}`)

  // Test 4: Filter jobs by status
  const completedJobs = await fetch(`${base}/api/jobs?status=completed`)
  const cjData = await completedJobs.json() as any
  assert(completedJobs.status === 200, 'Jobs filter returns 200')
  assert(cjData.total >= 2, 'Shows completed email jobs', `total=${cjData.total}`)

  // Test 5: Get specific job
  if (cjData.data && cjData.data[0]) {
    const jobId = cjData.data[0].id
    const jobRes = await fetch(`${base}/api/jobs/${jobId}`)
    const jobData = await jobRes.json() as any
    assert(jobRes.status === 200, 'Get job by ID returns 200', `id=${jobId}`)
    assert(jobData.id === jobId, 'Returns correct job data')
  }

  // Test 6: 404 for nonexistent job
  const notFound = await fetch(`${base}/api/jobs/nonexistent-id-12345`)
  assert(notFound.status === 404, 'Returns 404 for unknown job')

  // Test 7: Dead letter jobs exist
  const deadJobs = await fetch(`${base}/api/jobs?status=dead`)
  const djData = await deadJobs.json() as any
  assert(djData.total >= 1, 'Dead-lettered payment job visible', `dead=${djData.total}`)

  // Test 8: Retry dead job via API
  if (djData.data && djData.data[0]) {
    const deadId = djData.data[0].id
    const retryRes = await fetch(`${base}/api/jobs/${deadId}/retry`, { method: 'POST' })
    const retryData = await retryRes.json() as any
    assert(retryRes.status === 200, 'Retry dead job returns 200')
    assert(retryData.success === true, 'Retry succeeds', `jobId=${retryData.jobId}`)
  }

  await dashboard.stop()
  await q.stop()
}

// ================================================================
// CLI TESTS (command parsing + real execution)
// ================================================================
async function testCLI() {
  log('\n=== CLI Commands ===\n')

  const { execSync } = await import('child_process')
  const cliPath = 'packages/cli/dist/index.js'

  // Test 1: --help
  try {
    const help = execSync(`node ${cliPath} --help`, { cwd: 'E:/Web dev/projects/job-queue', encoding: 'utf8' })
    assert(help.includes('migrate') || help.includes('audit') || help.includes('replay'), 'CLI --help shows commands', help.substring(0, 50).trim())
  } catch (e: any) {
    // commander exits with code 0 on --help which might throw
    const output = e.stdout || e.stderr || ''
    assert(output.includes('migrate') || output.includes('audit') || output.includes('replay'), 'CLI --help shows commands', output.substring(0, 50).trim())
  }

  // Test 2: migrate --help
  try {
    const mHelp = execSync(`node ${cliPath} migrate --help`, { cwd: 'E:/Web dev/projects/job-queue', encoding: 'utf8' })
    assert(mHelp.includes('--from') && mHelp.includes('--to'), 'migrate --help shows --from and --to')
  } catch (e: any) {
    const output = e.stdout || e.stderr || ''
    assert(output.includes('--from') && output.includes('--to'), 'migrate --help shows --from and --to')
  }

  // Test 3: migrate command execution (stub)
  try {
    const migrate = execSync(`node ${cliPath} migrate --from sqlite:///tmp/test.db --to redis://localhost:6381`, { cwd: 'E:/Web dev/projects/job-queue', encoding: 'utf8' })
    assert(migrate.includes('Migration') || migrate.includes('plan') || migrate.includes('stub'), 'migrate command runs', migrate.substring(0, 60).trim())
  } catch (e: any) {
    const output = e.stdout || e.stderr || ''
    assert(output.includes('Migration') || output.includes('plan') || output.includes('stub'), 'migrate command runs', output.substring(0, 60).trim())
  }

  // Test 4: audit verify (stub)
  try {
    const audit = execSync(`node ${cliPath} audit verify --store /tmp/audit.db`, { cwd: 'E:/Web dev/projects/job-queue', encoding: 'utf8' })
    assert(audit.includes('Verify') || audit.includes('hash') || audit.includes('chain') || audit.includes('stub'), 'audit verify runs', audit.substring(0, 60).trim())
  } catch (e: any) {
    const output = e.stdout || e.stderr || ''
    assert(output.includes('Verify') || output.includes('hash') || output.includes('chain') || output.includes('stub'), 'audit verify runs', output.substring(0, 60).trim())
  }

  // Test 5: replay (stub)
  try {
    const replay = execSync(`node ${cliPath} replay --queue emails`, { cwd: 'E:/Web dev/projects/job-queue', encoding: 'utf8' })
    assert(replay.includes('Replay') || replay.includes('dead') || replay.includes('stub'), 'replay command runs', replay.substring(0, 60).trim())
  } catch (e: any) {
    const output = e.stdout || e.stderr || ''
    assert(output.includes('Replay') || output.includes('dead') || output.includes('stub'), 'replay command runs', output.substring(0, 60).trim())
  }
}

// ================================================================
async function main() {
  log('Dashboard & CLI Integration Test')
  log('Redis: ' + REDIS_URL)

  await testDashboard()
  await testCLI()

  log('\n' + '='.repeat(60))
  log(`  Results: ${passed} passed, ${failed} failed, ${passed + failed} total`)
  log('='.repeat(60))

  if (failed > 0) process.exit(1)
}

main().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1) })
