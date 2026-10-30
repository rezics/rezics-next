import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { DBOSClient } from '@dbos-inc/dbos-sdk';
import { copiesAbsent, createCopyWriter, eraseCopy } from '../src/erasure-copy.ts';
import { erasureHistoryPage } from '../src/erasure-history.ts';
import { nativeFixture } from './support/erasure-native.ts';
import { checkGrowth, measure, openGrowthDatabase, type GrowthDatabase } from '../../kernel/test/support/growth.ts';

// The ordinary host, recorder, native SDK delete/cancel, absence probes and
// native checkpoint all use the same instrumented Auth-store pools.
test('actual Auth copy creation, exact deletion and missing-custody proof stay bounded as unrelated native workflow history grows', async () => {
  let db: GrowthDatabase;
  const f = await nativeFixture({
    openPool: async (url) => {
      db = await openGrowthDatabase(url);
      return db.openPool();
    },
  });
  const sdk = await DBOSClient.create({
    systemDatabaseUrl: f.fixture.url,
    systemDatabaseSchemaName: 'auth_dbos',
    applicationName: 'growth-unrelated',
    systemDatabasePool: f.pool,
  });
  await sdk.registerQueue('growth.unrelated');
  try {
    const unrelated = createCopyWriter(f.pool, sdk);
    const report = await checkGrowth(db!, {
      name: 'Auth native custody creation and one bounded workflow purge',
      scales: [256, 1024, 4096],
      repetitions: 1,
      warmups: 1,
      bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
      async grow(current, scale, previous) {
        // Same native tables and full completed operation history, spread only
        // by exact workflow keys. Fixtures never stand in for target erasure.
        for (let i = previous; i < scale; i++) {
          const id = `unrelated-history-${i}`;
          await current.admin.query(
            "INSERT INTO auth_copy_work(workflow_id,name,digest,scope_count) VALUES($1,'accounts.operation',decode(repeat('00',32),'hex'),1)",
            [id],
          );
          await current.admin.query("INSERT INTO auth_copy_role(account_id,workflow_id,role) VALUES($1,$1,'subject')", [
            id,
          ]);
          await current.admin.query(
            "INSERT INTO auth_dbos.workflow_status(workflow_uuid,status,name,application_name) VALUES($1,'SUCCESS','accounts.operation','growth-unrelated')",
            [id],
          );
          await current.admin.query('INSERT INTO auth_dbos.workflow_input(workflow_uuid,inputs) VALUES($1,$2)', [
            id,
            JSON.stringify([{ privateMarker: id }]),
          ]);
          await current.admin.query('INSERT INTO auth_dbos.workflow_output(workflow_uuid,output) VALUES($1,$2)', [
            id,
            JSON.stringify({ privateMarker: id }),
          ]);
          await current.admin.query(
            "INSERT INTO auth_dbos.operation_outputs(workflow_uuid,function_id,function_name,output) SELECT $1,i,'completed-fixture',$2 FROM generate_series(0,31) i",
            [id, JSON.stringify({ privateMarker: id })],
          );
        }
        expect(
          (
            await current.admin.query(
              "SELECT count(*)::integer AS n FROM auth_dbos.workflow_status WHERE application_name='growth-unrelated'",
            )
          ).rows[0]!.n,
        ).toBe(scale);
      },
      async operation(current) {
        // Production durable registration produces status/input/steps/events,
        // messages/output, all covered before their real serialization.
        const person = await f.person(`growth_${randomUUID().slice(0, 8)}`);
        const work = (
          await current.admin.query<{ workflow_id: string }>(
            "SELECT r.workflow_id FROM auth_copy_role r JOIN auth_copy_work w USING(workflow_id) WHERE account_id=$1 AND w.name='accounts.registration'",
            [person.accountId],
          )
        ).rows[0]!;
        expect((await f.delete(person)).status).toBe(200);
        expect(await eraseCopy(f.pool, work.workflow_id)).toBe(true);
        expect(await copiesAbsent(f.pool, work.workflow_id)).toBe(true);
        const obligation = (
          await current.admin.query('SELECT id FROM auth_erasure WHERE account_id=$1', [person.accountId])
        ).rows[0]!;
        // Native consent and live copies remain separate pending prerequisites.
        expect(await erasureHistoryPage(f.pool, obligation.id)).toBe(false);
        const row = (
          await current.admin.query('SELECT rows,bytes,absent FROM auth_copy_work WHERE workflow_id=$1', [
            work.workflow_id,
          ])
        ).rows[0]!;
        expect(row.absent).toBe(true);
        expect(row.rows).toBeLessThanOrEqual(139);
        expect(row.bytes).toBeLessThanOrEqual(10485760);
      },
    });
    expect(report.samples.map((s) => s.scale)).toEqual([256, 1024, 4096]);
    // More applicable copies require more constant-size units. Every selected
    // unit below was made by the actual registration/deletion consumers.
    const units: string[] = [];
    for (let i = 0; i < 4; i++) {
      const person = await f.person(`units_${randomUUID().slice(0, 8)}`);
      units.push(
        (
          await f.pool.query<{ workflow_id: string }>(
            "SELECT r.workflow_id FROM auth_copy_role r JOIN auth_copy_work w USING(workflow_id) WHERE account_id=$1 AND w.name='accounts.registration'",
            [person.accountId],
          )
        ).rows[0]!.workflow_id,
      );
      expect((await f.delete(person)).status).toBe(200);
    }
    const costs = [];
    for (const id of units)
      costs.push(
        (
          await measure(db!, async () => {
            expect(await eraseCopy(f.pool, id)).toBe(true);
          })
        ).cost,
      );
    expect(new Set(costs.map((c) => c.statements)).size).toBe(1);
    expect(costs.every((c) => c.rows > 0)).toBe(true);
    expect(costs.slice(0, 2).reduce((n, c) => n + c.statements, 0)).toBe(costs[0]!.statements * 2);
    expect(costs.reduce((n, c) => n + c.statements, 0)).toBe(costs[0]!.statements * 4);
    // A transactional source rollback creates neither scope nor native input.
    await expect(
      unrelated.enqueue(
        'accounts.operation',
        `rollback-${randomUUID()}`,
        { privateMarker: 'must not persist' },
        [{ accountId: 'x', role: 'subject' }],
        'missing-parent',
      ),
    ).rejects.toThrow('parent retired');
  } finally {
    await sdk.destroy();
    await f.close({ keepPool: true });
    await db!.close();
  }
}, 900000);
