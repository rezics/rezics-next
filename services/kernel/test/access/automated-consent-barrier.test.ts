import { reinstateAccount, suspendAccount } from '../support/native-suspension-driver.ts';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { exportJWK, generateKeyPair } from 'jose';
import { migrate as migrateAuth } from '../../../auth/scripts/database.ts';
import { createPool } from '../../src/database/pool.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { unseal } from '../../src/tokens/seal.ts';

// The focused acceptance command also runs from the repository root.
await import('reylo/register');
const { readAccount } = await import('../../src/access/account-data.ts');
const { openingManagement } = await import('../../src/access/operator.ts');
const { createKernel } = await import('../../src/http/kernel.ts');
const { cookies, nativeFixture, password, scopes } = await import('./native-account-bindings-fixture.ts');

const url = process.env.DATABASE_URL!;
const pool = createPool(url);
const client = 'automated-ext';
const consented = ['account:manage', 'read', 'write'];
const sessionScope = ['account:manage', 'read'];
let f: Awaited<ReturnType<typeof nativeFixture>>;
let kernel: ReturnType<typeof createKernel>;
let owner: Person;
// The owner's first-party session administers membership and grants; its ext session opens automated sessions.
let admin: { bearer: string; headers: Headers };
let organizationId: string;
let sequence = 0;
type Person = Awaited<ReturnType<typeof person>>;
const key = () => Bun.randomUUIDv7();

async function seed(accountId: string, scopes = consented) {
  await f.authPool.query(
    `INSERT INTO auth_consent (account_id,client_id,scopes) VALUES ($1,$2,$3)
     ON CONFLICT (account_id,client_id) DO UPDATE SET scopes=EXCLUDED.scopes,pending_scopes=NULL,pending_reference=NULL`,
    [accountId, client, scopes],
  );
}
// A person whose session on the non-first-party client is the one that opens automated sessions.
async function person(name: string) {
  const registered = await f.person(`barrier_${name}_${++sequence}`);
  await seed(registered.accountId);
  const signed = await f.request('/signin', {
    email: `barrier_${name}_${sequence}@ordinary.test`,
    password,
    client_id: client,
    scope: sessionScope,
  });
  expect(signed.status).toBe(200);
  const headers = cookies(signed);
  const token = await f.request('/token', {}, headers);
  expect(token.status).toBe(200);
  const { access_token: bearer } = (await token.json()) as { access_token: string };
  return { accountId: registered.accountId, email: `barrier_${name}_${sequence}@ordinary.test`, bearer, headers };
}
async function context(human: { bearer: string }) {
  const deadline = Date.now() + 10000;
  const actor = await f.access.authenticate(human.bearer, { pool, deadline });
  return { actor, account: await readAccount(pool, routeOf(actor.accountId)!, actor.accountId), deadline };
}
async function membership(human: Person, role: 'owner' | 'member' | null) {
  const held = await f.bindings.internalLifecycle.reserveCoordination({
    accountId: human.accountId,
    relatedAccountId: organizationId,
    purpose: 'membership',
    key: key(),
  });
  await f.bindings.lifecycle.setMembership(await context(admin), {
    organizationId,
    memberAccountId: human.accountId,
    reservationId: held.value.reservationId,
    role,
    key: key(),
  });
}
async function grant(human: Person, path = '/v1/grants') {
  return kernel.handle(
    new Request(`https://kernel.test${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${admin.bearer}`,
        'content-type': 'application/json',
        'idempotency-key': JSON.stringify(key()),
      },
      body: JSON.stringify({
        resource: { route: routeOf(organizationId)!, id: organizationId },
        subject: { kind: 'account', id: human.accountId },
        actions: ['account:manage'],
        valid: '(,)',
      }),
    }),
  );
}
async function automated() {
  const subject = await f.automated(`barrier_agent_${++sequence}`, { accountId: organizationId, bearer: admin.bearer });
  await seed(subject.accountId);
  return subject.accountId;
}
async function approve(human: Person, subjectAccountId: string) {
  const approved = await f.bindings.workflowPorts.authorizeOpening!(await context(human), {
    operatorAccountId: organizationId,
    subjectAccountId,
    purpose: 'session',
    key: key(),
  });
  // The port returns a sealed reference; Auth and Access address the opening by its receipt id.
  const { receiptId } = unseal(f.referenceKeys, 'access.operator-session.v1', approved.value.receiptId) as {
    receiptId: string;
  };
  return { reference: approved.value.receiptId, receiptId };
}
// The human's session opens one automated session through the real Access opening and Auth issuance.
async function open(human: Person, subjectAccountId: string) {
  const { reference, receiptId } = await approve(human, subjectAccountId);
  const response = await f.host.service.internal.openAutomatedSession({
    authorization: reference,
    subjectAccountId,
    headers: human.headers,
  });
  expect(response.status).toBe(200);
  return { receiptId, headers: cookies(response) };
}
async function issued(headers: Headers) {
  const response = await f.request('/token', {}, headers);
  expect(response.status).toBe(200);
  return ((await response.json()) as { access_token: string }).access_token;
}
const accepted = (token: string) =>
  f.access.authenticate(token, { pool, deadline: Date.now() + 10000 }).then(
    () => true,
    () => false,
  );
