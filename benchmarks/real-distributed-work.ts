/**
 * REAL DISTRIBUTED WORK — PsyQueue on Real Redis
 *
 * 5 tests that perform ACTUAL work (file I/O, computation, data transforms)
 * using multiple PsyQueue instances competing on real Redis.
 *
 * Redis: 127.0.0.1:6381
 */

import { PsyQueue, QueueEvents } from '../packages/core/src/index.js'
import { redis } from '../packages/backend-redis/src/index.js'
import RedisModule from 'ioredis'
import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'

const Redis = (RedisModule as any).default ?? RedisModule

// --- Config ------------------------------------------------------------------

const REDIS_HOST = '127.0.0.1'
const REDIS_PORT = 6381
const REDIS_URL = `redis://${REDIS_HOST}:${REDIS_PORT}`
const WORK_DIR = path.resolve(import.meta.dirname ?? '.', 'work-output')

// --- Utilities ---------------------------------------------------------------

const write = (s: string) => process.stdout.write(s)
const writeln = (s: string) => process.stdout.write(s + '\n')

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

let passed = 0
let failed = 0

function assert(condition: boolean, label: string): void {
  if (condition) {
    passed++
    writeln(`  [PASS] ${label}`)
  } else {
    failed++
    writeln(`  [FAIL] ${label}`)
  }
}

async function flushRedis(): Promise<void> {
  const c = new Redis({ host: REDIS_HOST, port: REDIS_PORT })
  await new Promise<void>((resolve, reject) => {
    c.once('ready', resolve)
    c.once('error', reject)
    if (c.status === 'ready') resolve()
  })
  await c.flushdb()
  await c.quit()
}

function createPQ(): PsyQueue {
  const q = new PsyQueue()
  q.use(redis({ host: REDIS_HOST, port: REDIS_PORT }))
  return q
}

function disableBlocking(q: PsyQueue): void {
  const be = (q as any).backend
  if (be) be.supportsBlocking = false
}

function cleanWorkDir(): void {
  if (fs.existsSync(WORK_DIR)) {
    fs.rmSync(WORK_DIR, { recursive: true, force: true })
  }
  fs.mkdirSync(WORK_DIR, { recursive: true })
}

function ensureSubDir(name: string): string {
  const dir = path.join(WORK_DIR, name)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return dir
}

// --- Test 1: FILE WRITING (3 distributed workers) ----------------------------
//
// 3 separate PsyQueue instances all connect to the same Redis, each handles
// 'write-file'. A 4th instance enqueues 30 jobs. Workers compete.
// Verify: 30 files on disk, work distributed across workers, content correct.

async function test1_fileWriting(): Promise<void> {
  writeln('\n================================================================')
  writeln('TEST 1: FILE WRITING — 3 distributed workers, 30 jobs')
  writeln('================================================================')

  await flushRedis()
  const dir = ensureSubDir('test1-files')

  // Track which worker processed each job
  const workerCounts: Record<string, number> = { w1: 0, w2: 0, w3: 0 }

  // Create 3 worker instances
  const workers: PsyQueue[] = []
  for (let i = 0; i < 3; i++) {
    const w = createPQ()
    const workerId = `w${i + 1}`
    w.handle('write-file', async (ctx) => {
      const { index, content } = ctx.job.payload as { index: number; content: string }
      const filePath = path.join(dir, `file-${String(index).padStart(3, '0')}.txt`)
      // Real file I/O: write content + worker tag
      const data = `INDEX=${index}\nWORKER=${workerId}\nCONTENT=${content}\nHASH=${crypto.createHash('sha256').update(content).digest('hex')}`
      fs.writeFileSync(filePath, data, 'utf-8')
      workerCounts[workerId]++
      return { file: filePath, worker: workerId }
    })
    await w.start()
    disableBlocking(w)
    w.startWorker('write-file', { concurrency: 5, pollInterval: 20 })
    workers.push(w)
  }

  // 4th instance: producer only
  const producer = createPQ()
  await producer.start()

  // Enqueue 30 jobs
  for (let i = 0; i < 30; i++) {
    await producer.enqueue('write-file', {
      index: i,
      content: `Job payload #${i} — ${crypto.randomBytes(32).toString('hex')}`,
    })
  }
  writeln('  Enqueued 30 write-file jobs')

  // Wait for processing
  await sleep(3000)

  // Stop everything
  await producer.stop()
  for (const w of workers) await w.stop()

  // Verify files
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.txt'))
  assert(files.length === 30, `30 files created on disk (got ${files.length})`)

  // Verify content correctness
  let allCorrect = true
  for (const file of files) {
    const data = fs.readFileSync(path.join(dir, file), 'utf-8')
    const lines = data.split('\n')
    const indexLine = lines.find(l => l.startsWith('INDEX='))
    const contentLine = lines.find(l => l.startsWith('CONTENT='))
    const hashLine = lines.find(l => l.startsWith('HASH='))
    if (!indexLine || !contentLine || !hashLine) { allCorrect = false; continue }
    const content = contentLine.replace('CONTENT=', '')
    const expectedHash = crypto.createHash('sha256').update(content).digest('hex')
    if (hashLine.replace('HASH=', '') !== expectedHash) allCorrect = false
  }
  assert(allCorrect, 'All file contents and SHA-256 hashes correct')

  // Verify distribution
  const activeWorkers = Object.values(workerCounts).filter(c => c > 0).length
  assert(activeWorkers >= 2, `Work distributed across ${activeWorkers} workers (need >=2)`)
  writeln(`  Distribution: w1=${workerCounts.w1}, w2=${workerCounts.w2}, w3=${workerCounts.w3}`)
}

