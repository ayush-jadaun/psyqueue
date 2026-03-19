/**
 * Real Email Sending Demo
 *
 * Uses Ethereal (free test SMTP) to send REAL emails through PsyQueue.
 * Every email is captured and viewable in a browser.
 *
 * Run: npx tsx examples/real-email-demo/index.ts
 */

import nodemailer from 'nodemailer'
import { PsyQueue } from '../../packages/core/src/index.js'
import { sqlite } from '../../packages/backend-sqlite/src/index.js'
import { createDashboardServer } from '../../packages/dashboard/src/server.js'

async function main() {
  // ── 1. Create Ethereal test account (generates fake SMTP creds) ──
  console.log('\n  Creating Ethereal test account...')
  const testAccount = await nodemailer.createTestAccount()
  console.log(`  Ethereal user: ${testAccount.user}`)
  console.log(`  Ethereal pass: ${testAccount.pass}`)

  // ── 2. Create SMTP transport ──
  const transporter = nodemailer.createTransport({
    host: testAccount.smtp.host,
    port: testAccount.smtp.port,
    secure: testAccount.smtp.secure,
    auth: {
      user: testAccount.user,
      pass: testAccount.pass,
    },
  })

  // ── 3. Setup PsyQueue ──
  const q = new PsyQueue()
  q.use(sqlite({ path: ':memory:' }))

  // Track sent emails
  const sentEmails: Array<{ to: string; subject: string; url: string }> = []
  let failCount = 0

  // ── 4. Register REAL email handler ──
  q.handle('email.send', async (ctx) => {
    const { to, subject, body } = ctx.job.payload as { to: string; subject: string; body: string }

    console.log(`    [Worker] Sending email to ${to}: "${subject}"...`)

    // Actually send via SMTP
    const info = await transporter.sendMail({
      from: '"PsyQueue Demo" <psyqueue@test.com>',
      to,
      subject,
      text: body,
      html: `<h2>${subject}</h2><p>${body}</p><hr><p><em>Sent by PsyQueue job ${ctx.job.id}</em></p>`,
    })

    // Get the Ethereal preview URL
    const previewUrl = nodemailer.getTestMessageUrl(info)
    sentEmails.push({ to, subject, url: previewUrl as string })
    console.log(`    [Worker] Sent! Preview: ${previewUrl}`)

    return { messageId: info.messageId, previewUrl }
  })

  // Register a handler that sometimes fails (to test retries)
  q.handle('email.newsletter', async (ctx) => {
    const { to } = ctx.job.payload as { to: string }
    failCount++

    // Fail first 2 attempts (simulates flaky SMTP)
    if (failCount <= 2) {
      console.log(`    [Worker] Newsletter to ${to} FAILED (attempt ${ctx.job.attempt}/${ctx.job.maxRetries + 1})`)
      throw new Error('SMTP connection timeout (simulated)')
    }

    console.log(`    [Worker] Newsletter to ${to}: sending (attempt ${ctx.job.attempt})...`)
    const info = await transporter.sendMail({
      from: '"PsyQueue Newsletter" <newsletter@test.com>',
      to,
      subject: 'Weekly Newsletter #42',
      html: '<h1>This Week in Tech</h1><p>PsyQueue beats BullMQ by 1.29x!</p>',
    })

    const previewUrl = nodemailer.getTestMessageUrl(info)
    sentEmails.push({ to, subject: 'Newsletter', url: previewUrl as string })
    console.log(`    [Worker] Newsletter sent! Preview: ${previewUrl}`)
    return { messageId: info.messageId }
  })

  await q.start()

  // Start dashboard
  const dash = createDashboardServer({ port: 4000, getBackend: () => (q as any).backend })
  await dash.start()

  console.log('\n  Dashboard: http://localhost:4000')
  console.log('  ─────────────────────────────────────────\n')

  // ── 5. Enqueue REAL email jobs ──
  console.log('  Enqueueing 5 welcome emails...')
  const recipients = [
    { to: 'alice@example.com', subject: 'Welcome Alice!', body: 'Thanks for signing up.' },
    { to: 'bob@example.com', subject: 'Welcome Bob!', body: 'Your account is ready.' },
    { to: 'charlie@example.com', subject: 'Welcome Charlie!', body: 'Start exploring now.' },
    { to: 'diana@example.com', subject: 'Welcome Diana!', body: 'Check out our features.' },
    { to: 'eve@example.com', subject: 'Welcome Eve!', body: 'We are glad to have you.' },
  ]

  for (const r of recipients) {
    await q.enqueue('email.send', r)
  }

  // Enqueue a newsletter that will fail twice then succeed (tests retry)
  console.log('  Enqueueing 1 newsletter (will retry 2x then succeed)...\n')
  await q.enqueue('email.newsletter', { to: 'subscriber@example.com' }, { maxRetries: 5 })

  // ── 6. Process all jobs ──
  console.log('  Processing jobs...\n')

  // Process welcome emails
  for (let i = 0; i < 5; i++) {
    await q.processNext('email.send')
  }

  // Process newsletter (with retries)
  for (let i = 0; i < 5; i++) {
    const ok = await q.processNext('email.newsletter')
    if (!ok) break
  }

  // ── 7. Summary ──
  console.log('\n  ═══════════════════════════════════════════')
  console.log('  RESULTS')
  console.log('  ═══════════════════════════════════════════\n')
  console.log(`  Emails sent: ${sentEmails.length}`)
  console.log('')
  for (const email of sentEmails) {
    console.log(`  📧 To: ${email.to.padEnd(25)} Subject: ${email.subject}`)
    console.log(`     View: ${email.url}`)
  }
  console.log('\n  ─────────────────────────────────────────')
  console.log('  Dashboard: http://localhost:4000/api/overview')
  console.log('  ─────────────────────────────────────────')
  console.log('\n  Open the preview URLs above to see the actual emails!')
  console.log('  Dashboard shows job statuses, retries, and dead-letters.')
  console.log('\n  Press Ctrl+C to stop.\n')

  await new Promise(() => {})
}

main().catch(console.error)
