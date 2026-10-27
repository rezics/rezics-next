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
import { capture, checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';

let db: GrowthDatabase;
let fixtures: ReturnType<typeof createPool>;
const referenceKeys = { current: 1, keys: new Map([[1, randomBytes(32)]]) };
const access = createAccess({ actions: new Map(), accountEvidence: () => null });
const runner = (pool = db.pool) => createCommittedContinuations({ pool, access, referenceKeys, pageSize: 2 });
const accountId = newId(0x1234);
const route = routeOf(accountId)!;
const continuationId = derivedId(CONTINUATION_NAMESPACE, `${accountId}:fixed`, route);
const prefix = `wf:${'ab'.repeat(32)}`;
const rowsPerScaleUnit = 500;

function generatedId(ordinal = 'n', routeParameter = '$1', seedParameter = '$2'): string {
  // Test-only UUIDs are derived inside PostgreSQL so large growth stages do not build million-item JS arrays.
  return `(substr(${seedParameter}::text, 1, 8) || '-' || substr(${seedParameter}::text, 10, 4) ||
    '-8000-' || lpad(to_hex(${routeParameter}::integer), 4, '0') || '-' ||
    lpad(to_hex(${ordinal}::bigint), 12, '0'))::uuid`;
}

function expectIndex(plans: readonly unknown[], expected: string): void {
  let found = false;
  const visit = (node: unknown): void => {
    if (typeof node !== 'object' || node === null) return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    const plan = node as Record<string, unknown>;
    if (typeof plan['Index Name'] === 'string' && plan['Index Name'].startsWith(expected)) found = true;
    if (typeof plan.Plan === 'object' && plan.Plan !== null) visit(plan.Plan);
    if (Array.isArray(plan.Plans)) for (const child of plan.Plans) visit(child);
  };
  for (const plan of plans) visit(plan);
  expect(found, `plan should use ${expected}`).toBe(true);
}

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

async function insertUnrelatedContinuations(database: GrowthDatabase, count: number, first: number): Promise<void> {
  const owners = Array.from({ length: count }, () => newId(route));
  await database.admin.query(
    `INSERT INTO access.account(route,account_id,kind,state,transaction_id)
     SELECT $1,id,'actor','active',id FROM unnest($2::uuid[]) id`,
    [route, owners],
  );

  const rows: {
    owner: string;
    continuationId: string;
    operationKey: string;
    receiptId: string;
    transactionId: string;
    allowlist: string;
    createdAt: Date;
    expiresAt: Date;
    completions: string;
  }[] = [];
  for (let index = 0; index < owners.length; index += 1) {
    const owner = owners[index]!;
    for (const state of ['live', 'completed', 'expired'] as const) {
      const operationKey = `${state}-${first + index}`;
      const createdAt = new Date(state === 'expired' ? Date.now() - 10 * 60 * 1000 : Date.now());
      const expiresAt = new Date(createdAt.getTime() + 300_000);
      const entry = {
        step: 'erase-auth-owner',
        target: owner,
        key: `${prefix}:erase-auth-owner`,
        digest: 'a'.repeat(64),
      };
      rows.push({
        owner,
        continuationId: derivedId(CONTINUATION_NAMESPACE, `${owner}:${operationKey}`, route),
        operationKey,
        receiptId: newId(route),
        transactionId: newId(route),
        allowlist: JSON.stringify([entry]),
        createdAt,
        expiresAt,
        completions: JSON.stringify(state === 'completed' ? [{ ...entry, receiptId: newId(route) }] : []),
      });
    }
  }
  await database.admin.query(
    `INSERT INTO access.committed_continuation(
       route,continuation_id,account_id,operation_key,operation_digest,command_key_prefix,
       barrier_receipt_id,barrier_transaction_id,minimum_authn_epoch,allowlist,digest,
       created_at,committed_expires_at,expires_at,completions
     )
     SELECT $1,continuation_id,account_id,operation_key,repeat('b',64),$2,receipt_id,transaction_id,1,
       allowlist,repeat('c',64),created_at,expires_at,expires_at,completions
     FROM unnest($3::uuid[],$4::uuid[],$5::text[],$6::uuid[],$7::uuid[],$8::jsonb[],
       $9::timestamptz[],$10::timestamptz[],$11::jsonb[])
       AS rows(continuation_id,account_id,operation_key,receipt_id,transaction_id,allowlist,created_at,expires_at,completions)`,
    [
      route,
      prefix,
      rows.map(({ continuationId }) => continuationId),
      rows.map(({ owner }) => owner),
      rows.map(({ operationKey }) => operationKey),
      rows.map(({ receiptId }) => receiptId),
      rows.map(({ transactionId }) => transactionId),
      rows.map(({ allowlist }) => allowlist),
      rows.map(({ createdAt }) => createdAt),
      rows.map(({ expiresAt }) => expiresAt),
      rows.map(({ completions }) => completions),
    ],
  );
  await database.admin.query(
    `INSERT INTO core.receipt(partition_no,principal_kind,principal_id,command_kind,idempotency_key,
       request_digest,epoch,position,transaction_id,response)
     SELECT $1,'account',account_id,'continuation-history',continuation_id::text,$3,1,1,receipt_id,'{}'::jsonb
     FROM unnest($2::uuid[],$4::uuid[],$5::uuid[]) AS rows(account_id,continuation_id,receipt_id)`,
    [
      route >>> 4,
      rows.map(({ owner }) => owner),
      Buffer.alloc(32),
      rows.map(({ continuationId }) => continuationId),
      rows.map(({ receiptId }) => receiptId),
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
  let preparedOwners: string[] = [];
  let run = 0;
  const report = await checkGrowth(db, {
    name: 'committed continuation fanout page completion',
    scales: [256, 1024, 4096],
    repetitions: 1,
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    async grow(database, scale, previous) {
      // Unrelated accounts, continuations, receipts and page history grow at 500 rows per scale unit.
      const seed = Bun.randomUUIDv7();
      const from = previous * rowsPerScaleUnit;
      const to = scale * rowsPerScaleUnit;
      const id = generatedId();
      await database.admin.query(
        `INSERT INTO access.account(route,account_id,kind,state,transaction_id,membership_inverse_complete)
         SELECT $1,${id},'actor','active',${id},true FROM generate_series($3::integer+1,$4::integer) n`,
        [route, seed, from, to],
      );
      await database.admin.query(
        `INSERT INTO access.committed_continuation
           (route,continuation_id,account_id,operation_key,operation_digest,command_key_prefix,
            barrier_receipt_id,barrier_transaction_id,minimum_authn_epoch,allowlist,digest,
            created_at,committed_expires_at,expires_at)
         SELECT $1,${id},${id},'unrelated:'||${id}::text,repeat('b',64),$5,${id},${id},1,
           jsonb_build_array(jsonb_build_object('step','erase-auth-owner','target',${id}::text,
           'key',$5::text||':erase-auth-owner','digest',repeat('a',64))),repeat('c',64),
           now(),now()+interval '5 minutes',now()+interval '5 minutes'
         FROM generate_series($3::integer+1,$4::integer) n`,
        [route, seed, from, to, prefix],
      );
      await database.admin.query(
        `INSERT INTO access.lifecycle_coordination
         SELECT $1,${id},${id},${id},'operator',${id}
         FROM generate_series($3::integer+1,$4::integer) n`,
        [route, seed, from, to],
      );
      await database.admin.query(
        `INSERT INTO access.operator_relation_slot
         SELECT $1,${id},${id},${id},false,${id}
         FROM generate_series($3::integer+1,$4::integer) n`,
        [route, seed, from, to],
      );
      await database.admin.query(
        `INSERT INTO access.committed_continuation_entry
         SELECT $1,${id},'fence',${id}::text,'unrelated:'||${id}::text,repeat('a',64)
         FROM generate_series($3::integer+1,$4::integer) n`,
        [route, seed, from, to],
      );
      await database.admin.query(
        `INSERT INTO access.operator_fence_page(route,continuation_id,page_key,allowlist)
         SELECT $1,${id},repeat('0',64),'[]'::jsonb
         FROM generate_series($3::integer+1,$4::integer) n`,
        [route, seed, from, to],
      );
      await database.admin.query(
        `INSERT INTO access.lifecycle_fence_receipt(route,account_id,receipt_id,minimum_authn_epoch,kind,transaction_id)
         SELECT $1,${id},${id},1,'fence',${id}
         FROM generate_series($3::integer+1,$4::integer) n`,
        [route, seed, from, to],
      );
      await database.admin.query(
        `INSERT INTO access.committed_continuation_completion(route,continuation_id,step,target,key,digest,receipt_id)
         SELECT $1,${id},'fence',${id}::text,${id}::text,repeat('a',64),${id}
         FROM generate_series($3::integer+1,$4::integer) n`,
        [route, seed, from, to],
      );
      await database.admin.query(
        `INSERT INTO core.receipt(partition_no,principal_kind,principal_id,command_kind,idempotency_key,
           request_digest,epoch,position,transaction_id,response)
         SELECT $1,'account',${generatedId('n', '$2', '$3')},'access.operator.subject-fenced',
           ${generatedId('n', '$2', '$3')}::text,$6,1,1,${generatedId('n', '$2', '$3')},'{}'
         FROM generate_series($4::integer+1,$5::integer) n`,
        [route >>> 4, route, seed, from, to, Buffer.alloc(32)],
      );
      await database.admin.query('ANALYZE access.account');
      await database.admin.query('ANALYZE access.committed_continuation');
      await database.admin.query('ANALYZE access.lifecycle_coordination');
      await database.admin.query('ANALYZE access.operator_relation_slot');
      await database.admin.query('ANALYZE access.committed_continuation_entry');
      await database.admin.query('ANALYZE access.operator_fence_page');
      await database.admin.query('ANALYZE access.lifecycle_fence_receipt');
      await database.admin.query('ANALYZE access.committed_continuation_completion');
      await database.admin.query('ANALYZE core.receipt');
      prepared = [];
      preparedOwners = [];
      run = 0;
      // Warmup, measured work and the named-index plan probe each use a fresh root.
      for (let repetition = 0; repetition < 3; repetition++) {
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
        preparedOwners.push(operator);
        prepared.push((await runner().read(operator, operator))!.reference);
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
  }
  const page = await capture(db, async () => runner().continueCommittedPage(prepared[2]!));
  expect(page.value.next).toBeNull();
  expectIndex(page.capture.plans, 'committed_continuation_pkey');
  expectIndex(page.capture.plans, 'committed_continuation_entry_pkey');
  expectIndex(page.capture.plans, 'lifecycle_coordination_purpose_page');
  const operationLookup = await capture(db, () => runner().read(preparedOwners[2]!, preparedOwners[2]!));
  expect(operationLookup.value).not.toBeNull();
  expectIndex(operationLookup.capture.plans, 'committed_continuation_route_operation_key_key');
  expectIndex(operationLookup.capture.plans, 'committed_continuation_entry_pkey');
}, 300_000);

async function lookupContinuation(database: GrowthDatabase): Promise<void> {
  await withConnection(database.pool, async (client) => {
    await client.query('BEGIN READ ONLY');
    try {
      const row = await loadContinuation.run(client, { route, continuation_id: continuationId });
      const found = Array.isArray(row) ? row.length === 1 : row != null;
      expect(found).toBe(true);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
}

test('continuation lookup stays bounded as unrelated accounts and continuations grow', async () => {
  const report = await checkGrowth(db, {
    name: 'committed cleanup continuation',
    repetitions: 3,
    warmups: 1,
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    async grow(database, scale, previous) {
      await insertUnrelatedContinuations(database, (scale - previous) * rowsPerScaleUnit, previous * rowsPerScaleUnit);
      await database.admin.query('ANALYZE access.account');
      await database.admin.query('ANALYZE access.committed_continuation');
      await database.admin.query('ANALYZE core.receipt');
    },
    operation: lookupContinuation,
  });
  expect(report.samples.map((sample) => sample.scale)).toEqual([1, 8, 64]);
  const lookup = await capture(db, () => lookupContinuation(db));
  expectIndex(lookup.capture.plans, 'committed_continuation_pkey');
});