// --- Test 2: MATH SOLVER — Factorize 50 numbers -----------------------------
//
// PsyQueue + worker factorizes 50 numbers, writes results to files.
// Verify: product of factors equals the original number for each.

async function test2_mathSolver(): Promise<void> {
  writeln('\n================================================================')
  writeln('TEST 2: MATH SOLVER — Factorize 50 numbers, verify products')
  writeln('================================================================')

  await flushRedis()
  const dir = ensureSubDir('test2-factors')

  function primeFactors(n: number): number[] {
    const factors: number[] = []
    let d = 2
    while (d * d <= n) {
      while (n % d === 0) {
        factors.push(d)
        n /= d
      }
      d++
    }
    if (n > 1) factors.push(n)
    return factors
  }

  const q = createPQ()
  q.handle('factorize', async (ctx) => {
    const { number, index } = ctx.job.payload as { number: number; index: number }
    const factors = primeFactors(number)
    const product = factors.reduce((a, b) => a * b, 1)
    // Write result to file
    const filePath = path.join(dir, `factor-${String(index).padStart(3, '0')}.json`)
    fs.writeFileSync(filePath, JSON.stringify({ number, factors, product }), 'utf-8')
    return { number, factors, product }
  })

  await q.start()
  disableBlocking(q)
  q.startWorker('factorize', { concurrency: 10, pollInterval: 20 })

  // Generate 50 semi-large composite numbers
  const numbers: number[] = []
  for (let i = 0; i < 50; i++) {
    // Random composite between 100000 and 9999999
    numbers.push(100000 + Math.floor(Math.random() * 9900000))
  }

  for (let i = 0; i < numbers.length; i++) {
    await q.enqueue('factorize', { number: numbers[i], index: i })
  }
  writeln(`  Enqueued 50 factorization jobs`)

  await sleep(3000)
  await q.stop()

  // Verify all result files
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'))
  assert(files.length === 50, `50 result files created (got ${files.length})`)

  let allProductsMatch = true
  for (const file of files) {
    const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8'))
    const product = (data.factors as number[]).reduce((a: number, b: number) => a * b, 1)
    if (product !== data.number) {
      allProductsMatch = false
      writeln(`    MISMATCH: ${data.number} != product(${data.factors}) = ${product}`)
    }
  }
  assert(allProductsMatch, 'Product of factors equals original for all 50 numbers')
}

// --- Test 3: CSV TO JSON — 20 jobs transform CSV to JSON ---------------------
//
// Each job receives CSV data, parses it, writes a JSON file.
// Verify: all JSON files are valid and contain the right data.

