import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { derivedId, newId, routeOf } from '../../src/route/route.ts';
import {
  CONTINUATION_NAMESPACE,
  continuationEntryDigest,
  createCommittedContinuations,
  insertDeletionContinuation,
} from '../../src/access/committed-continuations.ts';
import { lifecycleExecutor } from '../../src/access/lifecycle-20261025094010-command.ts';
import { createAccess } from '../../src/access/permission.ts';
import loadContinuation from '../../src/access/committed-continuation-load.sql';
import { createPool, withConnection } from '../../src/database/pool.ts';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';

let db: GrowthDatabase;
let fixtures: ReturnType<typeof createPool>;
const referenceKeys = { current: 1, keys: new Map([[1, randomBytes(32)]]) };
const access = createAccess({ actions: new Map(), accountEvidence: () => null });
const runner = (pool = db.pool) => createCommittedContinuations({ pool, access, referenceKeys, pageSize: 2 });
const accountId = newId(0x1234);
const route = routeOf(accountId)!;
const continuationId = derivedId(CONTINUATION_NAMESPACE, `${accountId}:fixed`, route);
const prefix = `wf:${'ab'.repeat(32)}`;

async function insertAccount(id: string) {
  await db.admin.query(
    `INSERT INTO access.account(route,account_id,kind,state,transaction_id,membership_inverse_complete)
     VALUES ($1,$2,'actor','active',$2,true)`,
    [routeOf(id), id],
  );
}
async function insertContinuation(owner: string, operationKey: string, state: 'live' | 'completed' | 'expired') {
  const ownerRoute = routeOf(owner)!;
  const id = derivedId(CONTINUATION_NAMESPACE, `${owner}:${operationKey}`, ownerRoute);
  const created = new Date(state === 'expired' ? Date.now() - 10 * 60 * 1000 : Date.now());
  const expires = new Date(created.getTime() + 300_000);
  const allowlist = [
    {
      step: 'erase-auth-owner',
      target: owner,
      key: `${prefix}:erase-auth-owner`,
      digest: 'a'.repeat(64),
    },
  ];
  const completions = state === 'completed' ? [{ ...allowlist[0], receiptId: newId(ownerRoute) }] : [];
  await db.admin.query(
    `INSERT INTO access.committed_continuation (
       route, continuation_id, account_id, operation_key, operation_digest, command_key_prefix,
       barrier_receipt_id, barrier_transaction_id, minimum_authn_epoch, allowlist, digest,
       created_at, committed_expires_at, expires_at, completions
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1,$9::jsonb,$10,$11,$12,$12,$13::jsonb)`,
    [
      ownerRoute,
      id,
      owner,
      operationKey,
      'b'.repeat(64),
      prefix,
      newId(ownerRoute),
      newId(ownerRoute),
      JSON.stringify(allowlist),
      'c'.repeat(64),
      created.toISOString(),
      expires.toISOString(),
      JSON.stringify(completions),
    ],
  );
}

beforeAll(async () => {
  db = await openGrowthDatabase();
  fixtures = createPool(db.url);
  await insertAccount(accountId);
  await insertContinuation(accountId, 'fixed', 'live');
});
afterAll(async () => {
  await db?.close();
  await fixtures?.end();
});

