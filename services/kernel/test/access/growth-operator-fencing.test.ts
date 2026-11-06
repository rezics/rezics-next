import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createPool } from '../../src/database/pool.ts';
import { createAccess } from '../../src/access/index.ts';
import { bootstrapGovernance } from '../../src/access/bootstrap-governance.ts';
import { createCommittedContinuations } from '../../src/access/committed-continuations.ts';
import { createSuspensionCommands } from '../../src/access/suspension.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import { type Pending } from '../../src/history/contract/identity-types.ts';

const route = 0x7540;
const governor = newId(route);
const keys = { current: 1, keys: new Map([[1, randomBytes(32)]]) };
const pair = await generateKeyPair('ES256', { extractable: true });
const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'fence-growth' };
const issuer = 'https://fence-growth.test';
const audience = 'https://fence-growth.api.test';
const actions = new Map([
  ['account:suspend', { anonymous: false }],
  ['account:manage', { anonymous: false }],
]);
const access = createAccess({
  actions,
  auth: { issuer, audience, jwksUrl: `${issuer}/jwks`, fetch: async () => Response.json({ keys: [jwk] }) },
});
let db: GrowthDatabase;
let fixturePool: ReturnType<typeof createPool>;
let token: string;
const P = 4;
const reservation = (n: number) => `00000000-0000-8000-8000-7540${n.toString(16).padStart(8, '0')}`;
const continuation = (pool = db.pool) =>
  createCommittedContinuations({ pool, access, referenceKeys: keys, pageSize: P });
beforeAll(async () => {
  db = await openGrowthDatabase();
  fixturePool = createPool(db.url);
  await account(governor);
  await bootstrapGovernance(fixturePool, governor);
  const now = Math.floor(Date.now() / 1000);
  token = await new SignJWT({
    sub: governor,
    client_id: 'growth',
    scope: 'account:suspend',
    authn_epoch: 1,
    iat: now,
    exp: now + 300,
    auth_time: now,
    amr: ['pwd'],
  })
    .setIssuer(issuer)
    .setAudience(audience)
    .setProtectedHeader({ alg: 'ES256', kid: jwk.kid, typ: 'at+jwt' })
    .sign(pair.privateKey);
});
afterAll(async () => {
  await fixturePool?.end();
  await db?.close();
});
async function account(id = newId(route)) {
  await db.admin.query(
    `INSERT INTO access.account(route,account_id,kind,state,transaction_id,membership_inverse_complete)
    VALUES ($1,$2,'actor','active',$2,true)`,
    [routeOf(id), id],
  );
  return id;
}
async function held(operator: string, n: number, related = true) {
  const subject = await account();
  const id = reservation(n);
  await db.admin.query(`INSERT INTO access.lifecycle_coordination VALUES ($1,$2,$3,$4,'operator',$2)`, [
    route,
    operator,
    id,
    subject,
  ]);
  if (related) {
    await db.admin.query(
      'UPDATE access.account SET operator_account_id=$1,operator_reservation_id=$2 WHERE route=$3 AND account_id=$4',
      [operator, id, route, subject],
    );
    await db.admin.query('INSERT INTO access.operator_relation_slot VALUES ($1,$2,$3,$4,false,$4)', [
      route,
      subject,
      id,
      operator,
    ]);
  }
}
async function root(operator: string) {
  const actor = await access.authenticate(token, { pool: fixturePool, deadline: Date.now() + 10_000 });
  const suspended = await createSuspensionCommands({ pool: fixturePool, access, clock: () => new Date() }).suspend(
    { pool: fixturePool, actor, deadline: Date.now() + 10_000 },
    { accountId: operator, key: randomUUID() },
  );
  return (await continuation(fixturePool).read(suspended.value.continuationOperationKey!, operator))!;
}

