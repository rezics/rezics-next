import { expect, test } from 'bun:test';

// Exercise real durable dispatch in a fresh process: the SDK owns global registration.
test('each durable accounts tick admits one local batch, yields backlog and fences moved partitions', async () => {
  const program = `
    import assert from 'node:assert/strict';
    import pg from 'pg';
    import { createWorkClient } from './src/work/client.ts';
    import { composeWork } from './src/work/registry.ts';
    import { accountsWorkModule } from './src/access/write-rate-expiry.ts';
    const pool=new pg.Pool({connectionString:process.env.DATABASE_URL});
    const client=await createWorkClient(process.env.DATABASE_URL,pool);
    const partition=1841, route=partition*16;
    await pool.query('TRUNCATE access.write_rate_counter');
    await pool.query(\`INSERT INTO access.write_rate_counter(route,identity_digest,family,count,expires_at)
      SELECT $1,lpad(to_hex(i),64,'0'),'write',1,'2020-01-01' FROM generate_series(1,2001) i\`,[route]);
    await pool.query(\`INSERT INTO access.write_rate_counter(route,identity_digest,family,count,expires_at)
      VALUES($1,repeat('a',64),'write',1,statement_timestamp()+interval '1 hour'),
      ($2,repeat('b',64),'write',1,'2020-01-01')\`,[route,route+1]);
    const work=await composeWork([accountsWorkModule],{databaseUrl:process.env.DATABASE_URL,pool,client,
      env:{KERNEL_WRITE_RATE_EXPIRY_PARTITION:String(partition),KERNEL_WRITE_RATE_EXPIRY_NODE:'b'}});
    let sequence=0;
    async function tick(context={partition}) {
      const handle=await client.enqueue({workflowName:'accounts.write-rate-expiry',
        workflowID:'expiry-test-'+crypto.randomUUID(),queueName:'maintenance'},new Date(0),context);
      await handle.getResult();
      sequence++;
    }
    async function remaining() {
      return (await pool.query('SELECT count(*)::integer AS count FROM access.write_rate_counter WHERE route=$1',[route])).rows[0].count;
    }
    try {
      const schedule=await client.getSchedule('accounts.write-rate-expiry.'+partition);
      assert.equal(schedule.queueName,'maintenance'); assert.equal(schedule.automaticBackfill,false);
      // Pause before launch: SDK polling cannot cancel an already-planned firing immediately.
      await client.pauseSchedule(schedule.scheduleName);
      await work.launch();
      await tick(); assert.equal(await remaining(),1002);
      // A different durable attempt makes progress. The first attempt did not drain the backlog.
      await tick(); assert.equal(await remaining(),2);
      await tick({partition:partition+1}); assert.equal(await remaining(),2);
      await pool.query("UPDATE core.partition SET write_state='fenced' WHERE partition_no=$1",[partition]);
      await tick(); assert.equal(await remaining(),2);
      await pool.query("UPDATE core.partition SET write_state='moved', moved_to='elsewhere' WHERE partition_no=$1",[partition]);
      await tick(); assert.equal(await remaining(),2);
      await pool.query("UPDATE core.partition SET node='elsewhere',write_state='active',moved_to=NULL WHERE partition_no=$1",[partition]);
      await tick(); assert.equal(await remaining(),2);
      await pool.query("UPDATE core.partition SET node='b' WHERE partition_no=$1",[partition]);
      await tick(); assert.equal(await remaining(),1);
      assert.equal((await pool.query('SELECT count(*)::integer AS count FROM access.write_rate_counter WHERE route=$1',[route+1])).rows[0].count,1);
      assert.equal(sequence,7);
    } finally {
      await pool.query("UPDATE core.partition SET node='b',write_state='active',moved_to=NULL WHERE partition_no=$1",[partition]);
      await work.shutdown(); await client.close(); await pool.end();
    }
  `;
  const child = Bun.spawn([process.execPath, '-e', program], {
    cwd: import.meta.dir + '/../..',
    env: process.env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [code, errors] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect(code, errors).toBe(0);
}, 30000);

test('contention explicitly accounts for skipped index candidates while deletion stays admitted', async () => {
  const { measure, openGrowthDatabase } = await import('../support/growth.ts');
  const { expireWriteRateCounters } = await import('../../src/access/write-rate-expiry.ts');
  const db = await openGrowthDatabase();
  const route = 0x7310;
  try {
    for (const locked of [0, 1, 1000]) {
      await db.admin.query('TRUNCATE access.write_rate_counter');
      await db.admin.query(
        `INSERT INTO access.write_rate_counter(route,identity_digest,family,count,expires_at)
        SELECT $1,lpad(to_hex(i),64,'0'),'write',1,'2020-01-01' FROM generate_series(1,2002) i`,
        [route],
      );
      await db.admin.query('VACUUM ANALYZE access.write_rate_counter');
      const locker = await db.admin.connect();
      try {
        await locker.query('BEGIN');
        await locker.query(
          `SELECT 1 FROM access.write_rate_counter WHERE route=$1 AND identity_digest <= $2 FOR UPDATE`,
          [route, locked.toString(16).padStart(64, '0')],
        );
        const { value, cost } = await measure(db, () => expireWriteRateCounters(db.pool, route));
        expect(value).toBe(1000);
        expect(cost.statements).toBe(1);
        expect(cost.rows).toBe(2000 + locked);
        expect(cost.relations['access.write_rate_counter']?.sequentialScans).toBe(0);
        expect(Number((await db.admin.query('SELECT count(*) FROM access.write_rate_counter')).rows[0].count)).toBe(
          1002,
        );
      } finally {
        await locker.query('ROLLBACK');
        locker.release();
      }
    }
  } finally {
    await db.close();
  }
});
