import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { AccountOperation, WorkflowResponsibility } from '@rezics/auth';
import { newId, routeOf } from '../../src/route/route.ts';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import { nativeFixture } from './native-account-bindings-fixture.ts';

let db: GrowthDatabase;
let fixture: Awaited<ReturnType<typeof nativeFixture>>;
type Person = Awaited<ReturnType<Awaited<ReturnType<typeof nativeFixture>>['person']>>;
let source: Person;
let destination: Person;
let manager: Person;
const key = () => `growth-transfer-${randomUUID()}`;
const context = () => ({ pool: db.pool, deadline: Date.now() + 10000 });

async function grant(resourceId: string, humanId: string) {
  await db.admin.query(
    `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
    VALUES ($1,$2,$3,'account:manage','(,)'::tstzrange,$4)`,
    [routeOf(resourceId), resourceId, humanId, newId(routeOf(resourceId)!)],
  );
}

async function responsibility(subjectAccountId: string): Promise<WorkflowResponsibility & { version: string }> {
  const row = (
    await db.admin.query<{
      operator_account_id: string;
      operator_reservation_id: string;
      operator_relation_version: string;
    }>(
      `SELECT operator_account_id::text,operator_reservation_id::text,operator_relation_version::text
      FROM access.account WHERE route=$1 AND account_id=$2`,
      [routeOf(subjectAccountId), subjectAccountId],
    )
  ).rows[0];
  if (!row?.operator_account_id || !row.operator_reservation_id) throw new Error('Missing operator responsibility');
  return {
    operatorAccountId: row.operator_account_id,
    subjectAccountId,
    reservationId: row.operator_reservation_id,
    version: row.operator_relation_version,
  };
}

async function addOtherResponsibilities(database: GrowthDatabase, operatorAccountId: string, count: number) {
  const route = routeOf(operatorAccountId)!;
  const subjects = Array.from({ length: count }, () => newId(route));
  const reservations = subjects.map(() => newId(route));
  if (!subjects.length) return;
  await database.admin.query(
    `INSERT INTO access.account(route,account_id,kind,state,transaction_id,membership_inverse_complete)
    SELECT $1,id,'actor','active',id,true FROM unnest($2::uuid[]) id`,
    [route, subjects],
  );
  await database.admin.query(
    `UPDATE access.account AS a
    SET operator_account_id=$1,operator_reservation_id=i.reservation_id
    FROM unnest($2::uuid[],$3::uuid[]) AS i(subject_id,reservation_id)
    WHERE a.route=$4 AND a.account_id=i.subject_id`,
    [operatorAccountId, subjects, reservations, route],
  );
  await database.admin.query(
    `INSERT INTO access.operator_relation_slot(route,subject_account_id,reservation_id,operator_account_id,terminal,transaction_id)
    SELECT $1,i.subject_id,i.reservation_id,$2,false,i.subject_id
    FROM unnest($3::uuid[],$4::uuid[]) AS i(subject_id,reservation_id)`,
    [route, operatorAccountId, subjects, reservations],
  );
}

async function addUnrelatedAccounts(database: GrowthDatabase, count: number) {
  const route = 0x6a31;
  const ids = Array.from({ length: count }, () => newId(route));
  if (!ids.length) return;
  await database.admin.query(
    `INSERT INTO access.account(route,account_id,kind,state,transaction_id,membership_inverse_complete)
    SELECT $1,id,'actor','active',id,true FROM unnest($2::uuid[]) id`,
    [route, ids],
  );
  await database.admin.query(
    `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
    SELECT $1,id,id,'account:update','(,)'::tstzrange,id FROM unnest($2::uuid[]) id`,
    [route, ids],
  );
}

beforeAll(async () => {
  db = await openGrowthDatabase();
  db.pool.options.max = 1;
  fixture = await nativeFixture(db.pool);
  source = await fixture.person(`growth-source-${randomUUID()}`);
  destination = await fixture.person(`growth-destination-${randomUUID()}`);
  manager = await fixture.person(`growth-manager-${randomUUID()}`);
  await grant(source.accountId, manager.accountId);
  await grant(destination.accountId, manager.accountId);
});

afterAll(async () => {
  await fixture?.close();
  await db?.close();
});

test('complete operator transfers stay bounded as unrelated accounts and both operators’ other responsibilities grow', async () => {
  const subject = await fixture.automated(`growth-subject-${randomUUID()}`, source);
  const report = await checkGrowth(db, {
    name: 'operator transfer with unrelated accounts and responsibilities',
    scales: [1, 8, 64],
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    repetitions: 1,
    warmups: 0,
    async grow(database, scale, previous) {
      const target = 1024 + scale * 128;
      const priorTarget = previous === 0 ? 0 : 1024 + previous * 128;
      const added = target - priorTarget;
      await addUnrelatedAccounts(database, added);
      await addOtherResponsibilities(database, source.accountId, added);
      await addOtherResponsibilities(database, destination.accountId, added);
      for (const table of [
        'access.account',
        'access.resource_grant',
        'access.lifecycle_coordination',
        'access.operator_relation_slot',
      ])
        await database.admin.query(`VACUUM ANALYZE ${table}`);
    },
    async operation() {
      for (const operatorAccountId of [destination.accountId, source.accountId]) {
        const previous = await responsibility(subject.accountId);
        const operationKey = key();
        const operation: AccountOperation = {
          kind: 'transfer',
          previous: {
            operatorAccountId: previous.operatorAccountId,
            subjectAccountId: previous.subjectAccountId,
            reservationId: previous.reservationId,
          },
          expectedVersion: previous.version,
          operatorAccountId,
          authorization: 'approval-request',
        };
        const approval = await fixture.approval().approve(manager.bearer, { operationKey, operation }, context());
        await fixture.host.workflows.transferOperator({
          key: operationKey,
          authorization: approval.reference,
          previous: operation.previous,
          expectedVersion: previous.version,
          operatorAccountId,
        });
      }
      expect((await responsibility(subject.accountId)).operatorAccountId).toBe(source.accountId);
    },
  });
  expect(report.samples.map((sample) => sample.scale)).toEqual([1, 8, 64]);
  for (const sample of report.samples) {
    expect(sample.cost.rows).toBeLessThan(500);
    expect(sample.cost.statements).toBeLessThan(500);
  }
}, 60000);
