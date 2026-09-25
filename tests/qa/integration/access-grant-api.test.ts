import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { expect, test } from 'bun:test';
import { Pool } from 'pg';
import { createAccountApp } from '../../../services/account/src/app.ts';
import { createAccountAuth } from '../../../services/account/src/auth.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { AccessAdmissionRegistry } from '../../../services/main/src/modules/access/admission.ts';
import { AccessActingContexts } from '../../../services/main/src/modules/access/contexts.ts';
import { AccessGrants } from '../../../services/main/src/modules/access/grants.ts';
import { AccountAssertionVerifier } from '../../../services/main/src/modules/account/verify-assertion.ts';

const root = resolve(import.meta.dir, '../../..');

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('no Account test port'));
      server.close(() => resolvePort(address.port));
    });
  });
}

test('IAM13/IAM14: institutional Agent grant survives operator and representative changes', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.FUSEKI_URL || !Bun.env.MAIN_DATA_EPOCH
    || !Bun.env.MAIN_ROUTING_EPOCH || !Bun.env.ACCESS_DATABASE_URL
    || !Bun.env.ACCOUNT_DATABASE_URL || !Bun.env.ACCOUNT_MAIN_RESOURCE) {
    throw new Error('Run through the isolated QA integration tier');
  }
  const state = join(root, '.temp', `grant-api-${randomUUID()}`);
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const accountPool = new Pool({ connectionString: Bun.env.ACCOUNT_DATABASE_URL });
  const accessPool = new Pool({ connectionString: Bun.env.ACCESS_DATABASE_URL });
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const operators = new Set<string>();
  const auth = createAccountAuth({ baseURL: base, secret: Bun.env.ACCOUNT_SECRET!,
    resource: Bun.env.ACCOUNT_MAIN_RESOURCE, pool: accountPool, operatorUserIds: operators });
  const account = createAccountApp(auth, accountPool).listen({ hostname: '127.0.0.1', port });
  try {
    async function signUp(name: string) {
      const email = `grants-${name}-${randomUUID()}@example.test`;
      const password = randomBytes(24).toString('base64url');
      const response = await account.handle(new Request(`${base}/api/auth/sign-up/email`, {
        method: 'POST', headers: { 'content-type': 'application/json', origin: base },
        body: JSON.stringify({ name, email, password }),
      }));
      expect(response.status).toBe(200);
      const body = await response.json() as { user: { id: string } };
      return { id: body.user.id, email, password, cookie: response.headers.get('set-cookie')! };
    }
    const operator = await signUp('operator');
    operators.add(operator.id);
    const headers = new Headers({ cookie: operator.cookie, origin: base });
    const verifierClient = await auth.api.adminCreateOAuthClient({ headers, body: {
      client_name: 'Grant API verifier', scope: 'access:grant',
      token_endpoint_auth_method: 'client_secret_post', grant_types: ['client_credentials'],
      client_credentials_scopes: ['access:grant'] } });
    const redirectUri = 'http://localhost:3000/auth/callback';
    const client = await auth.api.adminCreateOAuthClient({ headers, body: {
      client_name: 'Grant API native client', application_type: 'native',
      redirect_uris: [redirectUri], token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'], scope: 'openid access:grant work:create',
      skip_consent: true, require_pkce: true } });
    async function tokenFor(user: { email: string; password: string }, scope: string) {
      const signIn = await fetch(`${base}/api/auth/sign-in/email`, { method: 'POST',
        headers: { 'content-type': 'application/json', origin: base },
        body: JSON.stringify({ email: user.email, password: user.password }) });
      expect(signIn.status).toBe(200);
      const verifier = randomBytes(32).toString('base64url');
      const authorize = new URL(`${base}/api/auth/oauth2/authorize`);
      for (const [key, value] of Object.entries({ response_type: 'code',
        client_id: client.client_id, redirect_uri: redirectUri, scope,
        state: randomUUID(), resource: Bun.env.ACCOUNT_MAIN_RESOURCE,
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256',
      })) authorize.searchParams.set(key, value);
      const authorized = await fetch(authorize, {
        headers: { cookie: signIn.headers.get('set-cookie')! }, redirect: 'manual' });
      expect(authorized.status).toBe(302);
      const code = new URL(authorized.headers.get('location')!).searchParams.get('code')!;
      const exchange = await fetch(`${base}/api/auth/oauth2/token`, { method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', client_id: client.client_id,
          code, redirect_uri: redirectUri, code_verifier: verifier,
          resource: Bun.env.ACCOUNT_MAIN_RESOURCE }) });
      expect(exchange.status).toBe(200);
      return (await exchange.json() as { access_token: string }).access_token;
    }
    const manager1 = await signUp('manager-one');
    const manager2 = await signUp('manager-two');
    const representative1 = await signUp('representative-one');
    const representative2 = await signUp('representative-two');
    const [managerToken1, managerToken2, representativeToken1, representativeToken2] =
      await Promise.all([
        tokenFor(manager1, 'openid access:grant'),
        tokenFor(manager2, 'openid access:grant'),
        tokenFor(representative1, 'openid work:create'),
        tokenFor(representative2, 'openid work:create access:grant'),
      ]);
    const issuer = `https://rezics.com/id/${randomUUID()}`;
    const recipient = `https://rezics.com/id/${randomUUID()}`;
    const otherRecipient = `https://rezics.com/id/${randomUUID()}`;
    const principals = [manager1, manager2, representative1, representative2]
      .map(user => ({ ...user, principalId: randomUUID() }));
    for (const user of principals) {
      await accessPool.query(`INSERT INTO access.principal
        (id, account_issuer, account_subject) VALUES ($1,$2,$3)`,
      [user.principalId, `${base}/api/auth`, user.id]);
    }
    await accessPool.query(`INSERT INTO access.authority_subject (id, kind) VALUES
      ($1,'agent'),($2,'agent'),($3,'agent')`, [issuer, recipient, otherRecipient]);
    await accessPool.query("INSERT INTO access.scope_gate (id) VALUES ('work:create:root') ON CONFLICT DO NOTHING");
    await accessPool.query(`INSERT INTO access.representation
      (id, principal_id, subject_id, action, valid_until) VALUES
      ($1,$2,$3,'access.grant.assign.work.create',now() + interval '1 hour'),
      ($4,$5,$3,'access.grant.assign.work.create',now() + interval '1 hour'),
      ($6,$7,$8,'work.create',now() + interval '1 hour')`,
    [randomUUID(), principals[0]!.principalId, issuer,
      randomUUID(), principals[1]!.principalId,
      randomUUID(), principals[2]!.principalId, recipient]);
    const fuseki = new FusekiClient(Bun.env.FUSEKI_URL);
    const main = createMainApp(fuseki, { environment: { fuseki,
      lineage: { dataEpoch: Bun.env.MAIN_DATA_EPOCH, routingEpoch: Bun.env.MAIN_ROUTING_EPOCH },
      objectDirectory: join(state, 'objects') },
    account: new AccountAssertionVerifier({ issuer: `${base}/api/auth`,
      audience: Bun.env.ACCOUNT_MAIN_RESOURCE, jwksUrl: `${base}/api/auth/jwks`,
      introspectUrl: `${base}/api/auth/oauth2/introspect`,
      clientId: verifierClient.client_id, clientSecret: verifierClient.client_secret! }),
    access: new AccessAdmissionRegistry(accessPool),
    actingContexts: new AccessActingContexts(accessPool), grants: new AccessGrants(accessPool) });
    const request = (method: string, path: string, bearer: string,
      body?: object, key = `grant-${randomUUID()}`) => main.handle(new Request(`http://main.local${path}`, {
        method, headers: { authorization: `Bearer ${bearer}`,
          ...(body ? { 'content-type': 'application/json', 'idempotency-key': key } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }));
    const pagePath = `/v1/access/grants?issuerSubject=${encodeURIComponent(issuer)}`;
    expect((await request('GET', pagePath, representativeToken1)).status).toBe(401);
    expect((await request('GET', pagePath, managerToken1)).status).toBe(403);
    await accessPool.query(`INSERT INTO access.permission_grant
      (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1,$2,$2,'work:create:root','access.grant.assign.work.create',
        now() + interval '1 hour')`, [randomUUID(), issuer]);
    const readPage = async (bearer = managerToken1, after?: string) => {
      const response = await request('GET', `${pagePath}${after ? `&after=${after}` : ''}`, bearer);
      expect(response.status).toBe(200);
      return await response.json() as { authorityEpoch: string; nextCursor: string | null;
        grants: { id: string; recipientSubject: string; generation: string; active: boolean }[] };
    };
    let epoch = (await readPage()).authorityEpoch;
    const grantId = randomUUID();
    const change = (action: string, fields: Record<string, unknown>, expected = epoch) => ({
      profile: 'work-create-agent-grant-change-v1', issuerSubject: issuer,
      expectedAuthorityEpoch: expected, action, ...fields });
    const path = '/v1/access/grant-changes';
    expect((await request('POST', path, managerToken1, change('create', {
      grantId: randomUUID(), recipientSubject: recipient,
      validUntil: new Date(Date.now() + 2 * 60 * 60_000).toISOString() }))).status).toBe(403);
    const create = change('create', { grantId, recipientSubject: recipient,
      validUntil: new Date(Date.now() + 30 * 60_000).toISOString() });
    const createKey = `grant-create-${randomUUID()}`;
    const created = await request('POST', path, managerToken1, create, createKey);
    expect(created.status).toBe(200);
    const createdEpoch = (await created.json() as { authorityEpoch: string }).authorityEpoch;
    expect(createdEpoch).not.toBe(epoch);
    expect((await request('POST', path, managerToken1, create, createKey)).status).toBe(200);
    expect((await request('POST', path, managerToken1,
      { ...create, grantId: randomUUID() }, createKey)).status).toBe(409);
    const exactPath = `/v1/access/grants/${grantId}?issuerSubject=${encodeURIComponent(issuer)}`;
    const exact = await request('GET', exactPath, managerToken1);
    expect(exact.status).toBe(200);
    expect((await exact.json() as { grant: { recipientSubject: string; generation: string } })
      .grant).toMatchObject({ recipientSubject: recipient, generation: '0' });
    expect((await accessPool.query<{ assigned_by_principal: string; issuer_subject: string }>(`
      SELECT assigned_by_principal, issuer_subject FROM access.permission_grant WHERE id = $1`,
    [grantId])).rows[0]).toMatchObject({ assigned_by_principal: principals[0]!.principalId,
      issuer_subject: issuer });
    const selected = (authorityEpoch: string) => ({
      profile: 'work-create-acting-context-check-v1', task: 'work.create',
      actingSubject: recipient, expectedAuthorityEpoch: authorityEpoch });
    expect((await request('POST', '/v1/me/acting-context-checks',
      representativeToken1, selected(createdEpoch))).status).toBe(200);

    const [left, right] = await Promise.all([
      request('POST', path, managerToken1, change('create', {
        grantId: randomUUID(), recipientSubject: otherRecipient,
        validUntil: new Date(Date.now() + 20 * 60_000).toISOString() }, createdEpoch)),
      request('POST', path, managerToken2, change('create', {
        grantId: randomUUID(), recipientSubject: otherRecipient,
        validUntil: new Date(Date.now() + 20 * 60_000).toISOString() }, createdEpoch)),
    ]);
    expect([left.status, right.status].sort()).toEqual([200, 409]);
    epoch = (await readPage(managerToken2)).authorityEpoch;
    await accessPool.query(`UPDATE access.representation SET active = false,
      generation = generation + 1 WHERE principal_id = $1
      AND subject_id = $2 AND action = 'access.grant.assign.work.create'`,
    [principals[0]!.principalId, issuer]);
    expect((await request('GET', exactPath, managerToken1)).status).toBe(403);
    expect((await request('GET', exactPath, managerToken2)).status).toBe(200);
    await accessPool.query(`UPDATE access.representation SET active = false,
      generation = generation + 1 WHERE principal_id = $1
      AND subject_id = $2 AND action = 'work.create'`,
    [principals[2]!.principalId, recipient]);
    await accessPool.query(`INSERT INTO access.representation
      (id, principal_id, subject_id, action, valid_until)
      VALUES ($1,$2,$3,'work.create',now() + interval '1 hour'),
      ($4,$2,$3,'access.grant.assign.work.create',now() + interval '1 hour')`,
    [randomUUID(), principals[3]!.principalId, recipient, randomUUID()]);
    await accessPool.query(`INSERT INTO access.permission_grant
      (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1,$2,$3,'work:create:root','access.grant.assign.work.create',
        now() + interval '1 hour')`, [randomUUID(), issuer, recipient]);
    expect((await request('POST', '/v1/me/acting-context-checks',
      representativeToken1, selected(epoch))).status).toBe(403);
    expect((await request('POST', '/v1/me/acting-context-checks',
      representativeToken2, selected(epoch))).status).toBe(200);
    const authorPagePath = `/v1/access/grants?issuerSubject=${encodeURIComponent(recipient)}`;
    const authorPage = await request('GET', authorPagePath, representativeToken2);
    expect(authorPage.status).toBe(200);
    const authorEpoch = (await authorPage.json() as { authorityEpoch: string }).authorityEpoch;
    const asAuthorGrantId = randomUUID();
    const issuedAsAuthor = await request('POST', path, representativeToken2, {
      profile: 'work-create-agent-grant-change-v1', action: 'create',
      issuerSubject: recipient, expectedAuthorityEpoch: authorEpoch,
      grantId: asAuthorGrantId, recipientSubject: otherRecipient,
      validUntil: new Date(Date.now() + 20 * 60_000).toISOString() });
    expect(issuedAsAuthor.status).toBe(200);
    expect((await accessPool.query<{ issuer_subject: string;
      assigned_by_principal: string }>(`SELECT issuer_subject, assigned_by_principal
      FROM access.permission_grant WHERE id = $1`, [asAuthorGrantId])).rows[0])
      .toMatchObject({ issuer_subject: recipient,
        assigned_by_principal: principals[3]!.principalId });
    epoch = (await readPage(managerToken2)).authorityEpoch;
    const revoke = change('revoke', { grantId, expectedObjectGeneration: '0' });
    const revokeKey = `grant-revoke-${randomUUID()}`;
    const revoked = await request('POST', path, managerToken2, revoke, revokeKey);
    expect(revoked.status).toBe(200);
    const revokedEpoch = (await revoked.json() as { authorityEpoch: string }).authorityEpoch;
    expect((await request('POST', path, managerToken2, revoke, revokeKey)).status).toBe(200);
    expect((await request('POST', '/v1/me/acting-context-checks',
      representativeToken2, selected(revokedEpoch))).status).toBe(403);
    const revokedRead = await request('GET', exactPath, managerToken2);
    expect((await revokedRead.json() as { grant: { active: boolean; generation: string } })
      .grant).toMatchObject({ active: false, generation: '1' });
    await expect(accessPool.query(`UPDATE access.grant_change_receipt
      SET result_authority_epoch = 0 WHERE idempotency_key = $1`,
    [createKey])).rejects.toThrow();

    await accessPool.query(`INSERT INTO access.permission_grant
      (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      SELECT gen_random_uuid(), $1, $2, 'work:create:root', 'work.create',
        now() + interval '30 minutes' FROM generate_series(1, 51)`,
    [issuer, otherRecipient]);
    const firstPage = await readPage(managerToken2);
    expect(firstPage.grants.length).toBe(50);
    expect(firstPage.nextCursor).not.toBeNull();
    const secondPage = await readPage(managerToken2, firstPage.nextCursor!);
    expect(secondPage.grants.length).toBeGreaterThan(0);
    expect(secondPage.grants.length).toBeLessThanOrEqual(50);
    expect(new Set([...firstPage.grants, ...secondPage.grants].map(grant => grant.id)).size)
      .toBe(firstPage.grants.length + secondPage.grants.length);
  } finally {
    await account.stop();
    await Promise.all([accountPool.end(), accessPool.end()]);
    rmSync(state, { recursive: true, force: true });
  }
}, 180_000);
