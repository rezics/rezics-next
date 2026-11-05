import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { exportJWK, generateKeyPair } from 'jose';
import { Pool } from 'pg';
import { migrate, POSTGRES_IMAGE, run } from '../scripts/database.ts';
import { migrate as migrateKernel } from '../../kernel/scripts/database.ts';

const client = 'opening-ext';
const sessionScope = ['account:manage', 'read'];
const consented = ['account:manage', 'read', 'write'];

/** Each fixture owns exactly the container it starts. */
function ownDatabase() {
  const container = run('docker', [
    'run',
    '-d',
    '--rm',
    '-p',
    '127.0.0.1::5432',
    '--tmpfs',
    '/var/lib/postgresql:rw,size=2g',
    '-e',
    'POSTGRES_USER=rezics',
    '-e',
    'POSTGRES_PASSWORD=rezics',
    '-e',
    'POSTGRES_DB=rezics',
    POSTGRES_IMAGE,
    '-c',
    'fsync=off',
    '-c',
    'synchronous_commit=off',
  ]);
  try {
    const port = run('docker', ['port', container, '5432/tcp']).match(/127\.0\.0\.1:(\d+)/)![1];
    const url = `postgres://rezics:rezics@127.0.0.1:${port}/rezics?sslmode=disable`;
    migrateKernel(url);
    migrate(url);
    return { url, close: () => run('docker', ['rm', '-f', container]) };
  } catch (error) {
    run('docker', ['rm', '-f', container]);
    throw error;
  }
}

type Kernel = {
  nativeFixture: typeof import('../../kernel/test/access/native-account-bindings-fixture.ts').nativeFixture;
  cookies: typeof import('../../kernel/test/access/native-account-bindings-fixture.ts').cookies;
  password: string;
  createPool: typeof import('../../kernel/src/database/pool.ts').createPool;
  createKernel: typeof import('../../kernel/src/http/kernel.ts').createKernel;
  readAccount: typeof import('../../kernel/src/access/account-data.ts').readAccount;
  newId: typeof import('../../kernel/src/route/route.ts').newId;
  routeOf: typeof import('../../kernel/src/route/route.ts').routeOf;
};
type Person = { accountId: string; email: string; bearer: string; headers: Headers };

let database: ReturnType<typeof ownDatabase>;
let k: Kernel;
let pool: Pool;
let f: Awaited<ReturnType<Kernel['nativeFixture']>>;
let kernel: ReturnType<Kernel['createKernel']>;
let owner: Person;
let admin: { bearer: string; headers: Headers };
let organizationId: string;
let sequence = 0;
const key = () => Bun.randomUUIDv7();

async function seed(accountId: string, scopes = consented) {
  await f.authPool.query(
    `INSERT INTO auth_consent (account_id,client_id,scopes) VALUES ($1,$2,$3)
     ON CONFLICT (account_id,client_id) DO UPDATE SET scopes=EXCLUDED.scopes,pending_scopes=NULL,pending_reference=NULL`,
    [accountId, client, scopes],
  );
}
async function signIn(email: string, scope = sessionScope) {
  const signed = await f.request('/signin', { email, password: k.password, client_id: client, scope });
  expect(signed.status).toBe(200);
  const headers = k.cookies(signed);
  const token = await f.request('/token', {}, headers);
  expect(token.status).toBe(200);
  return { headers, bearer: ((await token.json()) as { access_token: string }).access_token };
}
// A person whose own consent to the third-party client is stored; the automated account never has one.
async function person(name: string): Promise<Person> {
  const registered = await f.person(`opening_${name}_${++sequence}`);
  await seed(registered.accountId);
  const email = `opening_${name}_${sequence}@ordinary.test`;
  return { accountId: registered.accountId, email, ...(await signIn(email)) };
}
async function context(human: { bearer: string }) {
  const deadline = Date.now() + 10000;
  const actor = await f.access.authenticate(human.bearer, { pool, deadline });
  return { actor, account: await k.readAccount(pool, k.routeOf(actor.accountId)!, actor.accountId), deadline };
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
function grant(human: Person, path = '/v1/grants') {
  return kernel.handle(
    new Request(`https://kernel.test${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${admin.bearer}`,
        'content-type': 'application/json',
        'idempotency-key': JSON.stringify(key()),
      },
      body: JSON.stringify({
        resource: { route: k.routeOf(organizationId)!, id: organizationId },
        subject: { kind: 'account', id: human.accountId },
        actions: ['account:manage'],
        valid: '(,)',
      }),
    }),
  );
}
async function automated() {
  const subject = await f.automated(`opening_agent_${++sequence}`, { accountId: organizationId, bearer: admin.bearer });
  return subject.accountId;
}
// The human's session approves one opening for exactly its own client and scopes.
async function approve(human: Person, subjectAccountId: string) {
  const approved = await f.bindings.workflowPorts.authorizeOpening!(await context(human), {
    operatorAccountId: organizationId,
    subjectAccountId,
    purpose: 'session',
    key: key(),
  });
  return approved.value.receiptId;
}
async function attempt(authorization: string, subjectAccountId: string, headers: Headers) {
  try {
    return await f.host.service.internal.openAutomatedSession({ authorization, subjectAccountId, headers });
  } catch {
    return undefined;
  }
}
async function open(human: Person, subjectAccountId: string) {
  const response = await attempt(await approve(human, subjectAccountId), subjectAccountId, human.headers);
  expect(response?.status).toBe(200);
  return k.cookies(response!);
}
async function consentOf(accountId: string, clientId = client) {
  return (
    await f.authPool.query('SELECT scopes,pending_scopes FROM auth_consent WHERE account_id=$1 AND client_id=$2', [
      accountId,
      clientId,
    ])
  ).rows[0];
}
async function sessions(accountId: string) {
  return Number((await f.authPool.query('SELECT count(*) FROM session WHERE "userId"=$1', [accountId])).rows[0].count);
}
const reduce = (headers: Headers, scope: string[], clientId = client) =>
  f.request('/consent', { client_id: clientId, scope }, headers);
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
// A refused consumption leaves the automated account with neither a session nor a consent.
async function untouched(subject: string) {
  expect(await sessions(subject)).toBe(0);
  expect(await consentOf(subject)).toBeUndefined();
}

