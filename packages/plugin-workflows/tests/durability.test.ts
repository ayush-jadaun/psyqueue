/**
 * Workflow guarantees across restarts and multiple processes, on every
 * backend. Two PsyQueue instances on one store stand in for two processes.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PsyQueue } from '../../core/src/index.js'
import type { BackendAdapter, PsyPlugin, Job } from '../../core/src/index.js'
import { sqlite } from '../../backend-sqlite/src/index.js'
import { redis } from '../../backend-redis/src/index.js'
import { postgres } from '../../backend-postgres/src/index.js'
import { workflows, workflow } from '../src/index.js'
import type { WorkflowDefinition, WorkflowEngine } from '../src/index.js'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const PG_URL = 'postgres://psyqueue:psyqueue@localhost:5432/psyqueue_test'
const tmp = mkdtempSync(join(tmpdir(), 'psyq-wf-'))
let n = 0
const uid = () => `${Date.now().toString(36)}${n++}`

async function reachable(plugin: PsyPlugin): Promise<boolean> {
  const q = new PsyQueue()
  q.use(plugin)
  try {
    await Promise.race([q.start(), sleep(1500).then(() => { throw new Error('timeout') })])
    await q.stop()
    return true
  } catch {
    await q.stop().catch(() => {})
    return false
  }
}

const cases = [
  { name: 'sqlite', available: true, plugin: (s: string) => sqlite({ path: join(tmp, `${s}.db`) }) },
  { name: 'redis', available: await reachable(redis({ keyPrefix: 'psyq_probe' })), plugin: (s: string) => redis({ keyPrefix: `psyq_wf_${s}` }) },
  { name: 'postgres', available: await reachable(postgres({ connectionString: PG_URL })), plugin: (_s: string) => postgres({ connectionString: PG_URL }) },
]

for (const bc of cases) {
  describe.skipIf(!bc.available)(`workflow durability – ${bc.name}`, () => {
    const open: PsyQueue[] = []
    afterEach(async () => { for (const q of open.splice(0)) await q.stop().catch(() => {}) })

    /** A "process": its own PsyQueue + workflows plugin on the shared store. */
    async function proc(shared: string, def: WorkflowDefinition, opts: { latencyMs?: number } = {}) {
      const q = new PsyQueue()
      const wf = workflows()
      q.use(bc.plugin(shared))
      q.use(wf)
      wf.engine.registerDefinition(def)
      q.handle(def.name, wf.engine.createHandler(def.name))
      await q.start()
      if (opts.latencyMs) {
        // Simulate network latency to the backend, which widens race windows
        const backend = q.getExposed('backend') as unknown as BackendAdapter
        const enqueue = backend.enqueue.bind(backend)
        backend.enqueue = async (job: Job) => { await sleep(opts.latencyMs!); return enqueue(job) }
      }
      open.push(q)
      return { q, engine: wf.engine as WorkflowEngine }
    }

    async function waitFor(engine: WorkflowEngine, id: string, statuses: string[], ms = 8000) {
      const deadline = Date.now() + ms
      while (Date.now() < deadline) {
        const inst = await engine.store.get(id)
        if (inst && statuses.includes(inst.status)) return inst
        await sleep(25)
      }
      return engine.store.get(id)
    }

    it('continues a workflow after a restart, with earlier results', async () => {
      const shared = uid()
      const name = `restart_${shared}`
      let seenA: unknown
      const def = () => workflow(name)
        .step('a', async () => ({ token: 'A1' }))
        .step('b', async (ctx) => { seenA = ctx.results?.['a']; return 'B' }, { after: 'a' })
        .build()

      const first = await proc(shared, def())
      const id = await first.q.enqueue(name, { order: 7 })
      await first.q.processNext(name) // step a
      await first.q.stop()

      const second = await proc(shared, def())
      await second.q.processNext(name) // step b, in the "restarted" process
      const inst = await second.engine.store.get(id)
      expect(inst!.status).toBe('COMPLETED')
      expect(seenA).toEqual({ token: 'A1' })
      expect(inst!.payload).toEqual({ order: 7 })
    })

    it('runs every step exactly once with two processes, fan-in, and backend latency', async () => {
      const shared = uid()
      const name = `race_${shared}`
      const runs: Record<string, number> = {}
      const count = (s: string) => async () => { runs[s] = (runs[s] ?? 0) + 1; await sleep(2); return s }
      const def = () => workflow(name)
        .step('p1', count('p1'))
        .step('p2', count('p2'))
        .step('x', count('x'), { after: 'p1' })
        .step('join', count('join'), { after: ['p1', 'p2'] })
        .build()

      const a = await proc(shared, def(), { latencyMs: 3 })
      const b = await proc(shared, def(), { latencyMs: 3 })
      const ids: string[] = []
      for (let i = 0; i < 10; i++) ids.push(await a.q.enqueue(name, { i }))
      a.q.startWorker(name, { concurrency: 5, pollInterval: 5 })
      b.q.startWorker(name, { concurrency: 5, pollInterval: 5 })

      for (const id of ids) expect((await waitFor(a.engine, id, ['COMPLETED']))!.status).toBe('COMPLETED')
      expect(runs).toEqual({ p1: 10, p2: 10, x: 10, join: 10 })
    }, 20_000)

    it('retries a failing step instead of failing the workflow', async () => {
      const shared = uid()
      const name = `retry_${shared}`
      let attempts = 0
      const p = await proc(shared, workflow(name)
        .step('flaky', async () => { if (++attempts < 3) throw new Error('timeout'); return 'ok' }, { maxRetries: 3, backoff: 'fixed', backoffBase: 1 })
        .build())
      const id = await p.q.enqueue(name, {})
      p.q.startWorker(name, { pollInterval: 5 })
      expect((await waitFor(p.engine, id, ['COMPLETED', 'FAILED']))!.status).toBe('COMPLETED')
      expect(attempts).toBe(3)
    })

    it('cancel() stops queued steps from running', async () => {
      const shared = uid()
      const name = `cancel_${shared}`
      const ran: string[] = []
      const p = await proc(shared, workflow(name)
        .step('a', async () => { ran.push('a') })
        .build())
      const id = await p.q.enqueue(name, {})
      expect(await p.engine.cancel(id)).toBe(true)
      await p.q.processNext(name)
      expect(ran).toEqual([])
      const inst = await p.engine.store.get(id)
      expect(inst!.status).toBe('CANCELLED')
      expect(inst!.stepStates['a']!.status).toBe('cancelled')
    })

    it('fails the workflow when a step is dead-lettered, once its siblings settle', async () => {
      const shared = uid()
      const name = `fail_${shared}`
      const failed: unknown[] = []
      const p = await proc(shared, workflow(name)
        .step('slow', async () => { await sleep(100); return 1 })
        .step('bad', async () => { throw new Error('boom') }, { maxRetries: 1 })
        .build())
      p.q.events.on('workflow:failed', e => { failed.push(e.data) })
      const id = await p.q.enqueue(name, {})
      p.q.startWorker(name, { concurrency: 2, pollInterval: 5 })
      const deadline = Date.now() + 5000
      while (failed.length === 0 && Date.now() < deadline) await sleep(20)
      // workflow:failed waits for the running sibling to settle
      expect((await p.engine.store.get(id))!.stepStates['slow']!.status).toBe('completed')
      expect(failed).toEqual([{ workflowId: id, definitionName: name, failedStep: 'bad', error: 'boom' }])
    })
  })
}
