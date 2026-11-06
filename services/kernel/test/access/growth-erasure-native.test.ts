import { acknowledgeErasure } from '../../src/access/erasure.ts';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { advanceNativeErasure, openNativeErasure } from '../../src/access/erasure-native.ts';
import { createGrantCommands } from '../../src/access/grant-commands.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import { deletePersona } from '../support/account-deletion.ts';
import { nativeFixture, scopes } from './native-account-bindings-fixture.ts';

let db: GrowthDatabase;
let auth: Awaited<ReturnType<typeof nativeFixture>>;
beforeAll(async () => {
  scopes.push('account:read', 'account:update', 'account:delete');
  db = await openGrowthDatabase();
  auth = await nativeFixture(db.pool);
}, 120000);
afterAll(async () => {
  try {
    await auth?.close();
  } finally {
    await db?.close();
  }
});

for (const axis of ['unrelated', 'history'] as const) {
  test(`fixed deep native permission page counts mutation, proof and checkpoint work as ${axis} grows`, async () => {
    const target = await auth.person(`growth_erase_${crypto.randomUUID().replaceAll('-', '_')}`);
    const survivor = await auth.person(`growth_keep_${crypto.randomUUID().replaceAll('-', '_')}`);
    const route = routeOf(target.accountId)!;
    const actor = await auth.access.authenticate(target.bearer, { pool: db.pool, deadline: Date.now() + 10000 });
    const grants = createGrantCommands({ pool: db.pool, access: auth.access, managementAction: 'account:manage' });
    const start = Date.now() - 300 * 86400000;
    for (let i = 0; i < 201; i++) {
      const valid = `[${new Date(start + i * 86400000).toISOString()},${new Date(start + (i + 1) * 86400000).toISOString()})`;
      await grants.create(
        { pool: db.pool, actor, deadline: Date.now() + 10000 },
        {
          resource: { route, id: target.accountId },
          subject: { kind: 'account', id: survivor.accountId },
          actions: ['account:read'],
          valid,
          key: crypto.randomUUID(),
        },
      );
    }
    await deletePersona({ pool: db.pool, auth }, target);
    const progressId = await openNativeErasure(db.pool, target.accountId);
    await advanceNativeErasure(db.pool, progressId, acknowledgeErasure); // empty preferences
    await advanceNativeErasure(db.pool, progressId, acknowledgeErasure); // preceding 100 raw keys really purged
    expect(
      (await db.admin.query('SELECT phase,page FROM access.erasure_native_progress WHERE progress_id=$1', [progressId]))
        .rows,
    ).toEqual([{ phase: 1, page: 1 }]);
    // A fault at the actual checkpoint exercises the selected-key DELETEs and
    // independent absence proofs, then rolls back, keeping exactly this raw page.
    // No fixture writes an erasure obligation, acknowledgement or checkpoint.
    await db.admin.query(`CREATE FUNCTION public.fail_native_growth_checkpoint() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'growth checkpoint fault'; END $$`);
    await db.admin.query(`CREATE TRIGGER fail_native_growth_checkpoint BEFORE UPDATE ON access.erasure_native_progress
      FOR EACH ROW EXECUTE FUNCTION public.fail_native_growth_checkpoint()`);
    let selected: unknown;
    try {
      // Prime the durable discovery replay. The dependency separately proves its
      // ordered range seek; this slice measures real mutation/proof/checkpoint work.
      await expect(advanceNativeErasure(db.pool, progressId, acknowledgeErasure)).rejects.toThrow(
        'growth checkpoint fault',
      );
      selected = (
        await db.admin.query(
          `SELECT result FROM access.erasure_progress
        WHERE route=$1 AND account_id=$2 AND store='resource_grant' AND role='resource_id'`,
          [route, target.accountId],
        )
      ).rows[0].result;
      const unrelatedId = newId(route);
      const report = await checkGrowth(db, {
        name: `native erasure deep permission page ${axis}`,
        scales: [64, 512, 4096],
        bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
        indexProbes: 210,
        async grow(database, scale, previous) {
          const ids = Array.from({ length: scale - previous }, () =>
            axis === 'unrelated' ? newId(route) : unrelatedId,
          );
          if (axis === 'unrelated' || previous === 0) {
            await database.admin.query(
              `INSERT INTO access.account(route,account_id,kind,state,transaction_id)
              SELECT $1,id,'actor','active',id FROM unnest($2::uuid[]) id ON CONFLICT DO NOTHING`,
              [route, axis === 'unrelated' ? ids : [unrelatedId]],
            );
          }
          await database.admin.query(
            `INSERT INTO access.resource_grant
            (route,resource_id,subject_id,action,valid,transaction_id)
            SELECT $1,id,$2,'account:read',tstzrange($3::timestamptz + n * interval '1 second',
              $3::timestamptz + (n+1) * interval '1 second','[)'),id
            FROM unnest($4::uuid[]) WITH ORDINALITY AS t(id,n)`,
            [route, survivor.accountId, new Date(start - scale * 1000).toISOString(), ids],
          );
        },
        async operation() {
          await expect(advanceNativeErasure(db.pool, progressId, acknowledgeErasure)).rejects.toThrow(
            'growth checkpoint fault',
          );
          // The admin observations do not enter the measured native work.
          const copy = (
            await db.admin.query(
              `SELECT result FROM access.erasure_progress
            WHERE route=$1 AND account_id=$2 AND store='resource_grant' AND role='resource_id'`,
              [route, target.accountId],
            )
          ).rows[0].result;
          expect(copy).toEqual(selected);
        },
      });
      expect(new Set(report.samples.map(({ cost }) => cost.rows)).size).toBe(1);
      expect(new Set(report.samples.map(({ cost }) => cost.statements)).size).toBe(1);
      for (const { cost } of report.samples) {
        expect(cost.statements).toBeLessThanOrEqual(8 + 4 * 100);
        expect(cost.relations['access.resource_grant']?.sequentialScans ?? 0).toBe(0);
      }
    } finally {
      await db.admin.query('DROP TRIGGER fail_native_growth_checkpoint ON access.erasure_native_progress');
      await db.admin.query('DROP FUNCTION public.fail_native_growth_checkpoint()');
    }
    await advanceNativeErasure(db.pool, progressId, acknowledgeErasure);
    expect(
      (await db.admin.query('SELECT page FROM access.erasure_native_progress WHERE progress_id=$1', [progressId]))
        .rows[0].page,
    ).toBe(2);
  }, 180000);
}