const reduce = (headers: Headers, scope = sessionScope) => f.request('/consent', { client_id: client, scope }, headers);
async function state(accountId: string) {
  const account = (await readAccount(pool, routeOf(accountId)!, accountId))!;
  const receipts = await pool.query(
    'SELECT count(*)::int AS count FROM access.lifecycle_fence_receipt WHERE route=$1 AND account_id=$2',
    [routeOf(accountId), accountId],
  );
  const consent = await f.authPool.query('SELECT scopes FROM auth_consent WHERE account_id=$1 AND client_id=$2', [
    accountId,
    client,
  ]);
  return {
    floor: account.minimumAuthnEpoch,
    receipts: receipts.rows[0].count as number,
    scopes: consent.rows[0]?.scopes,
  };
}
// The Access command alone, as Auth's trusted port would call it, with a well-formed proof.
function advance(input: {
  accountId: string;
  purpose: 'consent-reduction' | 'recovery';
  floor: bigint;
  openingReceiptId?: string | undefined;
}) {
  return f.bindings.internalLifecycle.advanceAuthenticationFloor(
    {
      accountId: input.accountId,
      key: key(),
      purpose: input.purpose,
      expectedMinimumAuthnEpoch: Number(input.floor),
      proofReference: 'a'.repeat(64),
      proofDigest: 'b'.repeat(64),
      proofExpiresAt: new Date(Date.now() + 60000).toISOString(),
      ...(input.openingReceiptId === undefined ? {} : { openingReceiptId: input.openingReceiptId }),
    },
    async () => true,
    openingManagement(f.access),
  );
}

beforeAll(async () => {
  migrateAuth(url);
  const pair = await generateKeyPair('ES256', { extractable: true });
  f = await nativeFixture(pool, undefined, {
    database: { url, container: '', close() {} },
    privateKey: { ...(await exportJWK(pair.privateKey)), kid: 'automated-consent-barrier' },
  });
  await f.host.service.internal.registerClient({
    clientId: 'organization-management',
    firstParty: true,
    scopes: [...scopes, 'organization:membership'],
  });
  await f.host.service.internal.registerClient({
    clientId: client,
    firstParty: false,
    scopes: ['account:manage', 'read', 'write'],
  });
  kernel = createKernel({
    pool,
    routeKey: new Uint8Array(32).fill(91),
    tokens: f.referenceKeys,
    access: () => f.access,
    writeRate: {
      async spend() {
        return { allowed: true };
      },
    },
  });
  owner = await person('owner');
  const signed = await f.request('/signin', {
    email: owner.email,
    password,
    client_id: 'organization-management',
    scope: [...scopes, 'organization:membership'],
  });
  expect(signed.status).toBe(200);
  admin = {
    headers: cookies(signed),
    bearer: ((await (await f.request('/token', {}, cookies(signed))).json()) as { access_token: string }).access_token,
  };
  organizationId = newId(0x9200);
  const held = await f.bindings.internalLifecycle.reserveCoordination({
    accountId: owner.accountId,
    relatedAccountId: organizationId,
    purpose: 'membership',
    key: key(),
  });
  await f.bindings.internalLifecycle.createOrganization({
    organizationId,
    ownerAccountId: owner.accountId,
    ownerReservationId: held.value.reservationId,
    key: key(),
  });
}, 60000);
afterAll(async () => {
  try {
    await f?.close();
  } finally {
    await pool.end();
  }
});

