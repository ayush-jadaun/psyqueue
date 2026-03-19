import { describe, it, expect } from 'vitest'
import { createProgram } from '../src/index.js'

describe('CLI', () => {
  it('parses migrate command with --from and --to', () => {
    const program = createProgram()
    program.exitOverride()

    const cmd = program.parse(['node', 'psyqueue', 'migrate', '--from', 'sqlite:///tmp/a.db', '--to', 'redis://localhost:6379'])
    const migrateCmd = cmd.commands.find(c => c.name() === 'migrate')!
    expect(migrateCmd.opts()['from']).toBe('sqlite:///tmp/a.db')
    expect(migrateCmd.opts()['to']).toBe('redis://localhost:6379')
  })

  it('parses audit verify command with --store', () => {
    const program = createProgram()
    program.exitOverride()

    const cmd = program.parse(['node', 'psyqueue', 'audit', 'verify', '--store', '/var/log/audit.db'])
    const auditCmd = cmd.commands.find(c => c.name() === 'audit')!
    const verifyCmd = auditCmd.commands.find(c => c.name() === 'verify')!
    expect(verifyCmd.opts()['store']).toBe('/var/log/audit.db')
  })

  it('parses replay command with --queue', () => {
    const program = createProgram()
    program.exitOverride()

    const cmd = program.parse(['node', 'psyqueue', 'replay', '--queue', 'emails'])
    const replayCmd = cmd.commands.find(c => c.name() === 'replay')!
    expect(replayCmd.opts()['queue']).toBe('emails')
  })

  it('shows help output', () => {
    const program = createProgram()
    const helpText = program.helpInformation()
    expect(helpText).toContain('psyqueue')
    expect(helpText).toContain('migrate')
    expect(helpText).toContain('audit')
    expect(helpText).toContain('replay')
  })

  it('shows version', () => {
    const program = createProgram()
    expect(program.version()).toBe('0.1.0')
  })

  it('migrate command errors without required --from', () => {
    const program = createProgram()
    program.exitOverride()
    program.configureOutput({
      writeOut: () => {},
      writeErr: () => {},
    })

    expect(() => {
      program.parse(['node', 'psyqueue', 'migrate', '--to', 'redis://localhost'])
    }).toThrow()
  })
})