for (const population of ['unrelated accounts', 'completed and pending history'] as const) {
  for (const late of [false, true]) {
    test(`${late ? 'late' : 'first'} committed fence page stays bounded as ${population} grows`, async () => {
      let prepared: { reference: string; next: string | null | undefined; pageKey: string | undefined }[] = [];
      let run = 0;
      const report = await checkGrowth(db, {
        name: `${late ? 'late' : 'first'} fence page: ${population}`,
        scales: [1, 8, 64],
        bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
        repetitions: 1,
        warmups: 1,
        async grow(_database, scale, previous) {
          if (previous === 0) {
            // Populate unrelated responsibility keys before VACUUM so the fixed
            // page seek cannot scan the entire tiny first fixture instead.
            const ids = Array.from({ length: 1024 }, () => newId(route));
            await db.admin.query(
              `INSERT INTO access.lifecycle_coordination
                (route,account_id,reservation_id,related_account_id,purpose,transaction_id)
               SELECT $1,id,id,id,'operator',id FROM unnest($2::uuid[]) id`,
              [route, ids],
            );
            // Completed unrelated slots make the subject/reservation point
            // probes selective before the first measured late page.
            await db.admin.query(
              `INSERT INTO access.operator_relation_slot
                (route,subject_account_id,reservation_id,operator_account_id,terminal,transaction_id)
               SELECT $1,id,id,id,true,id FROM unnest($2::uuid[]) id`,
              [route, ids],
            );
          }
          prepared = [];
          run = 0;
          // Warm-up and capture each get a fresh committed page. Fixture writes
          // and earlier pages finish before checkGrowth vacuums and captures.
          for (let repetition = 0; repetition < 2; repetition++) {
            const operator = await account();
            for (let i = 1; i <= P; i++) await held(operator, i);
            for (let i = 1; i <= P; i++) await held(operator, 1_000_000 + i);
            if (population === 'unrelated accounts') {
              for (let i = 0; i < scale * 32; i++) await account();
            } else {
              for (let i = 1; i <= scale * 16; i++) {
                // Completed slots no longer have responsibility rows. Pending
                // unpublished holds sort beyond both fixed page seeks.
                const subject = await account();
                await db.admin.query('INSERT INTO access.operator_relation_slot VALUES ($1,$2,$3,$4,true,$4)', [
                  route,
                  subject,
                  reservation(2_000_000 + i),
                  operator,
                ]);
                await db.admin.query(`INSERT INTO access.lifecycle_coordination VALUES ($1,$2,$3,$4,'operator',$2)`, [
                  route,
                  operator,
                  reservation(3_000_000 + i),
                  newId(route),
                ]);
              }
            }
            const view = await root(operator);
            const first = late ? await continuation(fixturePool).continueCommittedPage(view.reference) : undefined;
            prepared.push({ reference: view.reference, next: first?.next, pageKey: first?.pageKey });
          }
          if (previous === 0) {
            // Cardinality-only committed history, never used as a capability.
            // Keep page and continuation point probes beyond tiny-table scans.
            const ids = Array.from({ length: 1024 }, () => newId(route));
            await db.admin.query(
              `INSERT INTO access.account(route,account_id,kind,state,transaction_id)
               SELECT $1,id,'actor','active',id FROM unnest($2::uuid[]) id`,
              [route, ids],
            );
            await db.admin.query(
              `INSERT INTO access.committed_continuation
               SELECT (jsonb_populate_record(NULL::access.committed_continuation,
                 to_jsonb(template) || jsonb_build_object('continuation_id',id,'account_id',id,
                   'operation_key','unrelated:'||id::text))).*
               FROM (SELECT * FROM access.committed_continuation WHERE route=$1 LIMIT 1) template
               CROSS JOIN unnest($2::uuid[]) id`,
              [route, ids],
            );
            await db.admin.query(
              `INSERT INTO access.operator_fence_page(route,continuation_id,page_key,allowlist)
               SELECT $1,id,repeat('0',64),'[]'::jsonb FROM unnest($2::uuid[]) id`,
              [route, ids],
            );
            // Unrelated receipt keys keep exact command replay checks on their
            // index from the first scale, before native page receipts accrue.
            await db.admin.query(
              `INSERT INTO core.receipt
                 (partition_no,principal_kind,principal_id,command_kind,idempotency_key,
                  request_digest,epoch,position,transaction_id,response)
               SELECT $1,'account',id,'access.suspend',id::text,$3,1,1,id,'{}'
               FROM unnest($2::uuid[]) id`,
              [route >>> 4, ids, Buffer.alloc(32)],
            );
          }
        },
        async operation() {
          const page = prepared[run++]!;
          const result = await continuation().continueCommittedPage(
            page.reference,
            page.next ?? undefined,
            page.pageKey,
          );
          expect(result.pageKey).toBeString();
        },
      });
      for (const sample of report.samples) {
        expect(sample.cost.relations?.['access.lifecycle_coordination']?.rows).toBe(
          late && population === 'unrelated accounts' ? P : P + 1,
        );
        expect(sample.cost.relations?.['access.lifecycle_coordination']?.sequentialScans).toBe(0);
      }
    }, 60_000);
  }
}

test('total committed fanout work is linear in affected accounts with fixed page size', async () => {
  let prepared: { operator: string; reference: string }[] = [];
  let run = 0;
  const report = await checkGrowth(db, {
    name: 'total operator fence fanout',
    scales: [1, 8, 64],
    bounds: { rows: 'linear', statements: 'linear', blocks: 'linear' },
    repetitions: 1,
    warmups: 1,
    async grow(_database, scale) {
      prepared = [];
      run = 0;
      for (let repetition = 0; repetition < 2; repetition++) {
        const operator = await account();
        for (let n = 1; n <= scale * P; n++) await held(operator, n);
        const view = await root(operator);
        prepared.push({ operator, reference: view.reference });
      }
    },
    async operation(_database, scale) {
      const { operator, reference } = prepared[run++]!;
      await continuation().continueCommitted(reference);
      expect(
        (
          await db.admin.query(
            'SELECT count(*)::integer AS n FROM access.operator_fence_page WHERE continuation_id=(SELECT continuation_id FROM access.committed_continuation WHERE route=$1 AND account_id=$2)',
            [route, operator],
          )
        ).rows[0].n,
      ).toBe(scale);
    },
  });
  for (const sample of report.samples)
    expect(sample.cost.relations?.['access.lifecycle_coordination']?.rows).toBeLessThanOrEqual(sample.scale * (P + 1));
}, 60_000);
