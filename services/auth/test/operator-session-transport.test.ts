import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { Pool } from 'pg';
import { managementOperationProfile, type SessionProof } from '@rezics/auth-contract';
import { testDatabase } from '../scripts/database.ts';
import { migrate as migrateKernel } from '../../kernel/scripts/database.ts';
import { routeOf } from '../../kernel/src/route/route.ts';
import { operatorSessionTransport } from '../src/operator-session-transport.ts';

// Reuse the real native Auth/Access composition; no replacement opening/session
// writer, approval engine, permission fixture or token signer.
let database: ReturnType<typeof testDatabase>;
let pool: Pool;
let fixture: typeof import('../../kernel/test/access/native-account-bindings-fixture.ts');
let f: Awaited<ReturnType<typeof fixture.nativeFixture>>;
let human: Awaited<ReturnType<typeof f.person>>;
let foreign: typeof human;
let subject: { accountId: string };
let otherSubject: { accountId: string };
let humanCookie: string;
let foreignCookie: string;
const profile = managementOperationProfile('opening');
const key = 'native-opening-transport';
function send(path: string, body: unknown, cookie = humanCookie, extra: Record<string, string> = {}) {
  return f.host.handler(
    new Request(`${fixture.issuer}${path}`, {
      method: 'POST',
      headers: { origin: fixture.issuer, 'content-type': 'application/json', cookie, ...extra },
      body: JSON.stringify(body),
    }),
  );
}
function operation() {
  return { kind: 'opening' as const, operatorAccountId: human.accountId, subjectAccountId: subject.accountId };
}
function input() {
  return { accountId: human.accountId, operationKey: key, operation: operation() };
}
async function signin(name: string) {
  const response = await f.request('/signin', {
    email: `${name}@ordinary.test`,
    password: fixture.password,
    ...profile,
  });
  expect(response.status).toBe(200);
  return fixture.cookies(response).get('cookie')!;
}
async function sessions() {
  return (await f.authPool.query('SELECT count(*)::int AS count FROM session WHERE "userId"=$1', [subject.accountId]))
    .rows[0].count;
}
beforeAll(async () => {
  database = testDatabase();
  migrateKernel(database.url);
  pool = new Pool({ connectionString: database.url });
  process.env.DATABASE_URL = database.url;
  await import(createRequire(new URL('../../kernel/package.json', import.meta.url)).resolve('reylo/register'));
  fixture = await import('../../kernel/test/access/native-account-bindings-fixture.ts');
  f = await fixture.nativeFixture(pool);
  human = await f.person('opening-human');
  foreign = await f.person('opening-foreign');
  subject = await f.automated('opening-subject', human);
  otherSubject = await f.automated('opening-other-subject', human);
  humanCookie = await signin('opening-human');
  foreignCookie = await signin('opening-foreign');
}, 180000);
afterAll(async () => {
  try {
    await f?.close();
  } finally {
    await pool?.end();
    database?.close();
  }
}, 60000);

test('Actual operator opening issues only the native bound automated session after same-human explicit approval and native current operator authority, never automatic second issuance or copied operator grants', async () => {
  expect(await sessions()).toBe(0);
  const approval = await send('/account-operations/approve', input());
  expect(approval.status).toBe(200);
  const { reference } = (await approval.json()) as { reference: string };
  const body = { ...input(), reference };
  expect(await sessions()).toBe(0);
  // Foreign human, body identity, operator, subject, reference and key all
  // remain native refusals; the browser cannot manufacture authorization.
  const substitutions = [
    { ...body, accountId: foreign.accountId },
    { ...body, operationKey: `${key}-foreign` },
    { ...body, reference: 'invented-reference' },
    { ...body, operation: { ...operation(), operatorAccountId: foreign.accountId } },
    { ...body, operation: { ...operation(), subjectAccountId: otherSubject.accountId } },
    { ...body, operation: { ...operation(), subjectAccountId: human.accountId } },
  ];
  for (const changed of substitutions)
    expect([400, 401, 403, 409]).toContain((await send('/operator-sessions/open', changed)).status);
  expect((await send('/operator-sessions/open', body, foreignCookie)).status).toBe(403);
  expect((await send('/account-operations/execute', body)).status).toBe(400);
  expect(await sessions()).toBe(0);
  const grants = (await pool.query('SELECT count(*)::int AS count FROM access.resource_grant')).rows;
  const opened = await send('/operator-sessions/open', body);
  expect(opened.status).toBe(200);
  expect(opened.headers.get('cache-control')).toBe('no-store');
  expect(opened.headers.getSetCookie().length).toBeGreaterThan(0);
  const proof = (await opened.json()) as SessionProof;
  expect(Object.keys(proof).sort()).toEqual(['account_id', 'amr', 'auth_time', 'authn_epoch', 'client_id', 'scope']);
  expect(proof).toMatchObject({
    account_id: subject.accountId,
    client_id: profile.client_id,
    scope: profile.scope,
    amr: ['operator'],
  });
  expect(proof.scope).not.toContain('access:grant');
  expect((await pool.query('SELECT count(*)::int AS count FROM access.resource_grant')).rows).toEqual(grants);
  expect(await sessions()).toBe(1);
  const cookie = fixture.cookies(opened);
  expect(await (await f.request('/session', undefined, cookie)).json()).toEqual(proof);
  // A lost response does not make the consumed opening reusable, even while the
  // original human cookie still exists. No second native session is issued.
  expect([403, 409]).toContain((await send('/operator-sessions/open', body)).status);
  expect(await sessions()).toBe(1);
  expect((await send('/operator-sessions/open', body, cookie.get('cookie')!)).status).toBe(403);
  expect(await sessions()).toBe(1);
}, 180000);

