import { MAX_CONSENTED_SCOPES } from '@rezics/auth-contract';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { captureDurableInitiator } from '../../src/access/index.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import { captureAttempt, captureFixture } from './durable-initiator-capture.test.ts';

let db: GrowthDatabase;
beforeAll(async () => {
  db = await openGrowthDatabase();
  db.pool.options.max = 1;
});
afterAll(async () => db?.close());

for (const delegated of [false, true]) {
  test(`capture adds ${delegated ? 'one point read' : 'zero reads'} at 1x/8x/64x accounts and assignments`, async () => {
    const f = await captureFixture(db, delegated);
    let measured = false;
    const complete = new Error('Measurement complete before target checkout');
    await expect(
      captureAttempt(f, async (context) => {
        const report = await checkGrowth(db, {
          name: `durable initiator capture delegated=${delegated}`,
          bounds: { statements: 'constant', rows: 'constant', blocks: 'logarithmic' },
          repetitions: 3,
          warmups: 1,
          async grow(database, scale, previous) {
            const ids = Array.from({ length: (scale - previous) * 256 }, () => newId(routeOf(f.principal)!));
            await database.admin.query(
              `INSERT INTO access.account(route,account_id,kind,state,transaction_id)
            SELECT $1,id,'actor','active',id FROM unnest($2::uuid[]) id`,
              [routeOf(f.principal), ids],
            );
            // Mix unrelated principals and the selected principal's assignment history.
            await database.admin.query(
              `INSERT INTO access.principal_assignment
            (route,principal_id,creator_principal_id,request_id,assigned_actor_id,valid,transaction_id)
            SELECT $1,principal,principal,id,$3,'(,)',id FROM
            (SELECT id,CASE WHEN n%2=0 THEN $4::uuid ELSE id END AS principal
             FROM unnest($2::uuid[]) WITH ORDINALITY x(id,n)) rows`,
              [routeOf(f.principal), ids, f.actor.accountId, f.principal],
            );
            await database.admin.query('VACUUM (ANALYZE)');
          },
          async operation() {
            const captured = await captureDurableInitiator(context, f.actor);
            expect(captured.originalAccount).toEqual({ minimumAuthnEpoch: '1', operatorAccountId: null });
            expect(captured.originalDelegation?.transactionId ?? null).toBe(delegated ? f.transactionId : null);
          },
        });
        expect(report.samples.map(({ scale }) => scale)).toEqual([1, 8, 64]);
        expect(report.samples.map(({ cost }) => cost.statements)).toEqual(delegated ? [1, 1, 1] : [0, 0, 0]);
        expect(report.samples.map(({ cost }) => cost.rows)).toEqual(delegated ? [1, 1, 1] : [0, 0, 0]);
        measured = true;
        throw complete;
      }),
    ).rejects.toBe(complete);
    expect(measured).toBe(true);
  }, 120_000);
}

test('capture keeps constant statements and rows at 8, 64 and 512 consented scopes', async () => {
  const fixtures = new Map<number, Awaited<ReturnType<typeof captureFixture>>>();
  const report = await checkGrowth(db, {
    name: 'durable initiator capture by consented scope count',
    scales: [8, 64, MAX_CONSENTED_SCOPES],
    bounds: { statements: 'constant', rows: 'constant', blocks: 'linear' },
    async grow(_database, scale) {
      const scopes = ['subject:write', ...Array.from({ length: scale - 1 }, (_, i) => `scope:${i}`)];
      fixtures.set(scale, await captureFixture(db, false, scopes));
    },
    async operation(_database, scale) {
      const f = fixtures.get(scale)!;
      const complete = new Error('Capture measured before target writes');
      await expect(
        captureAttempt(
          f,
          async (context) => {
            expect(await captureDurableInitiator(context, f.actor)).toMatchObject({
              originalAccount: { minimumAuthnEpoch: '1' },
            });
            throw complete;
          },
          false,
        ),
      ).rejects.toBe(complete);
    },
  });
  expect(report.samples.map(({ scale }) => scale)).toEqual([8, 64, MAX_CONSENTED_SCOPES]);
});