test("an operator-opened session reduces the automated account's consent and the barrier advances its floor once", async () => {
  const subject = await automated();
  const { headers } = await open(owner, subject);
  const earlier = await issued(headers);
  expect(await accepted(earlier)).toBe(true);
  const before = await state(subject);

  const response = await reduce(headers);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ client_id: client, scope: sessionScope });
  const after = await state(subject);
  expect(after).toEqual({ floor: before.floor + 1n, receipts: before.receipts + 1, scopes: sessionScope });
  // The token the account obtained earlier is refused by Access from the new floor.
  expect(await accepted(earlier)).toBe(false);
  expect((await f.request('/token', {}, headers)).status).toBeGreaterThanOrEqual(400);

  // The reduction cannot be repeated from the consumed opening.
  expect((await reduce(headers, ['account:manage'])).status).toBeGreaterThanOrEqual(400);
  expect(await state(subject)).toEqual(after);
});

test('a granted manager reduces, and loses that ability when the grant is revoked after the opening', async () => {
  const member = await person('member');
  await membership(member, 'member');
  const subject = await automated();
  await expect(approve(member, subject)).rejects.toThrow();
  expect((await grant(member)).status).toBe(201);
  const { headers } = await open(member, subject);
  const before = await state(subject);

  expect((await grant(member, '/v1/grants:revoke')).status).toBe(200);
  expect((await reduce(headers)).status).toBeGreaterThanOrEqual(400);
  expect(await state(subject)).toEqual(before);

  // Restoring the grant restores the reduction from the same opening.
  expect((await grant(member)).status).toBe(201);
  expect((await reduce(headers)).status).toBe(200);
  expect(await state(subject)).toEqual({
    floor: before.floor + 1n,
    receipts: before.receipts + 1,
    scopes: sessionScope,
  });
});

test('the reduction is refused once the acting human stopped being a member of the operator', async () => {
  const manager = await person('manager');
  await membership(manager, 'owner');
  const subject = await automated();
  const { headers } = await open(manager, subject);
  const before = await state(subject);

  await membership(manager, null);
  expect((await reduce(headers)).status).toBeGreaterThanOrEqual(400);
  expect(await state(subject)).toEqual(before);
});

test("the reduction is refused once the acting human's own floor advanced after the opening", async () => {
  const manager = await person('floor');
  await membership(manager, 'owner');
  const subject = await automated();
  const { headers } = await open(manager, subject);
  const before = await state(subject);
  const human = await state(manager.accountId);

  // The human reduces their own consent through the same barrier.
  const own = await reduce(manager.headers);
  expect(own.status).toBe(200);
  expect((await state(manager.accountId)).floor).toBe(human.floor + 1n);
  expect((await reduce(headers)).status).toBeGreaterThanOrEqual(400);
  expect(await state(subject)).toEqual(before);
});

test("the reduction is refused once the acting human's consent no longer covers the managing scope", async () => {
  const manager = await person('scope');
  await membership(manager, 'owner');
  const subject = await automated();
  const { headers } = await open(manager, subject);
  const before = await state(subject);

  // The opening recorded the client's scopes; the human's consent for the client now excludes account:manage.
  expect((await reduce(manager.headers, ['read'])).status).toBe(200);
  expect((await reduce(headers)).status).toBeGreaterThanOrEqual(400);
  expect(await state(subject)).toEqual(before);
});

const operator = (set: string) =>
  pool.query(`UPDATE access.account SET ${set} WHERE route=$1 AND account_id=$2`, [
    routeOf(organizationId),
    organizationId,
  ]);
const denial = (insert: boolean) =>
  insert
    ? pool.query(
        `INSERT INTO access.resource_denial (route,resource_id,subject_id,subject_role,action,reason,valid,transaction_id)
         VALUES ($1,$2,$3,'','account:manage','resource','(,)',$2)`,
        [routeOf(organizationId), organizationId, owner.accountId],
      )
    : pool.query('DELETE FROM access.resource_denial WHERE route=$1 AND resource_id=$2', [
        routeOf(organizationId),
        organizationId,
      ]);