async function test3_csvToJson(): Promise<void> {
  writeln('\n================================================================')
  writeln('TEST 3: CSV TO JSON — 20 transforms, verify JSON validity')
  writeln('================================================================')

  await flushRedis()
  const dir = ensureSubDir('test3-csv-json')

  const q = createPQ()
  q.handle('csv-to-json', async (ctx) => {
    const { csv, index } = ctx.job.payload as { csv: string; index: number }

    // Parse CSV manually (first row = headers, rest = data)
    const lines = csv.trim().split('\n')
    const headers = lines[0]!.split(',')
    const rows = lines.slice(1).map(line => {
      const values = line.split(',')
      const obj: Record<string, string> = {}
      headers.forEach((h, i) => { obj[h.trim()] = (values[i] ?? '').trim() })
      return obj
    })

    // Write JSON output
    const filePath = path.join(dir, `data-${String(index).padStart(3, '0')}.json`)
    fs.writeFileSync(filePath, JSON.stringify({ headers, rows, rowCount: rows.length }, null, 2), 'utf-8')
    return { rowCount: rows.length, file: filePath }
  })

  await q.start()
  disableBlocking(q)
  q.startWorker('csv-to-json', { concurrency: 5, pollInterval: 20 })

  // Generate 20 CSV payloads
  for (let i = 0; i < 20; i++) {
    const rowCount = 5 + Math.floor(Math.random() * 10) // 5-14 rows
    let csv = 'id,name,email,score\n'
    for (let r = 0; r < rowCount; r++) {
      csv += `${r + 1},user_${r}_batch${i},user${r}_b${i}@test.com,${Math.floor(Math.random() * 100)}\n`
    }
    await q.enqueue('csv-to-json', { csv, index: i })
  }
  writeln('  Enqueued 20 csv-to-json jobs')

  await sleep(3000)
  await q.stop()

  // Verify JSON files
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'))
  assert(files.length === 20, `20 JSON files created (got ${files.length})`)

  let allValid = true
  let totalRows = 0
  for (const file of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8'))
      if (!Array.isArray(data.headers) || !Array.isArray(data.rows) || typeof data.rowCount !== 'number') {
        allValid = false
      }
      if (data.rows.length !== data.rowCount) {
        allValid = false
      }
      totalRows += data.rowCount
      // Verify each row has expected fields
      for (const row of data.rows) {
        if (!row.id || !row.name || !row.email || row.score === undefined) {
          allValid = false
        }
      }
    } catch {
      allValid = false
    }
  }
  assert(allValid, `All JSON files valid with correct structure (${totalRows} total rows)`)
}

// --- Test 4: ENCRYPT/DECRYPT — Round-trip verification -----------------------
//
// 10 encrypt jobs; on completion each enqueues a decrypt job.
// Verify: decrypted text matches original plaintext.

async function test4_encryptDecrypt(): Promise<void> {
  writeln('\n================================================================')
  writeln('TEST 4: ENCRYPT/DECRYPT — 10 encrypt + 10 decrypt, round-trip')
  writeln('================================================================')

  await flushRedis()
  const dir = ensureSubDir('test4-crypto')

  // Shared key and IV for AES-256-CBC
  const key = crypto.scryptSync('psyqueue-test-password', 'salt', 32)

  const originals: Map<number, string> = new Map()
  const decryptedResults: Map<number, string> = new Map()

  const q = createPQ()

  q.handle('encrypt', async (ctx) => {
    const { plaintext, index } = ctx.job.payload as { plaintext: string; index: number }
    const iv = crypto.randomBytes(16)
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv)
    let encrypted = cipher.update(plaintext, 'utf-8', 'hex')
    encrypted += cipher.final('hex')
    const ivHex = iv.toString('hex')

    // Write encrypted file
    const filePath = path.join(dir, `encrypted-${index}.json`)
    fs.writeFileSync(filePath, JSON.stringify({ index, iv: ivHex, encrypted }), 'utf-8')

    // Enqueue a decrypt job from within the handler
    await ctx.enqueue('decrypt', { index, iv: ivHex, encrypted })

    return { encrypted, iv: ivHex }
  })

  q.handle('decrypt', async (ctx) => {
    const { index, iv, encrypted } = ctx.job.payload as { index: number; iv: string; encrypted: string }
    const ivBuf = Buffer.from(iv, 'hex')
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, ivBuf)
    let decrypted = decipher.update(encrypted, 'hex', 'utf-8')
    decrypted += decipher.final('utf-8')

    // Write decrypted file
    const filePath = path.join(dir, `decrypted-${index}.json`)
    fs.writeFileSync(filePath, JSON.stringify({ index, decrypted }), 'utf-8')

    decryptedResults.set(index, decrypted)
    return { decrypted }
  })

  await q.start()
  disableBlocking(q)
  q.startWorker('encrypt', { concurrency: 5, pollInterval: 20 })
  q.startWorker('decrypt', { concurrency: 5, pollInterval: 20 })

  // Enqueue 10 encrypt jobs with known plaintexts
  for (let i = 0; i < 10; i++) {
    const plaintext = `Secret message #${i}: ${crypto.randomBytes(16).toString('base64')}`
    originals.set(i, plaintext)
    await q.enqueue('encrypt', { plaintext, index: i })
  }
  writeln('  Enqueued 10 encrypt jobs (each chains to a decrypt job)')

  // Wait for both encrypt and decrypt to complete
  await sleep(4000)
  await q.stop()

  // Verify encrypted files exist
  const encFiles = fs.readdirSync(dir).filter(f => f.startsWith('encrypted-'))
  assert(encFiles.length === 10, `10 encrypted files created (got ${encFiles.length})`)

  // Verify decrypted files exist
  const decFiles = fs.readdirSync(dir).filter(f => f.startsWith('decrypted-'))
  assert(decFiles.length === 10, `10 decrypted files created (got ${decFiles.length})`)

  // Verify round-trip: read decrypted files and compare to originals
  let allMatch = true
  for (let i = 0; i < 10; i++) {
    const decPath = path.join(dir, `decrypted-${i}.json`)
    if (!fs.existsSync(decPath)) { allMatch = false; continue }
    const data = JSON.parse(fs.readFileSync(decPath, 'utf-8'))
    if (data.decrypted !== originals.get(i)) {
      allMatch = false
      writeln(`    MISMATCH at index ${i}`)
    }
  }
  assert(allMatch, 'All 10 decrypted texts match original plaintexts')
}

