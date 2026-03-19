const m = await import('pg-boss')
const PgBoss = m.default ?? m

try {
  const boss = new PgBoss('postgresql://dv_user:dv_pass@localhost:5434/psyqueue_bench')
  await boss.start()
  process.stdout.write('pg-boss started OK\n')

  const qname = 'bench_test2'
  await boss.createQueue(qname)
  process.stdout.write('Queue created: ' + qname + '\n')

  await boss.send(qname, { hello: 'world' })
  process.stdout.write('Job sent\n')

  // v10: fetch returns an array of jobs
  const jobs = await boss.fetch(qname)
  process.stdout.write('Fetched: ' + JSON.stringify(jobs) + '\n')

  if (jobs && jobs.length > 0) {
    const job = jobs[0]
    process.stdout.write('Job: id=' + job.id + ' data=' + JSON.stringify(job.data) + '\n')
    // v10: complete(id) not complete(queue, id)
    await boss.complete(qname, job.id)
    process.stdout.write('Completed!\n')
  }

  await boss.deleteQueue(qname)
  await boss.stop()
  process.stdout.write('DONE — pg-boss v10 works!\n')
} catch (e: any) {
  process.stderr.write('ERROR: ' + e.message + '\n')
}
process.exit(0)
