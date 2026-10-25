import { afterAll, beforeAll, expect, test } from 'bun:test';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import { nativeFixture } from './native-account-bindings-fixture.ts';

let db: GrowthDatabase;
let f: Awaited<ReturnType<typeof nativeFixture>>;
beforeAll(async () => {
  db = await openGrowthDatabase();
  f = await nativeFixture(db.pool, () => db.openPool());
  // Native setup, beyond the small-table sequential-scan crossover at every
  // measured scale. No account, Auth witness or DBOS outcome is seeded with SQL.
  for (let offset = 0; offset < 512; offset += 8) {
    await Promise.all(
      Array.from({ length: 8 }, (_, n) => {
        const key = `baseline_native_${offset + n}`;
        return f.host.workflows.register({
          key,
          handle: key,
          email: `${key}@ordinary.test`,
          password: 'baseline native credential',
        });
      }),
    );
  }
  // Populate independent operator anchors as well as their subject rows, so
  // planner statistics include unrelated holds at every measured scale.
  const operators = await Promise.all(Array.from({ length: 16 }, (_, n) => f.person(`baseline-native-operator-${n}`)));
  for (let offset = 0; offset < 512; offset += 8) {
    await Promise.all(
      Array.from({ length: 8 }, (_, n) =>
        f.automated(`baseline-native-bot-${offset + n}`, operators[(offset + n) % operators.length]!),
      ),
    );
  }
}, 600000);
afterAll(async () => {
  await f?.close();
  await db?.close();
});

test('fixed native human and automated registrations and exact replay stay bounded as old receipts and stages grow', async () => {
  const human = await f.person('growth-native-operator');
  const report = await checkGrowth(db, {
    name: 'ordinary native registration with all Auth and kernel statements',
    bounds: { statements: 'constant', rows: 'constant', blocks: 'logarithmic' },
    // Capture includes the native DBOS queue/schedule supervisor. As in Auth's
    // schedule growth suite, one overlapping wake contributes at most six reads.
    slack: { statements: { absolute: 6, relative: 0 }, rows: { absolute: 6, relative: 0 } },
    repetitions: 2,
    grow: async (_database, scale, previous) => {
      for (let index = previous; index < scale; index++) {
        await f.host.workflows.register({
          key: `old-native-${index}`,
          handle: `old_native_${index}`,
          email: `old-native-${index}@ordinary.test`,
          password: 'ordinary old native credential',
        });
        // Grow this operator's actual creation approvals, native receipts and
        // related Auth stages as well as the unrelated human registrations.
        await f.automated(`old-native-bot-${index}`, human);
        await f.bindings.internalLifecycle.cancelHandleTransition({
          accountId: human.accountId,
          handle: `cancel_${index}`,
          expectedHandle: null,
          operationId: `old-${index}`,
          reservationId: human.accountId,
          key: `old-${index}`,
        });
      }
      await db.admin.query('VACUUM (ANALYZE) core.receipt');
      await db.admin.query('VACUUM (ANALYZE) access.account');
      await db.admin.query('VACUUM (ANALYZE) access.workflow_approval');
      await db.admin.query('VACUUM (ANALYZE) access.lifecycle_coordination');
      await db.admin.query('VACUUM (ANALYZE) access.operator_relation_slot');
      await f.authPool.query('VACUUM (ANALYZE) auth_registration_stage');
      await f.authPool.query('VACUUM (ANALYZE) auth_provisioning_receipt');
    },
    operation: async (_database, _scale, repetition) => {
      const key = `measured-native-${repetition}`;
      const person = await f.person(key);
      expect((await f.person(key)).accountId).toBe(person.accountId);
      const robot = await f.automated(`${key}-bot`, human);
      expect((await f.automated(`${key}-bot`, human)).accountId).toBe(robot.accountId);
    },
  });
  expect(report.samples.map((sample) => sample.scale)).toEqual([1, 8, 64]);
  for (const sample of report.samples) {
    expect(sample.cost.relations?.['public.auth_registration_stage']).toBeDefined();
    expect(sample.cost.relations?.['core.receipt']).toBeDefined();
  }
}, 600000);