// Operands the barrier no longer reads itself: each comes from the shared evaluator or the operator's own state.
for (const [name, apply, undo] of [
  ['a denial of account:manage on the operator', () => denial(true), () => denial(false)],
  ['a gated operator', () => operator('authn_fenced=true'), () => operator('authn_fenced=false')],
  ['a suspended operator', () => suspendAccount(pool, organizationId), () => reinstateAccount(pool, organizationId)],
] as const)
  test(`${name} refuses the reduction with nothing advanced, and lifting it restores the reduction`, async () => {
    const subject = await automated();
    const { headers } = await open(owner, subject);
    const before = await state(subject);

    await apply();
    try {
      expect((await reduce(headers)).status).toBeGreaterThanOrEqual(400);
      expect(await state(subject)).toEqual(before);
    } finally {
      await undo();
    }
    expect((await reduce(headers)).status).toBe(200);
    expect(await state(subject)).toEqual({
      floor: before.floor + 1n,
      receipts: before.receipts + 1,
      scopes: sessionScope,
    });
  });

test('no SQL on the barrier path reads resource grants, denials, memberships or roles itself', async () => {
  const directory = new URL('../../src/access/', import.meta.url);
  for (const name of [
    'auth-barriers-opening-read.sql',
    'auth-barriers-advance.sql',
    'auth-barriers-credential-read.sql',
    'auth-barriers-credential-advance.sql',
  ]) {
    const text = (await Bun.file(new URL(name, directory)).text()).replace(/^--.*$/gm, '');
    expect(text).not.toMatch(/resource_grant|resource_denial|resource_role|organization_member|account:manage/);
  }
  // The decision comes from the opening's own evidence and final check, never a copy of them.
  const lifecycle = await Bun.file(new URL('lifecycle.ts', directory)).text();
  expect(lifecycle).not.toMatch(/organization_member|resource_grant|resource_denial/);
  expect(openingManagement(f.access)).toBeDefined();
});

test('Access accepts only the opening that created the reducing session', async () => {
  const subject = await automated();
  const { receiptId } = await open(owner, subject);
  const { floor, receipts } = await state(subject);
  const other = await automated();
  const foreign = await open(owner, other);
  const unconsumed = (await approve(owner, subject)).receiptId;
  const own = (await readAccount(pool, routeOf(owner.accountId)!, owner.accountId))!;

  // Without the opening, with another subject's opening, with an opening never consumed.
  for (const openingReceiptId of [undefined, foreign.receiptId, unconsumed, newId(routeOf(organizationId)!)])
    await expect(
      advance({ accountId: subject, purpose: 'consent-reduction', floor, openingReceiptId }),
    ).rejects.toThrow();
  // A person's own floor never takes an opening, and an automated account's floor never takes a stale one.
  await expect(
    advance({
      accountId: owner.accountId,
      purpose: 'consent-reduction',
      floor: own.minimumAuthnEpoch,
      openingReceiptId: receiptId,
    }),
  ).rejects.toThrow();
  await expect(
    advance({ accountId: subject, purpose: 'consent-reduction', floor: floor + 1n, openingReceiptId: receiptId }),
  ).rejects.toThrow();
  expect(await state(subject)).toMatchObject({ floor, receipts });

  // The real opening advances the floor exactly once.
  const advanced = await advance({
    accountId: subject,
    purpose: 'consent-reduction',
    floor,
    openingReceiptId: receiptId,
  });
  expect(advanced.replayed).toBe(false);
  expect(await state(subject)).toMatchObject({ floor: floor + 1n, receipts: receipts + 1 });
});

test('recovery barriers still never apply to automated accounts', async () => {
  const subject = await automated();
  const { receiptId } = await open(owner, subject);
  let { floor, receipts } = await state(subject);
  for (const openingReceiptId of [undefined, receiptId])
    await expect(advance({ accountId: subject, purpose: 'recovery', floor, openingReceiptId })).rejects.toThrow();
  expect(await state(subject)).toMatchObject({ floor, receipts });
  // Even a raised fence does not admit one.
  await f.bindings.internalLifecycle.raiseFence({ accountId: subject, key: key() });
  ({ floor, receipts } = await state(subject));
  for (const openingReceiptId of [undefined, receiptId])
    await expect(advance({ accountId: subject, purpose: 'recovery', floor, openingReceiptId })).rejects.toThrow();
  expect(await state(subject)).toMatchObject({ floor, receipts });
});
