import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createPool } from '../../src/database/pool.ts';
import { createAccess } from '../../src/access/index.ts';
import { bootstrapGovernance } from '../../src/access/bootstrap-governance.ts';
import { createCommittedContinuations } from '../../src/access/committed-continuations.ts';
import { createSuspensionCommands } from '../../src/access/suspension.ts';
import { createReinstatementCommands } from '../../src/access/reinstatement.ts';
import { newId } from '../../src/route/route.ts';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';

const route = 0x7562;
const keys = { current: 1, keys: new Map([[1, randomBytes(32)]]) };
const pair = await generateKeyPair('ES256', { extractable: true });
const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'unfence-growth' };
const issuer = 'https://operator-unfence-growth.test';
const actions = new Map(
  ['account:suspend', 'account:reinstate', 'account:manage'].map((name) => [name, { anonymous: false }]),
);
const access = createAccess({
  actions,
  auth: { issuer, audience: issuer, jwksUrl: `${issuer}/jwks`, fetch: async () => Response.json({ keys: [jwk] }) },
});
let db: GrowthDatabase;
let seedPool: ReturnType<typeof createPool>;
let governor: string;
const P = 2;
const continuation = (pool = db.pool) =>
  createCommittedContinuations({ pool, access, referenceKeys: keys, pageSize: P });
const context = async () => {
  const deadline = Date.now() + 30_000;
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({
    sub: governor,
    client_id: 'growth',
    scope: [...actions.keys()].join(' '),
    authn_epoch: 1,
    iat: now,
    exp: now + 300,
    auth_time: now,
    amr: ['pwd'],
  })
    .setIssuer(issuer)
    .setAudience(issuer)
    .setProtectedHeader({ alg: 'ES256', kid: jwk.kid, typ: 'at+jwt' })
    .sign(pair.privateKey);
  return { pool: seedPool, actor: await access.authenticate(token, { pool: seedPool, deadline }), deadline };
};
async function account() {
  const id = newId(route);
  await db.admin.query(
    `INSERT INTO access.account(route,account_id,kind,state,transaction_id,membership_inverse_complete) VALUES ($1,$2,'actor','active',$2,true)`,
    [route, id],
  );
  return id;
}
async function fixture() {
  const operator = await account();
  for (let index = 0; index < P * 2; index++) {
    const subject = await account();
    const reservation = newId(route);
    await db.admin.query(`INSERT INTO access.lifecycle_coordination VALUES ($1,$2,$3,$4,'operator',$2)`, [
      route,
      operator,
      reservation,
      subject,
    ]);
    await db.admin.query(
      'UPDATE access.account SET operator_account_id=$1,operator_reservation_id=$2 WHERE route=$3 AND account_id=$4',
      [operator, reservation, route, subject],
    );
    await db.admin.query('INSERT INTO access.operator_relation_slot VALUES ($1,$2,$3,$4,false,$4)', [
      route,
      subject,
      reservation,
      operator,
    ]);
  }
  return operator;
}
async function reversal(operator: string) {
  const fenced = await createSuspensionCommands({ pool: seedPool, access, clock: () => new Date() }).suspend(
    await context(),
    { accountId: operator, key: randomUUID() },
  );
  const barrier = (await continuation(seedPool).read(fenced.value.continuationOperationKey!, operator))!;
  await continuation(seedPool).continueCommitted(barrier.reference);
  const restored = await createReinstatementCommands({ pool: seedPool, access, clock: () => new Date() }).reinstate(
    await context(),
    { accountId: operator, key: randomUUID() },
  );
  return (await continuation(seedPool).read(`reinstate:${restored.value.receiptId}`, operator))!;
}
beforeAll(async () => {
  db = await openGrowthDatabase();
  seedPool = createPool(db.url);
  governor = await account();
  await bootstrapGovernance(seedPool, governor);
});
afterAll(async () => {
  await seedPool?.end();
  await db?.close();
});