test('one fanout page completion stays bounded as unrelated continuations and operated accounts grow', async () => {
  let prepared: string[] = [];
  let run = 0;
  const report = await checkGrowth(db, {
    name: 'committed continuation fanout page completion',
    scales: [256, 1024, 4096],
    repetitions: 1,
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    async grow(database, scale, previous) {
      // A fixed selectivity floor keeps tiny-table planner choices out of the measurement.
      const ids = Array.from({ length: scale - previous + (previous === 0 ? 1024 : 0) }, () => newId(route));
      await database.admin.query(
        `INSERT INTO access.account(route,account_id,kind,state,transaction_id,membership_inverse_complete)
         SELECT $1,id,'actor','active',id,true FROM unnest($2::uuid[]) id`,
        [route, ids],
      );
      await database.admin.query(
        `INSERT INTO access.committed_continuation
         SELECT (jsonb_populate_record(NULL::access.committed_continuation,
           to_jsonb(template) || jsonb_build_object('continuation_id',id,'account_id',id,
             'operation_key','unrelated:'||id::text))).*
         FROM (SELECT * FROM access.committed_continuation WHERE route=$1 AND continuation_id=$3) template
         CROSS JOIN unnest($2::uuid[]) id`,
        [route, ids, continuationId],
      );
      await database.admin.query(
        `INSERT INTO access.lifecycle_coordination
         SELECT $1,id,id,id,'operator',id FROM unnest($2::uuid[]) id`,
        [route, ids],
      );
      await database.admin.query(
        `INSERT INTO access.operator_relation_slot
         SELECT $1,id,id,id,false,id FROM unnest($2::uuid[]) id`,
        [route, ids],
      );
      await database.admin.query(
        `INSERT INTO access.committed_continuation_entry
         SELECT $1,id,'fence',id::text,'unrelated:'||id::text,repeat('a',64) FROM unnest($2::uuid[]) id`,
        [route, ids],
      );
      await database.admin.query(
        `INSERT INTO access.operator_fence_page(route,continuation_id,page_key,allowlist)
         SELECT $1,id,repeat('0',64),'[]'::jsonb FROM unnest($2::uuid[]) id`,
        [route, ids],
      );
      await database.admin.query(
        `INSERT INTO access.lifecycle_fence_receipt(route,account_id,receipt_id,minimum_authn_epoch,kind,transaction_id)
         SELECT $1,id,id,1,'fence',id FROM unnest($2::uuid[]) id`,
        [route, ids],
      );
      await database.admin.query(
        `INSERT INTO access.committed_continuation_completion(route,continuation_id,step,target,key,digest,receipt_id)
         SELECT $1,id,'fence',id::text,id::text,repeat('a',64),id FROM unnest($2::uuid[]) id`,
        [route, ids],
      );
      await database.admin.query(
        `INSERT INTO core.receipt(partition_no,principal_kind,principal_id,command_kind,idempotency_key,
           request_digest,epoch,position,transaction_id,response)
         SELECT $1,'account',id,'access.operator.subject-fenced',id::text,$3,1,1,id,'{}'
         FROM unnest($2::uuid[]) id`,
        [route >>> 4, ids, Buffer.alloc(32)],
      );
      prepared = [];
      run = 0;
      // Default warmup and one measured page each use a fresh committed root.
      for (let repetition = 0; repetition < 2; repetition++) {
        const operator = newId(route);
        await insertAccount(operator);
        await database.admin.query("UPDATE access.account SET state='suspended' WHERE route=$1 AND account_id=$2", [
          route,
          operator,
        ]);
        for (let index = 0; index < 2; index++) {
          const subject = newId(route);
          const reservation = newId(route);
          await insertAccount(subject);
          await database.admin.query("INSERT INTO access.lifecycle_coordination VALUES ($1,$2,$3,$4,'operator',$2)", [
            route,
            operator,
            reservation,
            subject,
          ]);
          await database.admin.query('INSERT INTO access.operator_relation_slot VALUES ($1,$2,$3,$4,false,$4)', [
            route,
            subject,
            reservation,
            operator,
          ]);
          await database.admin.query(
            'UPDATE access.account SET operator_account_id=$1,operator_reservation_id=$2 WHERE route=$3 AND account_id=$4',
            [operator, reservation, route, subject],
          );
        }
        const commandKeyPrefix = `wf:${createHash('sha256').update(operator).digest('hex')}`;
        const item = {
          step: 'operator-responsibility-page',
          target: operator,
          key: `${commandKeyPrefix}:operator-responsibility-page`,
        };
        await lifecycleExecutor(fixtures)(
          { route, id: operator, kind: 'operator.fence-page', key: operator, input: {} },
          async (tx, transactionId) => {
            await insertDeletionContinuation(tx, {
              accountId: operator,
              handle: null,
              operatorAccountId: null,
              reservationId: null,
              binding: { operationKey: operator, operationDigest: 'a'.repeat(64), commandKeyPrefix },
              barrierReceiptId: newId(route),
              minimumAuthnEpoch: '1',
              transactionId,
              allowlist: [{ ...item, digest: continuationEntryDigest(item) }],
            });
            return { pageKey: 'a'.repeat(64), count: 0 };
          },
        );
        prepared.push((await runner(fixtures).read(operator, operator))!.reference);
      }
    },
    async operation() {
      const result = await runner().continueCommittedPage(prepared[run++]!);
      expect(result.next).toBeNull();
    },
  });
  expect(report.samples.map((sample) => sample.scale)).toEqual([256, 1024, 4096]);
  for (const sample of report.samples) {
    expect(sample.cost.relations?.['access.lifecycle_coordination']?.rows).toBe(2);
    expect(sample.cost.relations?.['access.committed_continuation_entry']?.sequentialScans ?? 0).toBe(0);
  }
}, 60_000);

test('continuation lookup stays bounded as unrelated accounts and continuations grow', async () => {
  const report = await checkGrowth(db, {
    name: 'committed cleanup continuation',
    repetitions: 3,
    warmups: 1,
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    async grow(database, scale, previous) {
      for (let index = previous; index < scale; index += 1) {
        const owner = newId((index % 65_536) as number);
        await insertAccount(owner);
        await insertContinuation(owner, `live-${index}`, 'live');
        await insertContinuation(owner, `completed-${index}`, 'completed');
        await insertContinuation(owner, `expired-${index}`, 'expired');
      }
      await database.admin.query('VACUUM (ANALYZE) access.account');
      await database.admin.query('VACUUM (ANALYZE) access.committed_continuation');
    },
    async operation(database) {
      await withConnection(database.pool, async (client) => {
        await client.query('BEGIN');
        try {
          await client.query('SET LOCAL enable_seqscan = off');
          const row = await loadContinuation.run(client, { route, continuation_id: continuationId });
          const found = Array.isArray(row) ? row.length === 1 : row != null;
          expect(found).toBe(true);
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      });
    },
  });
  expect(report.samples.map((sample) => sample.scale)).toEqual([1, 8, 64]);
});