beforeAll(async () => {
  database = ownDatabase();
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = database.url;
  try {
    await import(createRequire(new URL('../../kernel/package.json', import.meta.url)).resolve('reylo/register'));
    const fixture = await import('../../kernel/test/access/native-account-bindings-fixture.ts');
    k = {
      nativeFixture: fixture.nativeFixture,
      cookies: fixture.cookies,
      password: fixture.password,
      ...(await import('../../kernel/src/database/pool.ts')),
      ...(await import('../../kernel/src/http/kernel.ts')),
      ...(await import('../../kernel/src/access/account-data.ts')),
      ...(await import('../../kernel/src/route/route.ts')),
    };
  } finally {
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
  }
  pool = k.createPool(database.url);
  const pair = await generateKeyPair('ES256', { extractable: true });
  f = await k.nativeFixture(pool, undefined, {
    database: { url: database.url, container: '', close() {} },
    privateKey: { ...(await exportJWK(pair.privateKey)), kid: 'opening-consent' },
  });
  const management = ['subject:create', 'subject:batch_write', 'source_fence:read', 'media:import_from_url'];
  await f.host.service.internal.registerClient({
    clientId: 'opening-management',
    firstParty: true,
    scopes: [...management, 'account:manage', 'access:grant', 'organization:membership'],
  });
  await f.host.service.internal.registerClient({ clientId: client, firstParty: false, scopes: consented });
  await f.host.service.internal.registerClient({ clientId: 'opening-other', firstParty: false, scopes: ['read'] });
  kernel = k.createKernel({
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
  const registered = await f.person('opening_admin');
  const signed = await f.request('/signin', {
    email: 'opening_admin@ordinary.test',
    password: k.password,
    client_id: 'opening-management',
    scope: ['account:manage', 'access:grant', 'organization:membership'],
  });
  expect(signed.status).toBe(200);
  admin = {
    headers: k.cookies(signed),
    bearer: ((await (await f.request('/token', {}, k.cookies(signed))).json()) as { access_token: string })
      .access_token,
  };
  organizationId = k.newId(0x9200);
  const held = await f.bindings.internalLifecycle.reserveCoordination({
    accountId: registered.accountId,
    relatedAccountId: organizationId,
    purpose: 'membership',
    key: key(),
  });
  await f.bindings.internalLifecycle.createOrganization({
    organizationId,
    ownerAccountId: registered.accountId,
    ownerReservationId: held.value.reservationId,
    key: key(),
  });
  await membership(owner, 'owner');
}, 180000);
afterAll(async () => {
  try {
    await f?.close();
  } finally {
    await pool?.end();
    database?.close();
  }
}, 60000);

test('consuming an approved operator opening for a third-party client issues the automated account session and records its consent for exactly the approved scopes', async () => {
  const subject = await automated();
  await untouched(subject);

  const headers = await open(owner, subject);
  expect(await consentOf(subject)).toEqual({ scopes: sessionScope, pending_scopes: null });
  expect(await sessions(subject)).toBe(1);
  const response = await f.request('/session', undefined, headers);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    account_id: subject,
    client_id: client,
    scope: sessionScope,
    amr: ['operator'],
  });
  expect(await accepted(await issued(headers))).toBe(true);
});

