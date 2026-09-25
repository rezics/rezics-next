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
import { AccessRoles } from '../../../services/main/src/modules/access/roles.ts';
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

test('IAM05/IAM30/IAM33: pinned role revision grants one saved work.create path', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.FUSEKI_URL || !Bun.env.MAIN_DATA_EPOCH
    || !Bun.env.MAIN_ROUTING_EPOCH || !Bun.env.ACCESS_DATABASE_URL
    || !Bun.env.ACCOUNT_DATABASE_URL || !Bun.env.ACCOUNT_MAIN_RESOURCE) {
    throw new Error('Run through the isolated QA integration tier');
  }
  const state = join(root, '.temp', `role-api-${randomUUID()}`);
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
      const email = `roles-${name}-${randomUUID()}@example.test`;
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
      client_name: 'Role verifier', scope: 'access:role',
      token_endpoint_auth_method: 'client_secret_post', grant_types: ['client_credentials'],
      client_credentials_scopes: ['access:role'] } });
    const redirectUri = 'http://localhost:3000/auth/callback';
    const client = await auth.api.adminCreateOAuthClient({ headers, body: {
      client_name: 'Role native client', application_type: 'native',
      redirect_uris: [redirectUri], token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'], scope: 'openid access:role work:create',
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
    const manager = await signUp('manager');
    const actor = await signUp('actor');
    const managerToken = await tokenFor(manager, 'openid access:role');
    const actorToken = await tokenFor(actor, 'openid work:create');
    const issuer = `https://rezics.com/id/${randomUUID()}`;
    const actingSubject = `https://rezics.com/id/${randomUUID()}`;
    const managerPrincipal = randomUUID(), actorPrincipal = randomUUID();
    await accessPool.query(`INSERT INTO access.principal
      (id, account_issuer, account_subject) VALUES ($1,$2,$3),($4,$2,$5)`,
    [managerPrincipal, `${base}/api/auth`, manager.id, actorPrincipal, actor.id]);
    await accessPool.query(`INSERT INTO access.authority_subject (id, kind)
      VALUES ($1,'agent'),($2,'agent')`, [issuer, actingSubject]);
    await accessPool.query("INSERT INTO access.scope_gate (id) VALUES ('work:create:root') ON CONFLICT DO NOTHING");
    await accessPool.query(`INSERT INTO access.representation
      (id, principal_id, subject_id, action, valid_until) VALUES
      ($1,$2,$3,'access.role.manage',now() + interval '1 hour'),
      ($4,$5,$6,'work.create',now() + interval '1 hour')`,
    [randomUUID(), managerPrincipal, issuer,
      randomUUID(), actorPrincipal, actingSubject]);
    await accessPool.query(`INSERT INTO access.permission_grant
      (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1,$2,$2,'work:create:root','access.role.manage',now() + interval '1 hour')`,
    [randomUUID(), issuer]);
    const fuseki = new FusekiClient(Bun.env.FUSEKI_URL);
    const admission = new AccessAdmissionRegistry(accessPool);
    const main = createMainApp(fuseki, { environment: { fuseki,
      lineage: { dataEpoch: Bun.env.MAIN_DATA_EPOCH, routingEpoch: Bun.env.MAIN_ROUTING_EPOCH },
      objectDirectory: join(state, 'objects') },
    account: new AccountAssertionVerifier({ issuer: `${base}/api/auth`,
      audience: Bun.env.ACCOUNT_MAIN_RESOURCE, jwksUrl: `${base}/api/auth/jwks`,
      introspectUrl: `${base}/api/auth/oauth2/introspect`,
      clientId: verifierClient.client_id, clientSecret: verifierClient.client_secret! }),
    access: admission, actingContexts: new AccessActingContexts(accessPool),
    roles: new AccessRoles(accessPool) });
    const request = (method: string, path: string, bearer: string,
      body?: object, key = `role-${randomUUID()}`) => main.handle(new Request(`http://main.local${path}`, {
        method, headers: { authorization: `Bearer ${bearer}`,
          ...(body ? { 'content-type': 'application/json', 'idempotency-key': key } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }));
    const selected = (authorityEpoch: string) => ({
      profile: 'work-create-acting-context-check-v1', task: 'work.create',
      actingSubject, expectedAuthorityEpoch: authorityEpoch });
    const familyId = randomUUID();
    const familyBody = { profile: 'work-create-role-family-v1', familyId,
      issuerSubject: issuer, expectedAuthorityEpoch: '0', permissions: [] };
    const familyKey = `family-${randomUUID()}`;
    const created = await request('POST', '/v1/access/roles', managerToken, familyBody, familyKey);
    expect(created.status).toBe(200);
    expect((await created.json() as { revision: string }).revision).toBe('1');
    expect((await request('POST', '/v1/access/roles', managerToken,
      familyBody, familyKey)).status).toBe(200);
    expect((await request('POST', '/v1/access/roles', managerToken,
      { ...familyBody, familyId: randomUUID() }, familyKey)).status).toBe(409);
    const bind = (bindingId: string, roleRevision: string, expectedAuthorityEpoch: string,
      validUntil = new Date(Date.now() + 30 * 60_000).toISOString()) => ({
      profile: 'work-create-role-binding-change-v1', action: 'bind',
      issuerSubject: issuer, expectedAuthorityEpoch, bindingId, familyId,
      roleRevision, recipientSubject: actingSubject, validUntil });
    const emptyBinding = randomUUID();
    expect((await request('POST', '/v1/access/role-bindings', managerToken,
      bind(emptyBinding, '1', '0'))).status).toBe(403);
    await accessPool.query(`INSERT INTO access.representation
      (id, principal_id, subject_id, action, valid_until)
      VALUES ($1,$2,$3,'access.role.bind',now() + interval '1 hour')`,
    [randomUUID(), managerPrincipal, issuer]);
    await accessPool.query(`INSERT INTO access.permission_grant
      (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1,$2,$2,'work:create:root','access.role.bind',now() + interval '1 hour')`,
    [randomUUID(), issuer]);
    const boundEmpty = await request('POST', '/v1/access/role-bindings', managerToken,
      bind(emptyBinding, '1', '0'));
    expect(boundEmpty.status).toBe(200);
    let epoch = (await boundEmpty.json() as { authorityEpoch: string }).authorityEpoch;
    expect((await request('POST', '/v1/me/acting-context-checks', actorToken,
      selected(epoch))).status).toBe(403);
    const revisionBody = (expectedHeadRevision: string, permissions: string[]) => ({
      profile: 'work-create-role-revision-v1', familyId, issuerSubject: issuer,
      expectedAuthorityEpoch: epoch, expectedHeadRevision, permissions });
    expect((await request('POST', '/v1/access/role-revisions', managerToken,
      revisionBody('1', ['work.create']))).status).toBe(403);
    await accessPool.query(`INSERT INTO access.permission_grant
      (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1,$2,$2,'work:create:root','access.grant.assign.work.create',
        now() + interval '1 hour')`, [randomUUID(), issuer]);
    const revision2 = await request('POST', '/v1/access/role-revisions', managerToken,
      revisionBody('1', ['work.create']));
    expect(revision2.status).toBe(200);
    expect((await revision2.json() as { revision: string }).revision).toBe('2');
    expect((await request('POST', '/v1/access/role-revisions', managerToken,
      revisionBody('1', ['work.create']))).status).toBe(409);
    const familyReadPath = `/v1/access/roles/${familyId}?issuerSubject=${encodeURIComponent(issuer)}`;
    const family = await request('GET', familyReadPath, managerToken);
    expect(family.status).toBe(200);
    expect((await family.json() as { headRevision: string;
      revisions: { revision: string; permissions: string[] }[] })).toMatchObject({
      headRevision: '2', revisions: [
        { revision: '1', permissions: [] },
        { revision: '2', permissions: ['work.create'] },
      ] });
    expect((await request('POST', '/v1/me/acting-context-checks', actorToken,
      selected(epoch))).status).toBe(403);
    const bindingId = randomUUID();
    expect((await request('POST', '/v1/access/role-bindings', managerToken,
      bind(bindingId, '2', epoch,
        new Date(Date.now() + 2 * 60 * 60_000).toISOString()))).status).toBe(403);
    const bindingBody = bind(bindingId, '2', epoch);
    const bindingKey = `binding-${randomUUID()}`;
    const bound = await request('POST', '/v1/access/role-bindings', managerToken,
      bindingBody, bindingKey);
    expect(bound.status).toBe(200);
    epoch = (await bound.json() as { authorityEpoch: string }).authorityEpoch;
    expect((await request('POST', '/v1/access/role-bindings', managerToken,
      bindingBody, bindingKey)).status).toBe(200);
    expect((await request('POST', '/v1/access/role-bindings', managerToken,
      { ...bindingBody, bindingId: randomUUID() }, bindingKey)).status).toBe(409);
    expect((await request('POST', '/v1/me/acting-context-checks', actorToken,
      selected(epoch))).status).toBe(200);
    const discovered = await request('GET', '/v1/me/acting-contexts?task=work.create', actorToken);
    expect(discovered.status).toBe(200);
    expect(JSON.stringify(await discovered.json())).toContain(actingSubject);
    const principal = { issuer: `${base}/api/auth`, subject: actor.id };
    const admissionRequest = (value: string) => ({ principal, actingSubject,
      scope: 'work:create:root', action: 'work.create',
      idempotencyKey: `role-admission-${randomUUID()}`,
      requestDigest: createHash('sha256').update(value).digest('hex') });
    const old = admissionRequest('old-role');
    const oldAdmission = await admission.register(old);
    expect(oldAdmission.dispatchEligible).toBe(true);
    const saved = (await accessPool.query<{ role_binding_id: string;
      role_revision: string; role_binding_generation: string }>(`
      SELECT role_binding_id, role_revision, role_binding_generation
      FROM access.admission WHERE id = $1`, [oldAdmission.id])).rows[0];
    expect(saved).toMatchObject({ role_binding_id: bindingId,
      role_revision: '2', role_binding_generation: '0' });
    const revision3 = await request('POST', '/v1/access/role-revisions', managerToken,
      revisionBody('2', []));
    expect(revision3.status).toBe(200);
    expect((await request('POST', '/v1/me/acting-context-checks', actorToken,
      selected(epoch))).status).toBe(200);
    await expect(accessPool.query(`UPDATE access.role_revision
      SET permissions = '{}' WHERE family_id = $1 AND revision = 2`,
    [familyId])).rejects.toThrow();
    const revokeBody = { profile: 'work-create-role-binding-change-v1',
      action: 'revoke', issuerSubject: issuer, expectedAuthorityEpoch: epoch,
      bindingId, expectedObjectGeneration: '0' };
    const revoked = await request('POST', '/v1/access/role-bindings', managerToken, revokeBody);
    expect(revoked.status).toBe(200);
    epoch = (await revoked.json() as { authorityEpoch: string }).authorityEpoch;
    expect((await request('POST', '/v1/me/acting-context-checks', actorToken,
      selected(epoch))).status).toBe(403);
    await expect(admission.claim(oldAdmission.id, old.requestDigest)).rejects.toThrow();
    const bindingReadPath = `/v1/access/role-bindings/${bindingId}?issuerSubject=${encodeURIComponent(issuer)}`;
    const bindingRead = await request('GET', bindingReadPath, managerToken);
    expect((await bindingRead.json() as { binding: { active: boolean; generation: string } })
      .binding).toMatchObject({ active: false, generation: '1' });
    const page = await request('GET', `/v1/access/role-bindings?issuerSubject=${encodeURIComponent(issuer)}`,
      managerToken);
    expect(page.status).toBe(200);
    expect((await page.json() as { bindings: { id: string }[] }).bindings
      .map(binding => binding.id)).toContain(bindingId);
    const concurrent = await Promise.all([randomUUID(), randomUUID()].map(id =>
      request('POST', '/v1/access/role-bindings', managerToken, bind(id, '1', epoch))));
    expect(concurrent.map(response => response.status).sort()).toEqual([200, 409]);
    await expect(accessPool.query(`UPDATE access.role_binding_receipt
      SET result_authority_epoch = 0 WHERE idempotency_key = $1`,
    [bindingKey])).rejects.toThrow();
  } finally {
    await account.stop();
    await Promise.all([accountPool.end(), accessPool.end()]);
    rmSync(state, { recursive: true, force: true });
  }
}, 180_000);
