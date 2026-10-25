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
  // Sign-in reads auth_consent and auth_client by key, and session expiry reads
  // session by expiresAt. A few dozen rows stay in the sequential-scan range, so
  // unrelated clients, consents and unexpired sessions are present before the
  // first scale. Sessions belong to spare users, one each, so the capacity
  // trigger keeps every background row.
  await f.authPool.query(
    `INSERT INTO auth_client (client_id, first_party, scopes)
     SELECT 'growth-background-client-' || i, false, ARRAY['read']
     FROM generate_series(0, 4000) i`,
  );
  await f.authPool.query(
    `INSERT INTO auth_consent (account_id, client_id, scopes)
     SELECT 'growth-background-' || i, 'growth-background-client-0', ARRAY['read']
     FROM generate_series(1, 4000) i`,
  );
  await f.authPool.query(
    `INSERT INTO "user" (id, name, email, "emailVerified")
     SELECT 'growth-background-user-' || i, '', 'growth-background-user-' || i || '@background.test', false
     FROM generate_series(1, 4000) i`,
  );
  await f.authPool.query(
    `INSERT INTO session (id, token, "expiresAt", "updatedAt", "userId", "clientId", "grantedScope", "authnEpoch", "authTime", "authMethods")
     SELECT 'growth-background-session-' || i, 'growth-background-token-' || i, '2099-01-01'::timestamptz,
            statement_timestamp(), 'growth-background-user-' || i, 'growth-background-client-0', 'read', 1, 1, 'pwd'
     FROM generate_series(1, 4000) i`,
  );
  for (const table of ['auth_client', 'auth_consent', '"user"', 'session'])
    await f.authPool.query(`VACUUM (ANALYZE) ${table}`);
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
      for (const table of [
        'core.receipt',
        'core.outbox',
        'editorial.write_basis',
        'access.account',
        'access.workflow_approval',
        'access.lifecycle_coordination',
        'access.operator_relation_slot',
        'access.resource_grant',
        'access.handle_claim',
      ])
        await db.admin.query(`VACUUM (ANALYZE) ${table}`);
      for (const table of [
        'auth_registration_stage',
        'auth_provisioning_receipt',
        'auth_consent',
        'auth_client',
        '"user"',
        'account',
        'session',
        'verification',
      ])
        await f.authPool.query(`VACUUM (ANALYZE) ${table}`);
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
