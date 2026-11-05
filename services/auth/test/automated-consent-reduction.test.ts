import { trustedAccessPorts } from './support/trusted-access.ts';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { Pool } from 'pg';
import { createLocalJWKSet, decodeJwt, exportJWK, generateKeyPair, jwtVerify } from 'jose';
import { testDatabase } from '../scripts/database.ts';
import {
  createAuthService,
  type AccessAccount,
  type AuthService,
  type AuthServiceOptions,
  type EffectAuthorization,
  type SessionProof,
} from '../src/index.ts';

const issuer = 'https://automated-consent.auth.test';
const audience = 'https://automated-consent.api.test';
const password = 'correct horse battery staple';
const accounts = new Map<string, AccessAccount>();
const receipts = new Map<string, EffectAuthorization>();
const invalidations: Parameters<NonNullable<AuthServiceOptions['trustedAccess']['invalidateAccount']>>[0][] = [];
let pool: Pool;
let service: AuthService;
let options: AuthServiceOptions;
let fixture: ReturnType<typeof testDatabase> | undefined;
let sequence = 0;

function actor(id: string, automated = false) {
  const account: AccessAccount = { accountId: id, kind: 'actor', state: 'active', automated, authnEpoch: 1 };
  accounts.set(id, account);
  return account;
}
function request(path: string, body?: unknown, cookie = '', target = service) {
  return target.handler(
    new Request(`${issuer}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { origin: issuer, 'content-type': 'application/json', cookie },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}
function cookie(response: Response) {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
}
async function login(id: string, clientId: string, scope: string[]) {
  const response = await request('/signin', { email: `${id}@example.test`, password, client_id: clientId, scope });
  expect(response.status).toBe(200);
  return cookie(response);
}
async function provision(id: string, automated = false) {
  const account = actor(id, automated);
  account.state = 'pending';
  await service.internal.provisionPassword({ authorization: id, email: `${id}@example.test`, password });
  account.state = 'active';
}
async function proof(cookieValue: string): Promise<SessionProof> {
  const response = await request('/session', undefined, cookieValue);
  expect(response.status).toBe(200);
  return response.json() as Promise<SessionProof>;
}
// The operator's human session approves one opening for the automated subject.
async function operatorSession(subject: string, human: string, clientId: string, scope: string[]) {
  const headers = new Headers({ cookie: await login(human, clientId, scope) });
  const opener = await proof(headers.get('cookie')!);
  const receiptId = `opening-${++sequence}`;
  receipts.set(receiptId, {
    receiptId,
    subjectAccountId: subject,
    purpose: 'session',
    actingHumanId: opener.account_id,
    operatorAccountId: human,
    clientId: opener.client_id,
    scopes: opener.scope,
    humanEpoch: opener.authn_epoch,
    subjectEpoch: accounts.get(subject)!.authnEpoch,
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  });
  const response = await service.internal.openAutomatedSession({
    subjectAccountId: subject,
    authorization: receiptId,
    headers,
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ account_id: subject, amr: ['operator'] });
  return cookie(response);
}
async function issued(cookieValue: string) {
  const response = await request('/token', {}, cookieValue);
  expect(response.status).toBe(200);
  return ((await response.json()) as { access_token: string }).access_token;
}
// Models the cached-JWKS and floor verifier boundary of the kernel.
async function accepted(token: string) {
  const jwks = await (await request('/.well-known/jwks.json')).json();
  const { payload } = await jwtVerify(token, createLocalJWKSet(jwks), { issuer, audience, algorithms: ['ES256'] });
  return Number(payload.authn_epoch) >= accounts.get(payload.sub!)!.authnEpoch;
}
async function consentOf(account: string, client = 'automated-ext') {
  return (
    await pool.query('SELECT scopes,pending_scopes FROM auth_consent WHERE account_id=$1 AND client_id=$2', [
      account,
      client,
    ])
  ).rows[0];
}
async function seed(account: string, scopes: string[], client = 'automated-ext') {
  await pool.query(
    `INSERT INTO auth_consent (account_id,client_id,scopes) VALUES ($1,$2,$3)
     ON CONFLICT (account_id,client_id) DO UPDATE SET scopes=EXCLUDED.scopes,pending_scopes=NULL,pending_reference=NULL`,
    [account, client, scopes],
  );
}
async function receiptCount(account: string) {
  return Number(
    (
      await pool.query(`SELECT count(*) FROM auth_effect_receipt WHERE account_id=$1 AND purpose='consent-reduction'`, [
        account,
      ])
    ).rows[0].count,
  );
}
function reduce(cookieValue: string, scope: string[], client = 'automated-ext', target = service) {
  return request('/consent', { client_id: client, scope }, cookieValue, target);
}

beforeAll(async () => {
  fixture = testDatabase();
  pool = new Pool({ connectionString: fixture.url });
  const key = await generateKeyPair('ES256', { extractable: true });
  const signingKey = { ...(await exportJWK(key.privateKey)), kid: 'automated-consent-signer', alg: 'ES256' };
  options = {
    database: pool,
    issuer,
    audience,
    secret: 'automated-consent-better-auth-secret-with-32-bytes',
    signing: { activeKid: signingKey.kid, privateKeys: [signingKey] },
    trustedAccess: trustedAccessPorts({
      async readFencedAccount(id) {
        return this.readAccount(id);
      },
      async readAccount(id) {
        const account = accounts.get(id);
        return account ? { ...account } : null;
      },
      async authorizeProvisioning(id) {
        return { accountId: id };
      },
      async consumeAuthorization(input) {
        const receipt = receipts.get(input.authorization);
        receipts.delete(input.authorization);
        const subject = accounts.get(input.subjectAccountId);
        if (
          !receipt ||
          !subject?.automated ||
          receipt.subjectAccountId !== input.subjectAccountId ||
          receipt.actingHumanId !== input.human.account_id ||
          receipt.clientId !== input.human.client_id ||
          receipt.humanEpoch !== input.human.authn_epoch ||
          receipt.subjectEpoch !== subject.authnEpoch ||
          JSON.stringify(receipt.scopes) !== JSON.stringify(input.human.scope)
        )
          throw new Error('Access denied');
        return receipt;
      },
      async invalidateAccount(input) {
        invalidations.push(input);
        const subject = accounts.get(input.accountId)!;
        subject.authnEpoch++;
        return {
          receiptId: `floor-${++sequence}`,
          accountId: subject.accountId,
          minimumAuthnEpoch: subject.authnEpoch,
        };
      },
    }),
  };
  service = await createAuthService(options);
  await service.internal.registerClient({ clientId: 'automated-web', firstParty: true, scopes: ['read', 'write'] });
  await service.internal.registerClient({
    clientId: 'automated-ext',
    firstParty: false,
    scopes: ['read', 'write', 'admin'],
  });
  await service.internal.registerClient({ clientId: 'automated-other', firstParty: false, scopes: ['read'] });
  await provision('operator-human');
  await provision('other-human');
  actor('agent', true);
  // The operator's own consent covers every scope a session it opens may carry.
  const web = await login('operator-human', 'automated-web', ['read']);
  expect((await reduce(web, ['read', 'write'])).status).toBe(200);
}, 30000);
afterAll(async () => {
  await pool?.end();
  fixture?.close();
}, 30000);

test('an operator-opened session reduces the automated account consent through the Access-first barrier', async () => {
  await seed('agent', ['read', 'write']);
  const session = await operatorSession('agent', 'operator-human', 'automated-ext', ['read', 'write']);
  const earlier = await issued(session);
  expect(decodeJwt(earlier)).toMatchObject({ sub: 'agent', scope: 'read write', amr: ['operator'] });
  expect(await accepted(earlier)).toBe(true);
  const floor = accounts.get('agent')!.authnEpoch;
  const receipts = await receiptCount('agent');
  const opening = (
    await pool.query(
      'SELECT receipt_id FROM auth_session_opening WHERE subject_account_id=$1 ORDER BY opened_at DESC',
      ['agent'],
    )
  ).rows[0].receipt_id;
  const sent = invalidations.length;

  const response = await reduce(session, ['read']);
  expect(response.status).toBe(200);
  // Access receives exactly the opening Auth committed for the reducing session.
  expect(invalidations.slice(sent)).toEqual([
    expect.objectContaining({ accountId: 'agent', openingReceiptId: opening }),
  ]);
  expect(await response.json()).toEqual({ client_id: 'automated-ext', scope: ['read'] });
  expect(accounts.get('agent')!.authnEpoch).toBe(floor + 1);
  expect(await receiptCount('agent')).toBe(receipts + 1);
  expect(await consentOf('agent')).toEqual({ scopes: ['read'], pending_scopes: null });
  expect((await pool.query('SELECT id FROM session WHERE "userId"=$1', ['agent'])).rows).toEqual([]);

  // The token the account obtained earlier stops at the advanced floor.
  expect(await accepted(earlier)).toBe(false);
  expect((await request('/token', {}, session)).status).toBeGreaterThanOrEqual(400);

  // A new approved opening may grant the removed scope again; the retained scope still issues.
  const regranted = await issued(await operatorSession('agent', 'operator-human', 'automated-ext', ['read', 'write']));
  expect(decodeJwt(regranted)).toMatchObject({ sub: 'agent', scope: 'read write' });
  expect(await accepted(regranted)).toBe(true);
  expect(await consentOf('agent')).toEqual({ scopes: ['read', 'write'], pending_scopes: null });
  const retained = await operatorSession('agent', 'operator-human', 'automated-ext', ['read']);
  const fresh = await issued(retained);
  expect(decodeJwt(fresh)).toMatchObject({ sub: 'agent', scope: 'read' });
  expect(await accepted(fresh)).toBe(true);

  // Reducing to nothing removes every scope; a later approved opening grants again.
  const empty = await reduce(retained, []);
  expect(empty.status).toBe(200);
  expect(await empty.json()).toEqual({ client_id: 'automated-ext', scope: [] });
  expect(await consentOf('agent')).toEqual({ scopes: [], pending_scopes: null });
  expect(await accepted(fresh)).toBe(false);
  const again = await issued(await operatorSession('agent', 'operator-human', 'automated-ext', ['read']));
  expect(decodeJwt(again)).toMatchObject({ sub: 'agent', scope: 'read' });
  expect(await consentOf('agent')).toEqual({ scopes: ['read'], pending_scopes: null });
});

test('an operator-opened session cannot grant or widen an automated account consent', async () => {
  await seed('agent', ['read', 'write']);
  const session = await operatorSession('agent', 'operator-human', 'automated-ext', ['read', 'write']);
  const floor = accounts.get('agent')!.authnEpoch;
  const before = await receiptCount('agent');
  for (const [scope, client] of [
    [['read', 'write', 'admin'], 'automated-ext'],
    [['read', 'admin'], 'automated-ext'],
    [['read', 'write'], 'automated-ext'],
    [['read'], 'automated-other'],
    [[], 'automated-other'],
    [['read'], 'automated-web'],
  ] as const) {
    expect((await reduce(session, [...scope], client)).status).toBeGreaterThanOrEqual(400);
  }
  expect(await consentOf('agent')).toEqual({ scopes: ['read', 'write'], pending_scopes: null });
  expect(await consentOf('agent', 'automated-other')).toBeUndefined();
  expect(accounts.get('agent')!.authnEpoch).toBe(floor);
  expect(await receiptCount('agent')).toBe(before);
  expect(await accepted(await issued(session))).toBe(true);
});

test('a reduction waits for Access: without the barrier port nothing changes', async () => {
  await seed('agent', ['read', 'write']);
  const session = await operatorSession('agent', 'operator-human', 'automated-ext', ['read', 'write']);
  const floor = accounts.get('agent')!.authnEpoch;
  const closed = await createAuthService({
    ...options,
    trustedAccess: trustedAccessPorts({ ...options.trustedAccess, invalidateAccount: undefined }),
  });
  expect((await reduce(session, ['read'], 'automated-ext', closed)).status).toBeGreaterThanOrEqual(400);
  expect(await consentOf('agent')).toEqual({ scopes: ['read', 'write'], pending_scopes: null });
  expect(accounts.get('agent')!.authnEpoch).toBe(floor);
  expect((await reduce(session, ['read'])).status).toBe(200);
});

test("a person's own reduction behaves as before", async () => {
  const own = await login('operator-human', 'automated-web', ['read']);
  expect((await reduce(own, ['read', 'write'])).status).toBe(200);
  const earlier = await issued(await login('operator-human', 'automated-ext', ['write']));
  const floor = accounts.get('operator-human')!.authnEpoch;
  await seed('agent', ['read', 'write']);
  const sent = invalidations.length;
  const response = await reduce(own, ['read']);
  expect(response.status).toBe(200);
  expect(invalidations.slice(sent)).toHaveLength(1);
  expect(invalidations[sent]).not.toHaveProperty('openingReceiptId');
  expect(await response.json()).toEqual({ client_id: 'automated-ext', scope: ['read'] });
  expect(accounts.get('operator-human')!.authnEpoch).toBe(floor + 1);
  expect(await consentOf('operator-human')).toEqual({ scopes: ['read'], pending_scopes: null });
  expect(await accepted(earlier)).toBe(false);
  expect((await pool.query('SELECT id FROM session WHERE "userId"=$1', ['operator-human'])).rows).toEqual([]);
  // The operator reducing their own consent leaves the automated account's consent alone.
  expect(await consentOf('agent')).toEqual({ scopes: ['read', 'write'], pending_scopes: null });
  // A person still grants and widens their own consent.
  const again = await login('operator-human', 'automated-web', ['read']);
  expect((await reduce(again, ['read', 'write'])).status).toBe(200);
  expect(await consentOf('operator-human')).toEqual({ scopes: ['read', 'write'], pending_scopes: null });
});

test('nobody else can reduce an automated account consent', async () => {
  await seed('agent', ['read', 'write']);
  const floor = accounts.get('agent')!.authnEpoch;
  const unchanged = async () => {
    expect(await consentOf('agent')).toEqual({ scopes: ['read', 'write'], pending_scopes: null });
    expect(accounts.get('agent')!.authnEpoch).toBe(floor);
  };

  // Another person's session reaches only that person's own consent.
  const other = await login('other-human', 'automated-web', ['read']);
  await reduce(other, ['read']);
  await unchanged();

  // An unauthenticated request.
  expect((await reduce('', ['read'])).status).toBe(401);
  await unchanged();

  // The automated account's own credential session is not an operator opening.
  await provision('agent-own', true);
  await seed('agent-own', ['read', 'write']);
  const own = await request('/signin', {
    account_id: 'agent-own',
    password,
    client_id: 'automated-ext',
    scope: ['read', 'write'],
  });
  expect(own.status).toBe(200);
  expect(await proof(cookie(own))).toMatchObject({ amr: ['pwd'] });
  expect((await reduce(cookie(own), ['read'])).status).toBeGreaterThanOrEqual(400);
  expect(await consentOf('agent-own')).toEqual({ scopes: ['read', 'write'], pending_scopes: null });

  // An operator session whose opening attribution is gone or whose human is no longer eligible.
  const session = await operatorSession('agent', 'operator-human', 'automated-ext', ['read', 'write']);
  accounts.get('operator-human')!.state = 'suspended';
  expect((await reduce(session, ['read'])).status).toBeGreaterThanOrEqual(400);
  accounts.get('operator-human')!.state = 'active';
  await unchanged();
  await pool.query('DELETE FROM auth_session_opening WHERE subject_account_id=$1', ['agent']);
  expect((await reduce(session, ['read'])).status).toBeGreaterThanOrEqual(400);
  await unchanged();
});
