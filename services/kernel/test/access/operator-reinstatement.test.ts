import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { Value } from 'typebox/value';
import { createPool } from '../../src/database/pool.ts';
import { createAccess } from '../../src/access/index.ts';
import { bootstrapGovernance } from '../../src/access/bootstrap-governance.ts';
import { createCommittedContinuations } from '../../src/access/committed-continuations.ts';
import { createSuspensionCommands } from '../../src/access/suspension.ts';
import { createReinstatementCommands } from '../../src/access/reinstatement.ts';
import { createAuthBindings } from '../../src/access/auth-bindings.ts';
import { ACCESS_EVENTS } from '../../src/events/contracts/access.ts';
import { newId, routeOf } from '../../src/route/route.ts';

const pool = createPool(process.env.DATABASE_URL!);
const facts = new Pool({ connectionString: process.env.DATABASE_URL });
const keys = { current: 1, keys: new Map([[1, randomBytes(32)]]) };
const pair = await generateKeyPair('ES256', { extractable: true });
const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'reinstatement' };
const issuer = 'https://operator-reinstatement.test';
const actions = new Map(
  ['account:suspend', 'account:reinstate', 'account:manage'].map((name) => [name, { anonymous: false }]),
);
const access = createAccess({
  actions,
  auth: { issuer, audience: issuer, jwksUrl: `${issuer}/jwks`, fetch: async () => Response.json({ keys: [jwk] }) },
});
const continuations = createCommittedContinuations({ pool, access, referenceKeys: keys });
const suspend = createSuspensionCommands({ pool, access, clock: () => new Date() }).suspend;
const reinstate = createReinstatementCommands({ pool, access, clock: () => new Date() }).reinstate;
let governor: string;
const context = async () => {
  const deadline = Date.now() + 30_000;
  return { pool, actor: await access.authenticate(await token(governor), { pool, deadline }), deadline };
};
async function token(accountId: string, epoch = 1) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    sub: accountId,
    client_id: 'test',
    scope: [...actions.keys()].join(' '),
    authn_epoch: epoch,
    iat: now,
    exp: now + 300,
    auth_time: now,
    amr: ['pwd'],
  })
    .setIssuer(issuer)
    .setAudience(issuer)
    .setProtectedHeader({ alg: 'ES256', kid: jwk.kid, typ: 'at+jwt' })
    .sign(pair.privateKey);
}
async function account() {
  const id = newId(0x7561);
  await facts.query(
    `INSERT INTO access.account(route,account_id,kind,state,transaction_id,membership_inverse_complete) VALUES ($1,$2,'actor','active',$2,true)`,
    [routeOf(id), id],
  );
  return id;
}
async function row(id: string) {
  return (await facts.query('SELECT * FROM access.account WHERE route=$1 AND account_id=$2', [routeOf(id), id]))
    .rows[0];
}
async function fixture(count: number) {
  const operator = await account();
  const subjects: string[] = [];
  for (let index = 0; index < count; index++) {
    const subject = await account();
    // Ordered reservation ids make the crash and later-page cases deterministic.
    const reservation = `00000000-0000-8000-8000-7561${index.toString(16).padStart(8, '0')}`;
    await facts.query(`INSERT INTO access.lifecycle_coordination VALUES ($1,$2,$3,$4,'operator',$2)`, [
      routeOf(operator),
      operator,
      reservation,
      subject,
    ]);
    await facts.query(
      'UPDATE access.account SET operator_account_id=$1,operator_reservation_id=$2 WHERE route=$3 AND account_id=$4',
      [operator, reservation, routeOf(subject), subject],
    );
    await facts.query('INSERT INTO access.operator_relation_slot VALUES ($1,$2,$3,$4,false,$4)', [
      routeOf(subject),
      subject,
      reservation,
      operator,
    ]);
    subjects.push(subject);
  }
  return { operator, subjects };
}
async function fence(operator: string) {
  const result = await suspend(await context(), { accountId: operator, key: randomUUID() });
  const root = (await continuations.read(result.value.continuationOperationKey!, operator))!;
  await continuations.continueCommitted(root.reference);
  return root;
}
async function restore(operator: string) {
  const result = await reinstate(await context(), { accountId: operator, key: randomUUID() });
  const root = (await continuations.read(`reinstate:${result.value.receiptId}`, operator))!;
  expect(root.barrierReceiptId).toBe(result.value.receiptId);
  return root;
}
beforeAll(async () => {
  governor = await account();
  await bootstrapGovernance(pool, governor);
});
afterAll(async () => {
  await pool.end();
  await facts.end();
});