for (const late of [false, true]) {
  test(`${late ? 'late' : 'first'} reinstatement page stays bounded as unrelated accounts and earlier operator fence and reinstatement history grow`, async () => {
    const operators: string[] = [];
    const prepared: { reference: string; cursor?: string; previous?: string }[] = [];
    let next = 0;
    const report = await checkGrowth(db, {
      name: `${late ? 'late' : 'first'} operator reinstatement page`,
      scales: [1, 8, 64],
      repetitions: 1,
      bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
      async grow(_database, scale, previous) {
        if (previous === 0) {
          operators.push(await fixture(), await fixture());
          // Keep the planner on indexed paths at the first scale as well as the
          // last; small-table sequential scans would measure a plan transition.
          const noise = Array.from({ length: 2048 }, () => newId(route));
          await db.admin.query(
            `INSERT INTO access.account(route,account_id,kind,state,transaction_id,membership_inverse_complete)
            SELECT $1,id,'actor','active',id,true FROM unnest($2::uuid[]) id`,
            [route, noise],
          );
          await db.admin.query(
            `INSERT INTO access.operator_relation_slot
            SELECT $1,id,id,$3,true,id FROM unnest($2::uuid[]) id`,
            [route, noise, governor],
          );
          await db.admin.query(
            `INSERT INTO access.lifecycle_coordination
            SELECT $1,$3,id,id,'operator',id FROM unnest($2::uuid[]) id`,
            [route, noise, governor],
          );
          await db.admin.query(
            `INSERT INTO access.lifecycle_fence_receipt(route,account_id,receipt_id,minimum_authn_epoch,kind,transaction_id)
            SELECT $1,id,id,1,'fence',id FROM unnest($2::uuid[]) id`,
            [route, noise],
          );
          await db.admin.query(
            `INSERT INTO access.committed_continuation
            (route,continuation_id,account_id,operation_key,operation_digest,command_key_prefix,barrier_receipt_id,
             barrier_transaction_id,minimum_authn_epoch,allowlist,digest,created_at,committed_expires_at,expires_at)
            SELECT $1,id,id,'noise:'||id::text,repeat('a',64),'wf:'||repeat('b',64),id,id,1,
              jsonb_build_array(jsonb_build_object('step','erase-auth-owner','target',id::text,'key','noise','digest',repeat('a',64))),
              repeat('c',64),now(),now()+interval '5 minutes',now()+interval '5 minutes' FROM unnest($2::uuid[]) id`,
            [route, noise],
          );
          await db.admin.query(
            `INSERT INTO core.receipt
            (partition_no,principal_kind,principal_id,command_kind,idempotency_key,request_digest,epoch,position,transaction_id,response)
            SELECT $1,'account',$3,'growth-noise',id::text,decode(repeat('a',64),'hex'),1,1,id,'{}'::jsonb FROM unnest($2::uuid[]) id`,
            [Math.floor(route / 16), noise, governor],
          );
        }
        for (let index = previous; index < scale; index++) {
          for (let n = 0; n < 16; n++) await account();
          for (const operator of operators)
            await continuation(seedPool).continueCommitted((await reversal(operator)).reference);
        }
        prepared.length = 0;
        next = 0;
        for (const operator of operators) {
          const root = await reversal(operator);
          const first = late ? await continuation(seedPool).continueCommittedPage(root.reference) : undefined;
          prepared.push({
            reference: root.reference,
            ...(first ? { cursor: first.next!, previous: first.pageKey } : {}),
          });
        }
      },
      async operation() {
        const page = prepared[next++]!;
        const result = await continuation().continueCommittedPage(page.reference, page.cursor, page.previous);
        expect(result.next === null).toBe(late);
      },
    });
    expect(report.samples.map((sample) => sample.scale)).toEqual([1, 8, 64]);
    for (const sample of report.samples) {
      expect(sample.cost.relations?.['access.lifecycle_fence_receipt']?.sequentialScans).toBe(0);
      expect(sample.cost.relations?.['access.lifecycle_coordination']?.rows).toBeLessThanOrEqual(P + 1);
    }
  }, 180_000);
}
