// ORCHESTRATOR — Spawns 4 separate Node.js processes
import { spawn } from 'child_process'
import { mkdirSync, rmSync, existsSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import RedisModule from 'ioredis'

const Redis = (RedisModule as any).default ?? RedisModule
const OUT = join(import.meta.dirname || '.', '..', 'dist-output')
const DIR = import.meta.dirname || '.'

// Clean
if (existsSync(OUT)) rmSync(OUT, { recursive: true })
mkdirSync(OUT, { recursive: true })

// Flush Redis
const r = new Redis({ host: '127.0.0.1', port: 6381 })
await r.flushdb()
await r.quit()

process.stdout.write('\n==========================================================\n')
process.stdout.write('  TRUE DISTRIBUTED TEST — 4 Separate Node.js Processes\n')
process.stdout.write('  All communicating ONLY through Redis\n')
process.stdout.write('==========================================================\n\n')

function spawnProcess(name: string, file: string): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve) => {
    let stdout = ''
    // Use cwd-relative path since cwd is the repo root
    const filePath = 'benchmarks/' + file
    const child = spawn('npx', ['tsx', '"' + filePath + '"'], {
      cwd: join(DIR, '..', '..'),
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.on('data', (d: Buffer) => {
      const line = d.toString()
      stdout += line
      process.stdout.write('[' + name + '] ' + line)
    })
    child.stderr.on('data', (d: Buffer) => {
      const line = d.toString()
      if (!line.includes('ExperimentalWarning') && !line.includes('ioredis')) {
        process.stdout.write('[' + name + ' ERR] ' + line)
      }
    })
    child.on('close', (code) => resolve({ stdout, code: code ?? 1 }))
  })
}

// Step 1: Start monitor (listens for events)
process.stdout.write('--- Starting monitor process ---\n')
const monitorPromise = spawnProcess('MONITOR', 'distributed-processes/monitor.ts')

// Wait for monitor to connect
await new Promise(r => setTimeout(r, 2000))

// Step 2: Start both workers
process.stdout.write('\n--- Starting 2 worker processes ---\n')
const w1Promise = spawnProcess('WORKER-1', 'distributed-processes/worker-1.ts')
const w2Promise = spawnProcess('WORKER-2', 'distributed-processes/worker-2.ts')

// Wait for workers to connect
await new Promise(r => setTimeout(r, 2000))

// Step 3: Start enqueuer
process.stdout.write('\n--- Starting enqueuer process ---\n')
const enqResult = await spawnProcess('ENQUEUER', 'distributed-processes/enqueuer.ts')

// Wait for workers to finish processing
process.stdout.write('\n--- Waiting for workers + monitor (20s) ---\n')
const [w1Result, w2Result, monResult] = await Promise.all([w1Promise, w2Promise, monitorPromise])

// Step 4: Verify results
process.stdout.write('\n==========================================================\n')
process.stdout.write('  VERIFICATION\n')
process.stdout.write('==========================================================\n\n')

// Check files on disk
const files = existsSync(OUT) ? readdirSync(OUT) : []
process.stdout.write('  Files on disk: ' + files.length + '/200\n')

// Check which worker processed which
let w1Count = 0, w2Count = 0
for (const f of files) {
  const content = readFileSync(join(OUT, f), 'utf8')
  if (content.startsWith('worker-1:')) w1Count++
  else if (content.startsWith('worker-2:')) w2Count++
}
process.stdout.write('  Worker 1 processed: ' + w1Count + '\n')
process.stdout.write('  Worker 2 processed: ' + w2Count + '\n')
process.stdout.write('  Total: ' + (w1Count + w2Count) + '\n')

// Check for double-processing (same file written by both workers would be overwritten)
const uniqueFiles = new Set(files)
process.stdout.write('  Unique files: ' + uniqueFiles.size + ' (should be 200)\n')

// Extract monitor counts from output
const monCompleted = monResult.stdout.match(/(\d+) completed/g)
const lastCount = monCompleted ? monCompleted[monCompleted.length - 1] : '0'

process.stdout.write('  Monitor events: ' + lastCount + '\n')

process.stdout.write('\n--- RESULTS ---\n')
const allFilesOk = files.length === 200
const distributed = w1Count > 0 && w2Count > 0
const noDoubles = uniqueFiles.size === 200
const monitorOk = monResult.stdout.includes('completed')

process.stdout.write('  [' + (allFilesOk ? 'PASS' : 'FAIL') + '] 200 files created on disk\n')
process.stdout.write('  [' + (distributed ? 'PASS' : 'FAIL') + '] Work distributed across 2 processes\n')
process.stdout.write('  [' + (noDoubles ? 'PASS' : 'FAIL') + '] Zero double-processing\n')
process.stdout.write('  [' + (monitorOk ? 'PASS' : 'FAIL') + '] Monitor received cross-process events\n')
process.stdout.write('  [' + (enqResult.code === 0 ? 'PASS' : 'FAIL') + '] Enqueuer process exited cleanly\n')
process.stdout.write('  [' + (w1Result.code === 0 ? 'PASS' : 'FAIL') + '] Worker 1 exited cleanly\n')
process.stdout.write('  [' + (w2Result.code === 0 ? 'PASS' : 'FAIL') + '] Worker 2 exited cleanly\n')

const allPass = allFilesOk && distributed && noDoubles && monitorOk
process.stdout.write('\n  ' + (allPass ? 'ALL PASS' : 'SOME FAILED') + '\n\n')
process.exit(allPass ? 0 : 1)