test('opening transport refuses bearer, expanded descriptor/body, wrong profile, stale human, Origin, JSON and oversized requests before issuance', async () => {
  const before = await sessions();
  const body = { ...input(), reference: 'not-authority' };
  for (const changed of [
    { ...body, actor: {} },
    { ...body, scope: ['access:grant'] },
    { ...body, operation: { ...operation(), authorization: 'invented' } },
    { ...body, operation: { ...operation(), kind: 'organization' } },
  ])
    expect((await send('/operator-sessions/open', changed)).status).toBe(400);
  for (const extra of [
    { authorization: `Bearer ${human.bearer}` },
    { origin: 'https://foreign.test' },
    { 'content-type': 'text/plain' },
    { 'sec-fetch-site': 'cross-site' },
  ])
    expect((await send('/operator-sessions/open', body, humanCookie, extra)).status).toBe(400);
  expect((await send('/operator-sessions/open', { ...body, reference: 'x'.repeat(17000) })).status).toBe(413);
  expect((await send('/operator-sessions/open', body, human.headers.get('cookie')!)).status).toBe(403);
  const malformed = await f.host.handler(
    new Request(`${fixture.issuer}/operator-sessions/open`, {
      method: 'POST',
      headers: { origin: fixture.issuer, 'content-type': 'application/json', cookie: humanCookie },
      body: '{',
    }),
  );
  expect(malformed.status).toBe(400);
  await f.authPool.query('UPDATE session SET "authTime"=$2 WHERE "userId"=$1 AND "authMethods"=$3', [
    human.accountId,
    Math.floor(Date.now() / 1000) - 601,
    'pwd',
  ]);
  const stale = await send('/account-operations/approve', { ...input(), operationKey: 'opening-stale' });
  expect(stale.status).toBe(401);
  expect(((await stale.json()) as { error: string }).error).toBe('step_up_required');
  expect((await send('/operator-sessions/open', body)).status).toBe(401);
  expect(await sessions()).toBe(before);
}, 60000);

test('a current native grant, floor or consent revocation after opening approval stops issuance', async () => {
  for (const change of ['grant', 'floor', 'consent'] as const) {
    const name = `opening-revoked-${change}`;
    const owner = await f.person(name);
    const actor = await f.automated(`${name}-actor`, owner);
    const cookie = await signin(name);
    const consentClient = `${name}-external`;
    if (change === 'consent') {
      await f.host.service.internal.registerClient({
        clientId: consentClient,
        firstParty: false,
        scopes: ['account:manage'],
      });
      expect(
        (await f.request('/consent', { client_id: consentClient, scope: ['account:manage'] }, owner.headers)).status,
      ).toBe(200);
    }
    const operation = { kind: 'opening', operatorAccountId: owner.accountId, subjectAccountId: actor.accountId };
    const input = { accountId: owner.accountId, operationKey: name, operation };
    const approved = await send('/account-operations/approve', input, cookie);
    expect(approved.status).toBe(200);
    const { reference } = (await approved.json()) as { reference: string };
    if (change === 'grant') {
      const context = { pool, deadline: Date.now() + 10000 };
      const actor = await f.access.authenticate(owner.bearer, context);
      await f.bindings.grants.revoke(
        { ...context, actor },
        {
          resource: { route: routeOf(owner.accountId)!, id: owner.accountId },
          subject: { kind: 'account', id: owner.accountId },
          actions: ['account:manage'],
          valid: '(,)',
          key: `${name}-revoke`,
        },
      );
    } else if (change === 'floor')
      await f.bindings.internalLifecycle.raiseFence({ accountId: owner.accountId, key: `${name}-fence` });
    else {
      // A genuine third-party consent reduction raises the same human floor.
      // The first-party management registration itself has no consent editor.
      const response = await f.request('/consent', { client_id: consentClient, scope: [] }, owner.headers);
      expect(response.status).toBe(200);
    }
    expect([401, 403, 409]).toContain((await send('/operator-sessions/open', { ...input, reference }, cookie)).status);
    expect((await f.authPool.query('SELECT id FROM session WHERE "userId"=$1', [actor.accountId])).rowCount).toBe(0);
  }
}, 180000);

test('the dedicated opening route without a real host Access source fails closed with 503', async () => {
  const handler = operatorSessionTransport(
    f.host.service,
    f.host.workflows,
    async () => {
      throw new Error('Opening must not fall through');
    },
    undefined,
  );
  const response = await handler(new Request(`${fixture.issuer}/operator-sessions/open`, { method: 'POST' }));
  expect(response.status).toBe(503);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.has('set-cookie')).toBe(false);
});
