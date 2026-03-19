#!/usr/bin/env node
import { Command } from 'commander'

export function createProgram(): Command {
  const program = new Command()

  program
    .name('psyqueue')
    .description('PsyQueue CLI tools')
    .version('0.1.0')

  // ── migrate ─────────────────────────────────────────────────────────────
  program
    .command('migrate')
    .description('Migrate jobs between backends')
    .requiredOption('--from <uri>', 'Source backend URI')
    .requiredOption('--to <uri>', 'Destination backend URI')
    .option('--dry-run', 'Preview migration without executing', false)
    .action((opts: { from: string; to: string; dryRun: boolean }) => {
      console.log('Migration plan:')
      console.log(`  Source:      ${opts.from}`)
      console.log(`  Destination: ${opts.to}`)
      console.log(`  Dry run:     ${opts.dryRun}`)
      console.log('')
      console.log('Steps:')
      console.log('  1. Connect to source backend')
      console.log('  2. Read all jobs (pending, scheduled, dead)')
      console.log('  3. Connect to destination backend')
      console.log('  4. Bulk-enqueue jobs to destination')
      console.log('  5. Verify counts match')
      console.log('')
      console.log('[stub] Migration not yet implemented — this is a preview.')
    })

  // ── audit ───────────────────────────────────────────────────────────────
  const audit = program
    .command('audit')
    .description('Audit log verification commands')

  audit
    .command('verify')
    .description('Verify audit log hash chain integrity')
    .requiredOption('--store <path>', 'Path to the audit log store')
    .action((opts: { store: string }) => {
      console.log(`Verifying hash chain integrity for store: ${opts.store}`)
      console.log('')
      console.log('Steps:')
      console.log('  1. Read audit log entries sequentially')
      console.log('  2. Recompute SHA-256 chain for each entry')
      console.log('  3. Compare computed hash with stored hash')
      console.log('  4. Report any broken links')
      console.log('')
      console.log('[stub] Audit verification not yet implemented — this is a preview.')
    })

  // ── replay ──────────────────────────────────────────────────────────────
  program
    .command('replay')
    .description('Replay dead-lettered jobs')
    .requiredOption('--queue <name>', 'Queue name to replay dead-lettered jobs from')
    .option('--limit <n>', 'Maximum number of jobs to replay')
    .action((opts: { queue: string; limit?: string }) => {
      const limit = opts.limit ? parseInt(opts.limit, 10) : undefined
      console.log(`Replaying dead-lettered jobs from queue: ${opts.queue}`)
      if (limit) console.log(`  Limit: ${limit}`)
      console.log('')
      console.log('Steps:')
      console.log('  1. Connect to backend')
      console.log(`  2. List dead-lettered jobs in queue "${opts.queue}"`)
      console.log('  3. Re-enqueue each job with status reset to pending')
      console.log('  4. Report replayed count')
      console.log('')
      console.log('[stub] Replay not yet implemented — this is a preview.')
    })

  return program
}

// Run if invoked directly
const isDirectExecution = process.argv[1] && (
  process.argv[1].endsWith('/psyqueue') ||
  process.argv[1].endsWith('\\psyqueue') ||
  process.argv[1].endsWith('/index.js') ||
  process.argv[1].endsWith('\\index.js')
)

if (isDirectExecution) {
  createProgram().parse(process.argv)
}