test('a request for scopes beyond the approval is refused', async () => {
  const subject = await automated();
  const approval = await approve(owner, subject);
  // The same person, on a session wider than the one that approved the opening.
  const wider = await signIn(owner.email, consented);
  expect((await attempt(approval, subject, wider.headers))?.ok ?? false).toBe(false);
  await untouched(subject);

  // A scope the client does not register cannot be approved at all.
  const unregistered = await f.request('/signin', {
    email: owner.email,
    password: k.password,
    client_id: client,
    scope: [...sessionScope, 'admin'],
  });
  expect(unregistered.status).toBeGreaterThanOrEqual(400);
  await untouched(subject);

  // The narrow session still consumes the approval, and only for the approved scopes.
  const response = await attempt(approval, subject, owner.headers);
  expect(response?.status).toBe(200);
  expect(await consentOf(subject)).toEqual({ scopes: sessionScope, pending_scopes: null });
});

test('the consent endpoint still refuses to grant or widen an automated account consent', async () => {
  const subject = await automated();
  const headers = await open(owner, subject);
  const before = await consentOf(subject);
  expect(before).toEqual({ scopes: sessionScope, pending_scopes: null });
  for (const [scope, clientId] of [
    [consented, client],
    [['account:manage', 'write'], client],
    [['read'], 'opening-other'],
    [[], 'opening-other'],
  ] as const)
    expect((await reduce(headers, [...scope], clientId)).status).toBeGreaterThanOrEqual(400);
  expect(await consentOf(subject)).toEqual(before);
  expect(await consentOf(subject, 'opening-other')).toBeUndefined();
});

test('a later approved opening may grant again', async () => {
  const subject = await automated();
  const first = await open(owner, subject);
  expect((await reduce(first, ['account:manage'])).status).toBe(200);
  expect(await consentOf(subject)).toEqual({ scopes: ['account:manage'], pending_scopes: null });
  expect(await sessions(subject)).toBe(0);

  const second = await open(owner, subject);
  expect(await consentOf(subject)).toEqual({ scopes: sessionScope, pending_scopes: null });
  expect(await accepted(await issued(second))).toBe(true);
  // An opening never narrows what an earlier one granted; only the barrier reduces.
  const narrow = { ...owner, ...(await signIn(owner.email, ['account:manage'])) };
  expect((await attempt(await approve(narrow, subject), subject, narrow.headers))?.status).toBe(200);
  expect(await consentOf(subject)).toEqual({ scopes: sessionScope, pending_scopes: null });
});

test("revoking the acting human's grant before consumption refuses the opening", async () => {
  const member = await person('member');
  await membership(member, 'member');
  const subject = await automated();
  expect((await grant(member)).status).toBe(201);
  const approval = await approve(member, subject);

  expect((await grant(member, '/v1/grants:revoke')).status).toBe(200);
  expect((await attempt(approval, subject, member.headers))?.ok ?? false).toBe(false);
  await untouched(subject);
});

test("revoking the acting human's client consent before consumption refuses the opening", async () => {
  const manager = await person('consent');
  await membership(manager, 'owner');
  const subject = await automated();
  const approval = await approve(manager, subject);

  expect((await reduce(manager.headers, [])).status).toBe(200);
  expect((await attempt(approval, subject, manager.headers))?.ok ?? false).toBe(false);
  await untouched(subject);
});

test('removing the operator relation before consumption refuses the opening', async () => {
  const manager = await person('relation');
  await membership(manager, 'owner');
  const subject = await automated();
  const approval = await approve(manager, subject);

  await membership(manager, null);
  expect((await attempt(approval, subject, manager.headers))?.ok ?? false).toBe(false);
  await untouched(subject);
});

test('a later approved opening restores its bound consent while tokens below the advanced floor remain invalid', async () => {
  const subject = await automated();
  const first = await open(owner, subject);
  const oldToken = await issued(first);
  expect(await accepted(oldToken)).toBe(true);

  expect((await reduce(first, ['account:manage'])).status).toBe(200);
  expect(await consentOf(subject)).toEqual({ scopes: ['account:manage'], pending_scopes: null });
  expect(await sessions(subject)).toBe(0);
  expect(await accepted(oldToken)).toBe(false);

  const authorization = await approve(owner, subject);
  const response = await attempt(authorization, subject, owner.headers);
  expect(response?.status).toBe(200);
  expect(await consentOf(subject)).toEqual({ scopes: sessionScope, pending_scopes: null });
  expect(await accepted(await issued(k.cookies(response!)))).toBe(true);
  expect(await accepted(oldToken)).toBe(false);
});