test('reinstatement lifts 205 operated accounts across signed pages, preserves floors and admits only fresh tokens', async () => {
  const f = await fixture(205);
  const old = await token(f.subjects[0]!);
  await fence(f.operator);
  const before = await Promise.all(f.subjects.map(row));
  const auth = createAuthBindings({ pool });
  expect(await auth.readAccount(f.subjects[0]!)).toBeNull();
  const root = await restore(f.operator);
  // A credential rotation on the active operator must not strand its automation.
  await facts.query('UPDATE access.account SET minimum_authn_epoch=minimum_authn_epoch+1 WHERE account_id=$1', [
    f.operator,
  ]);
  await continuations.continueCommitted(root.reference);
  const after = await Promise.all(f.subjects.map(row));
  expect(await auth.readAccount(f.subjects[0]!)).toMatchObject({ automated: true, authnEpoch: 2 });
  for (let i = 0; i < after.length; i++) {
    expect(after[i].authn_fenced).toBe(false);
    expect(after[i].minimum_authn_epoch).toBe(before[i].minimum_authn_epoch);
    expect(after[i].fence_receipt_id).toBe(before[i].fence_receipt_id);
  }
  const pages = await facts.query(
    'SELECT allowlist FROM access.operator_fence_page WHERE route=$1 AND continuation_id=(SELECT continuation_id FROM access.committed_continuation WHERE route=$1 AND operation_key=$2)',
    [routeOf(f.operator), root.operationKey],
  );
  expect(pages.rows).toHaveLength(3);
  expect(
    pages.rows.every(
      (page) => page.allowlist.filter((child: { step: string }) => child.step === 'unfence').length <= 100,
    ),
  ).toBe(true);
  await expect(access.authenticate(old, { pool, deadline: Date.now() + 10_000 })).rejects.toMatchObject({
    status: 401,
  });
  await expect(
    access.authenticate(await token(f.subjects[0]!, 2), { pool, deadline: Date.now() + 10_000 }),
  ).resolves.toMatchObject({ accountId: f.subjects[0] });
  await continuations.continueCommitted(root.reference);
  expect(await Promise.all(f.subjects.map(row))).toEqual(after);
  const receipts = await facts.query(
    "SELECT response FROM core.receipt WHERE command_kind='access.operator.subject-unfenced'",
  );
  expect(receipts.rows).toHaveLength(205);
  for (const { response } of receipts.rows)
    expect(Value.Check(ACCESS_EVENTS['com.rezics.access.operator.subject-unfenced.v1'], response)).toBe(true);
}, 60_000);

test('other fences, own suspensions, transfers, deleted accounts and changed reservations stay unchanged', async () => {
  const f = await fixture(7);
  const [prior, other, suspended, moved, deleted, renewed, normal] = f.subjects as [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  await facts.query('UPDATE access.account SET authn_fenced=true,fence_receipt_id=$1 WHERE account_id=$2', [
    newId(0x7561),
    prior,
  ]);
  await fence(f.operator);
  await facts.query(
    'UPDATE access.account SET fence_receipt_id=$1,minimum_authn_epoch=minimum_authn_epoch+1 WHERE account_id=$2',
    [newId(0x7561), other],
  );
  await suspend(await context(), { accountId: suspended, key: randomUUID() });
  await facts.query('UPDATE access.account SET operator_account_id=$1 WHERE account_id=$2', [await account(), moved]);
  await facts.query("UPDATE access.account SET state='deleted' WHERE account_id=$1", [deleted]);
  await facts.query('UPDATE access.account SET operator_reservation_id=$1 WHERE account_id=$2', [
    newId(0x7561),
    renewed,
  ]);
  const preserved = await Promise.all([prior, other, suspended, moved, deleted, renewed].map(row));
  await continuations.continueCommitted((await restore(f.operator)).reference);
  expect(await Promise.all([prior, other, suspended, moved, deleted, renewed].map(row))).toEqual(preserved);
  expect((await row(normal)).authn_fenced).toBe(false);
});

test('a crash after a subject commit replays the persisted allowlist with one receipt per subject', async () => {
  const f = await fixture(3);
  await fence(f.operator);
  const root = await restore(f.operator);
  await facts.query(
    `CREATE FUNCTION access.fail_lift() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.account_id='${f.subjects[1]}'::uuid AND OLD.authn_fenced AND NOT NEW.authn_fenced THEN RAISE EXCEPTION 'crashed lift'; END IF; RETURN NEW; END $$`,
  );
  await facts.query(
    'CREATE TRIGGER fail_lift BEFORE UPDATE ON access.account FOR EACH ROW EXECUTE FUNCTION access.fail_lift()',
  );
  try {
    await expect(continuations.continueCommittedPage(root.reference)).rejects.toThrow('crashed lift');
  } finally {
    await facts.query('DROP TRIGGER fail_lift ON access.account');
    await facts.query('DROP FUNCTION access.fail_lift()');
  }
  const first = await row(f.subjects[0]!);
  expect(first.authn_fenced).toBe(false);
  const restarted = createCommittedContinuations({ pool, access, referenceKeys: keys });
  await restarted.continueCommitted(root.reference);
  expect(await row(f.subjects[0]!)).toEqual(first);
  for (const subject of f.subjects) expect((await row(subject)).authn_fenced).toBe(false);
  const receipts = await facts.query(
    "SELECT response FROM core.receipt WHERE command_kind='access.operator.subject-unfenced' AND response->>'accountId'=ANY($1::text[])",
    [f.subjects],
  );
  expect(receipts.rows).toHaveLength(3);
});

test('another suspension stops later pages and an old reversal stays stopped after another reinstatement', async () => {
  const f = await fixture(3);
  await fence(f.operator);
  const root = await restore(f.operator);
  const small = createCommittedContinuations({ pool, access, referenceKeys: keys, pageSize: 1 });
  const first = await small.continueCommittedPage(root.reference);
  expect(first.next).toBeString();
  const suspension = await suspend(await context(), { accountId: f.operator, key: randomUUID() });
  const before = await Promise.all(f.subjects.map(row));
  expect((await small.continueCommittedPage(root.reference, first.next!, first.pageKey)).next).toBeNull();
  expect(await Promise.all(f.subjects.map(row))).toEqual(before);
  const newRoot = (await small.read(suspension.value.continuationOperationKey!, f.operator))!;
  await small.continueCommitted(newRoot.reference);
  await restore(f.operator);
  const again = await Promise.all(f.subjects.map(row));
  await small.continueCommitted(root.reference);
  expect(await Promise.all(f.subjects.map(row))).toEqual(again);
});