// --- Test 5: CROSS-PROCESS EVENTS --------------------------------------------
//
// Server A enqueues jobs, Server B processes them, QueueEvents monitor
// observes the completed events across Redis Pub/Sub connections.
// The Redis backend publishes 'completed' and 'failed' events via Pub/Sub.
// We also use the wildcard '*' listener to prove all events are received.

async function test5_crossProcessEvents(): Promise<void> {
  writeln('\n================================================================')
  writeln('TEST 5: CROSS-PROCESS EVENTS — QueueEvents monitors across instances')
  writeln('================================================================')

  await flushRedis()

  const completedSeen: string[] = []
  const allEventsSeen: Array<{ event: string; jobId: string }> = []

  // QueueEvents monitor — separate Redis connections, like a different process
  const monitor = new QueueEvents({ url: REDIS_URL, queue: 'event-test' })
  monitor.on('completed', (data) => {
    completedSeen.push(data.jobId)
  })
  monitor.on('*', (data) => {
    allEventsSeen.push({ event: data.event, jobId: data.jobId })
  })
  await monitor.start()
  writeln('  QueueEvents monitor started (listening for completed + wildcard)')

  // Server B: worker instance
  const serverB = createPQ()
  serverB.handle('event-test', async (ctx) => {
    const { value } = ctx.job.payload as { value: number }
    // Real work: compute fibonacci
    let a = 0, b = 1
    for (let i = 2; i <= value; i++) {
      const c = a + b; a = b; b = c
    }
    return { fib: b }
  })
  await serverB.start()
  disableBlocking(serverB)
  serverB.startWorker('event-test', { concurrency: 3, pollInterval: 20 })

  // Server A: producer instance
  const serverA = createPQ()
  await serverA.start()

  const jobIds: string[] = []
  for (let i = 0; i < 10; i++) {
    const id = await serverA.enqueue('event-test', { value: 20 + i }, { queue: 'event-test' })
    jobIds.push(id)
  }
  writeln(`  Server A enqueued 10 jobs, Server B processing`)

  // Wait for processing + event propagation
  await sleep(3000)

  await serverA.stop()
  await serverB.stop()
  await monitor.stop()

  // Verify completed events observed via Pub/Sub
  assert(completedSeen.length >= 8, `QueueEvents saw ${completedSeen.length} completed events (need >=8)`)

  // Verify we saw completed events for the actual job IDs we enqueued
  const completedOverlap = jobIds.filter(id => completedSeen.includes(id))
  assert(completedOverlap.length >= 8, `Matched ${completedOverlap.length} completed job IDs (need >=8)`)

  // Verify wildcard listener caught all completed events too
  const wildcardCompleted = allEventsSeen.filter(e => e.event === 'completed')
  assert(wildcardCompleted.length >= 8, `Wildcard '*' caught ${wildcardCompleted.length} completed events (need >=8)`)

  // Verify events carry correct job IDs (not empty strings)
  const validIds = allEventsSeen.filter(e => e.jobId && e.jobId.length > 0)
  assert(validIds.length === allEventsSeen.length, `All ${allEventsSeen.length} events have valid job IDs`)
}

// --- Main --------------------------------------------------------------------

async function main(): Promise<void> {
  writeln('================================================================')
  writeln('  REAL DISTRIBUTED WORK — PsyQueue on Redis')
  writeln('  5 tests: file I/O, computation, transforms, crypto, events')
  writeln('================================================================')

  cleanWorkDir()
  writeln(`Work directory: ${WORK_DIR}`)

  const t0 = Date.now()

  await test1_fileWriting()
  await test2_mathSolver()
  await test3_csvToJson()
  await test4_encryptDecrypt()
  await test5_crossProcessEvents()

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1)

  writeln('\n================================================================')
  writeln(`  RESULTS: ${passed} passed, ${failed} failed (${elapsed}s)`)
  writeln('================================================================')

  // Cleanup work dir
  try { fs.rmSync(WORK_DIR, { recursive: true, force: true }) } catch {}

  process.exit(failed > 0 ? 1 : 0)
}

main().catch(err => {
  writeln(`\nFATAL: ${err.message}`)
  writeln(err.stack ?? '')
  process.exit(1)
})
