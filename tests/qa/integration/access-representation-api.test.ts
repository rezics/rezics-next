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
import { AccessRepresentations } from '../../../services/main/src/modules/access/representations.ts';
import { AccessRepresentedMembershipAuthority } from '../../../services/main/src/modules/access/represented-membership-authority.ts';
import { AccessMemberships, REPRESENTED_ORG_MANAGER_SQL } from '../../../services/main/src/modules/access/memberships.ts';
import { AccessMembershipConsents } from '../../../services/main/src/modules/access/membership-consents.ts';
import { AccountAssertionVerifier } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { cloneQaAccountAccessDatabases } from '../support/databases.ts';

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

test('IAM25/IAM26/IAM33: recipient request admits one exact Agent mandate', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.FUSEKI_URL || !Bun.env.MAIN_DATA_EPOCH
    || !Bun.env.MAIN_ROUTING_EPOCH || !Bun.env.ACCESS_DATABASE_URL
    || !Bun.env.ACCOUNT_DATABASE_URL || !Bun.env.ACCOUNT_MAIN_RESOURCE) {
    throw new Error('Run through the isolated QA integration tier');
  }
  const state = join(root, '.temp', `representation-api-${randomUUID()}`);
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
      const email = `mandate-${name}-${randomUUID()}@example.test`;
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
      client_name: 'Representation verifier',
      scope: 'access:represent access:representation-manage',
      token_endpoint_auth_method: 'client_secret_post', grant_types: ['client_credentials'],
      client_credentials_scopes: ['access:represent', 'access:representation-manage'] } });
    const redirectUri = 'http://localhost:3000/auth/callback';
    const client = await auth.api.adminCreateOAuthClient({ headers, body: {
      client_name: 'Representation native client', application_type: 'native',
      redirect_uris: [redirectUri], token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'],
      scope: 'openid access:represent access:representation-manage work:create',
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
    const recipient = await signUp('recipient');
    const managerToken = await tokenFor(manager, 'openid access:representation-manage');
    const recipientToken = await tokenFor(recipient, 'openid access:represent work:create');
    const subject = `https://rezics.com/id/${randomUUID()}`;
    const managerPrincipal = randomUUID();
    await accessPool.query(`INSERT INTO access.principal
      (id, account_issuer, account_subject) VALUES ($1,$2,$3)`,
    [managerPrincipal, `${base}/api/auth`, manager.id]);
    await accessPool.query("INSERT INTO access.authority_subject (id, kind) VALUES ($1,'agent')",
      [subject]);
    await accessPool.query("INSERT INTO access.scope_gate (id) VALUES ('work:create:root') ON CONFLICT DO NOTHING");
    await accessPool.query(`INSERT INTO access.representation
      (id, principal_id, subject_id, action, valid_until)
      VALUES ($1,$2,$3,'access.representation.manage',now() + interval '1 hour')`,
    [randomUUID(), managerPrincipal, subject]);
    await accessPool.query(`INSERT INTO access.permission_grant
      (id, issuer_subject, recipient_subject, scope_id, action, valid_until) VALUES
      ($1,$2,$2,'work:create:root','access.representation.manage',now() + interval '1 hour'),
      ($3,$2,$2,'work:create:root','work.create',now() + interval '1 hour')`,
    [randomUUID(), subject, randomUUID()]);
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
    representations: new AccessRepresentations(accessPool) });
    const request = (method: string, path: string, bearer: string,
      body?: object, key = `mandate-${randomUUID()}`) => main.handle(new Request(`http://main.local${path}`, {
        method, headers: { authorization: `Bearer ${bearer}`,
          ...(body ? { 'content-type': 'application/json', 'idempotency-key': key } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }));
    const requestPath = '/v1/me/representation-requests';
    const changePath = '/v1/access/representation-changes';
    const requestBody = (requestId: string, validUntil: string) => ({
      profile: 'work-create-representation-request-v1', requestId,
      actingSubject: subject, validUntil });
    const longRequestId = randomUUID();
    const longRequested = await request('POST', requestPath, recipientToken,
      requestBody(longRequestId, new Date(Date.now() + 2 * 60 * 60_000).toISOString()));
    expect(longRequested.status).toBe(200);
    const pending = await longRequested.json() as { status: string; representationId: string | null };
    expect(pending).toMatchObject({ status: 'pending', representationId: null });
    const recipientPrincipal = (await accessPool.query<{ id: string }>(`
      SELECT id FROM access.principal WHERE account_issuer = $1 AND account_subject = $2`,
    [`${base}/api/auth`, recipient.id])).rows[0]?.id;
    expect(recipientPrincipal).toBeTruthy();
    const longReadPath = `/v1/access/representation-requests/${longRequestId}?issuerSubject=${encodeURIComponent(subject)}`;
    const managerRead = await request('GET', longReadPath, managerToken);
    expect(managerRead.status).toBe(200);
    expect(JSON.stringify(await managerRead.json())).not.toContain(recipientPrincipal!);
    const selected = (authorityEpoch: string) => ({
      profile: 'work-create-acting-context-check-v1', task: 'work.create',
      actingSubject: subject, expectedAuthorityEpoch: authorityEpoch });
    expect((await request('POST', '/v1/me/acting-context-checks', recipientToken,
      selected('0'))).status).toBe(403);
    const acceptBody = (requestId: string, representationId: string,
      expectedAuthorityEpoch: string) => ({
      profile: 'work-create-representation-change-v1', action: 'accept',
      issuerSubject: subject, expectedAuthorityEpoch, requestId, representationId });
    expect((await request('POST', changePath, managerToken,
      acceptBody(longRequestId, randomUUID(), '0'))).status).toBe(403);
    await accessPool.query(`INSERT INTO access.permission_grant
      (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1,$2,$2,'work:create:root','access.representation.assign.work.create',
        now() + interval '1 hour')`, [randomUUID(), subject]);
    expect((await request('POST', changePath, managerToken,
      acceptBody(longRequestId, randomUUID(), '0'))).status).toBe(403);
    const requestId = randomUUID();
    const body = requestBody(requestId, new Date(Date.now() + 30 * 60_000).toISOString());
    const recipientKey = `recipient-${randomUUID()}`;
    const requested = await request('POST', requestPath, recipientToken, body, recipientKey);
    expect(requested.status).toBe(200);
    expect((await request('POST', requestPath, recipientToken, body, recipientKey)).status).toBe(200);
    expect((await request('POST', requestPath, recipientToken,
      { ...body, requestId: randomUUID() }, recipientKey)).status).toBe(409);
    const representationId = randomUUID();
    const acceptedBody = acceptBody(requestId, representationId, '0');
    const managerKey = `accept-${randomUUID()}`;
    const accepted = await request('POST', changePath, managerToken, acceptedBody, managerKey);
    expect(accepted.status).toBe(200);
    const acceptedEpoch = (await accepted.json() as { authorityEpoch: string }).authorityEpoch;
    expect(acceptedEpoch).toBe('1');
    expect((await request('POST', changePath, managerToken,
      acceptedBody, managerKey)).status).toBe(200);
    expect((await request('POST', changePath, managerToken,
      { ...acceptedBody, representationId: randomUUID() }, managerKey)).status).toBe(409);
    const mandatePath = `/v1/access/representations/${representationId}?issuerSubject=${encodeURIComponent(subject)}`;
    const mandateRead = await request('GET', mandatePath, managerToken);
    expect(mandateRead.status).toBe(200);
    expect((await mandateRead.json() as { requestId: string; generation: string })
      .requestId).toBe(requestId);
    expect((await request('POST', '/v1/me/acting-context-checks', recipientToken,
      selected(acceptedEpoch))).status).toBe(200);
    const principal = { issuer: `${base}/api/auth`, subject: recipient.id };
    const admissionRequest = (digest: string) => ({ principal, actingSubject: subject,
      scope: 'work:create:root', action: 'work.create',
      idempotencyKey: `admission-${randomUUID()}`, requestDigest: digest });
    const oldDigest = createHash('sha256').update('old-mandate').digest('hex');
    const oldAdmission = await admission.register(admissionRequest(oldDigest));
    expect(oldAdmission.dispatchEligible).toBe(true);
    const revokedBody = { profile: 'work-create-representation-change-v1',
      action: 'revoke', issuerSubject: subject, representationId,
      expectedAuthorityEpoch: acceptedEpoch, expectedObjectGeneration: '0' };
    const revokeKey = `revoke-${randomUUID()}`;
    const revoked = await request('POST', changePath, managerToken, revokedBody, revokeKey);
    expect(revoked.status).toBe(200);
    const revokedEpoch = (await revoked.json() as { authorityEpoch: string }).authorityEpoch;
    expect((await request('POST', changePath, managerToken,
      revokedBody, revokeKey)).status).toBe(200);
    expect((await request('POST', changePath, managerToken,
      { ...revokedBody, expectedObjectGeneration: '1' }, revokeKey)).status).toBe(409);
    expect((await request('POST', '/v1/me/acting-context-checks', recipientToken,
      selected(revokedEpoch))).status).toBe(403);
    await expect(admission.claim(oldAdmission.id, oldDigest)).rejects.toThrow();
    const revokedRead = await request('GET', mandatePath, managerToken);
    expect((await revokedRead.json() as { active: boolean; generation: string })
      .active).toBe(false);
    const newRequestId = randomUUID();
    const newRequested = await request('POST', requestPath, recipientToken,
      requestBody(newRequestId, new Date(Date.now() + 25 * 60_000).toISOString()));
    expect(newRequested.status).toBe(200);
    const freshId = randomUUID();
    const reaccepted = await request('POST', changePath, managerToken,
      acceptBody(newRequestId, freshId, revokedEpoch));
    expect(reaccepted.status).toBe(200);
    const freshEpoch = (await reaccepted.json() as { authorityEpoch: string }).authorityEpoch;
    expect((await request('POST', '/v1/me/acting-context-checks', recipientToken,
      selected(freshEpoch))).status).toBe(200);
    await expect(admission.claim(oldAdmission.id, oldDigest)).rejects.toThrow();
    const newDigest = createHash('sha256').update('new-mandate').digest('hex');
    const newAdmission = await admission.register(admissionRequest(newDigest));
    expect(newAdmission.dispatchEligible).toBe(true);
    await expect(accessPool.query(`UPDATE access.representation_request
      SET valid_until = now() WHERE id = $1`, [requestId])).rejects.toThrow();
    await expect(accessPool.query(`UPDATE access.representation_change_receipt
      SET result_authority_epoch = 0 WHERE idempotency_key = $1`,
    [managerKey])).rejects.toThrow();
  } finally {
    await account.stop();
    await Promise.all([accountPool.end(), accessPool.end()]);
    rmSync(state, { recursive: true, force: true });
  }
}, 180_000);

test('IAM26: exact P-to-A mandate and B-to-A grant change only B roster with private P proof', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.FUSEKI_URL || !Bun.env.MAIN_DATA_EPOCH
    || !Bun.env.MAIN_ROUTING_EPOCH || !Bun.env.ACCESS_DATABASE_URL
    || !Bun.env.ACCOUNT_DATABASE_URL || !Bun.env.ACCOUNT_MAIN_RESOURCE) {
    throw new Error('Run through the isolated QA integration tier');
  }
  const state = join(root, '.temp', `represented-org-${randomUUID()}`);
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const databases = await cloneQaAccountAccessDatabases(Bun.env.REZICS_QA_RUN_ID);
  const accountPool = new Pool({ connectionString: databases.urls.account });
  const accessPool = new Pool({ connectionString: databases.urls.access });
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const operators = new Set<string>();
  const auth = createAccountAuth({ baseURL: base, secret: Bun.env.ACCOUNT_SECRET!,
    resource: Bun.env.ACCOUNT_MAIN_RESOURCE, pool: accountPool, operatorUserIds: operators });
  const account = createAccountApp(auth, accountPool).listen({ hostname: '127.0.0.1', port });
  try {
    async function signUp(name: string) {
      const email = `iam26-${name}-${randomUUID()}@example.test`;
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
      client_name: 'IAM26 Main verifier', scope: 'access:manage access:grant access:represent access:representation-manage access:membership-consent',
      token_endpoint_auth_method: 'client_secret_post', grant_types: ['client_credentials'],
      client_credentials_scopes: ['access:manage', 'access:grant', 'access:represent',
        'access:representation-manage', 'access:membership-consent'] } });
    const callback = 'http://localhost:3000/auth/callback';
    const oauth = await auth.api.adminCreateOAuthClient({ headers, body: {
      client_name: 'IAM26 native client', application_type: 'native',
      redirect_uris: [callback], token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'],
      scope: 'openid access:manage access:grant access:represent access:representation-manage access:membership-consent',
      skip_consent: true, require_pkce: true } });
    async function tokenFor(user: { email: string; password: string }, scope: string) {
      const signedIn = await fetch(`${base}/api/auth/sign-in/email`, { method: 'POST',
        headers: { 'content-type': 'application/json', origin: base },
        body: JSON.stringify({ email: user.email, password: user.password }) });
      expect(signedIn.status).toBe(200);
      const verifier = randomBytes(32).toString('base64url');
      const authorize = new URL(`${base}/api/auth/oauth2/authorize`);
      for (const [key, value] of Object.entries({ response_type: 'code',
        client_id: oauth.client_id, redirect_uri: callback, scope, state: randomUUID(),
        resource: Bun.env.ACCOUNT_MAIN_RESOURCE,
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256' })) authorize.searchParams.set(key, value);
      const authorized = await fetch(authorize, { redirect: 'manual',
        headers: { cookie: signedIn.headers.get('set-cookie')! } });
      expect(authorized.status).toBe(302);
      const code = new URL(authorized.headers.get('location')!).searchParams.get('code')!;
      const exchange = await fetch(`${base}/api/auth/oauth2/token`, { method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', client_id: oauth.client_id,
          code, redirect_uri: callback, code_verifier: verifier,
          resource: Bun.env.ACCOUNT_MAIN_RESOURCE }) });
      expect(exchange.status).toBe(200);
      return (await exchange.json() as { access_token: string }).access_token;
    }
    const p = await signUp('principal');
    const aManager = await signUp('a-manager');
    const bManager = await signUp('b-manager');
    const target = await signUp('target');
    const pToken = await tokenFor(p, 'openid access:manage access:represent');
    const aToken = await tokenFor(aManager, 'openid access:representation-manage');
    const bToken = await tokenFor(bManager, 'openid access:grant');
    const targetToken = await tokenFor(target, 'openid access:membership-consent');
    const A = `https://rezics.com/id/${randomUUID()}`;
    const B = `https://rezics.com/id/${randomUUID()}`;
    const B2 = `https://rezics.com/id/${randomUUID()}`;
    const C = `https://rezics.com/id/${randomUUID()}`;
    const ids = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    const people = [p, aManager, bManager, target];
    const pConsent = randomUUID();
      for (let i = 0; i < people.length; i++) {
        await accessPool.query(`INSERT INTO access.principal
          (id, account_issuer, account_subject) VALUES ($1,$2,$3)`,
        [ids[i], `${base}/api/auth`, people[i]!.id]);
      }
      for (const subject of [A, B, B2, C]) {
        await accessPool.query(`INSERT INTO access.authority_subject (id, kind)
          VALUES ($1,'agent')`, [subject]);
      }
      await accessPool.query(`INSERT INTO access.scope_gate (id) VALUES ('work:create:root')
        ON CONFLICT DO NOTHING`);
      for (const subject of [A, B, B2]) {
        await accessPool.query(`INSERT INTO access.membership_policy
          (kind, owner_subject, revision, terms_revision)
          VALUES ('org',$1,1,'terms-1')`, [subject]);
      }
      await accessPool.query(`INSERT INTO access.private_membership_consent
        (id, principal_id, principal_epoch, kind, owner_subject, policy_revision,
          terms_revision, next_generation, expires_at)
        VALUES ($1,$2,0,'org',$3,1,'terms-1',1,now() + interval '5 minutes')`,
      [pConsent, ids[0], A]);
      await accessPool.query(`INSERT INTO access.private_membership
        (id, kind, owner_subject, principal_id, state, generation,
          policy_revision, terms_revision, consent_reference)
        VALUES ($1,'org',$2,$3,'joined',1,1,'terms-1',$4)`,
      [randomUUID(), A, ids[0], pConsent]);
      for (const [principalId, subject, action] of [
        [ids[0], A, 'work.create'], // publishing-only mandate
        [ids[0], A, 'access.representation.manage'], // unrelated administrator ability
        [ids[0], A, 'access.org.profile.edit'], // unrelated profile-editor ability
        [ids[1], A, 'access.representation.manage'],
        [ids[1], A, 'access.representation.assign.membership.manage.org'],
        [ids[2], B, 'access.grant.assign.membership.manage.org'],
        [ids[3], C, 'access.membership.consent'],
      ]) {
        await accessPool.query(`INSERT INTO access.representation
          (id, principal_id, subject_id, action, valid_until)
          VALUES ($1,$2,$3,$4,now() + interval '3 hours')`,
        [randomUUID(), principalId, subject, action]);
      }
      for (const [subject, action] of [
        [A, 'access.representation.manage'],
        [A, 'access.representation.assign.membership.manage.org'],
        [B, 'access.grant.assign.membership.manage.org'],
        [C, 'access.membership.consent'],
      ]) {
        await accessPool.query(`INSERT INTO access.permission_grant
          (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
          VALUES ($1,$2,$2,'work:create:root',$3,now() + interval '3 hours')`,
        [randomUUID(), subject, action]);
      }
    const fuseki = new FusekiClient(Bun.env.FUSEKI_URL);
    const main = createMainApp(fuseki, { environment: { fuseki,
      lineage: { dataEpoch: Bun.env.MAIN_DATA_EPOCH, routingEpoch: Bun.env.MAIN_ROUTING_EPOCH },
      objectDirectory: join(state, 'objects') },
    account: new AccountAssertionVerifier({ issuer: `${base}/api/auth`,
      audience: Bun.env.ACCOUNT_MAIN_RESOURCE, jwksUrl: `${base}/api/auth/jwks`,
      introspectUrl: `${base}/api/auth/oauth2/introspect`,
      clientId: verifierClient.client_id, clientSecret: verifierClient.client_secret! }),
    access: new AccessAdmissionRegistry(accessPool),
    memberships: new AccessMemberships(accessPool),
    membershipConsents: new AccessMembershipConsents(accessPool),
    representedMembershipAuthority: new AccessRepresentedMembershipAuthority(accessPool) });
    const post = (path: string, token: string, body: object, key = randomUUID()) =>
      main.handle(new Request(`http://main.local${path}`, { method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json',
          'idempotency-key': key }, body: JSON.stringify(body) }));
    const epoch = () => accessPool.query<{ authority_epoch: string }>(`
      SELECT authority_epoch FROM access.scope_gate WHERE id = 'work:create:root'`)
      .then(result => result.rows[0]!.authority_epoch);
    const until = new Date(Date.now() + 60 * 60_000).toISOString();
    const grantId = randomUUID();
    const grant = { profile: 'access-represented-org-grant-change-v1', action: 'grant',
      grantId, issuerSubject: B, ownerSubject: B, recipientSubject: A,
      expectedAuthorityEpoch: await epoch(), validUntil: until };
    const grantResponse = await post('/v1/access/represented-org-grant-changes', bToken, grant);
    expect(grantResponse.status).toBe(200);
    expect(JSON.stringify(await grantResponse.json())).not.toContain(ids[2]!);
    const scope = `access:org-roster:${B.slice(-36)}`;
    await accessPool.query(`INSERT INTO access.principal_permission_grant
      (id, issuer_subject, principal_id, scope_id, action, valid_until)
      VALUES ($1,$2,$3,$4,'access.membership.manage.org',now() + interval '1 hour')`,
    [randomUUID(), B, ids[0], scope]);
    const publishing = (await accessPool.query<{ id: string }>(`
      SELECT id FROM access.representation WHERE principal_id = $1
        AND subject_id = $2 AND action = 'work.create'`, [ids[0], A])).rows[0]!.id;
    const proof = (representationId: string, consentReference: string) => ({
      profile: 'access-represented-org-membership-change-v1', action: 'join',
      ownerSubject: B, memberSubject: C, expectedGeneration: '0',
      expectedPolicyRevision: '1', termsRevision: 'terms-1', consentReference,
      actingSubject: A, representationId, expectedRepresentationGeneration: '0',
      grantId, expectedGrantGeneration: '0', expectedPrincipalEpoch: '0',
      expectedActingGeneration: '0', expectedOwnerGeneration: '0',
      expectedAuthorityEpoch: '' });
    expect((await post('/v1/access/represented-org-membership-changes', pToken,
      { ...proof(publishing, randomUUID()), expectedAuthorityEpoch: await epoch() })).status).toBe(403);
    const requestId = randomUUID();
    const requestBody = { profile: 'access-represented-org-membership-request-v1',
      requestId, actingSubject: A, ownerSubject: B, validUntil: until };
    const requested = await post('/v1/me/represented-org-membership-requests', pToken,
      requestBody, 'request-b');
    expect(requested.status).toBe(200);
    expect(JSON.stringify(await requested.json())).not.toContain(ids[0]!);
    const read = await main.handle(new Request(`http://main.local/v1/access/represented-org-membership-requests/${requestId}?issuerSubject=${encodeURIComponent(A)}`,
      { headers: { authorization: `Bearer ${aToken}` } }));
    expect(read.status).toBe(200);
    const representationId = randomUUID();
    const accept = { profile: 'access-represented-org-mandate-change-v1',
      action: 'accept', issuerSubject: A, ownerSubject: B, requestId,
      representationId, expectedAuthorityEpoch: await epoch() };
    expect((await post('/v1/access/represented-org-mandate-changes', aToken, accept,
      'accept-b')).status).toBe(200);
    const wrongRequest = randomUUID();
    expect((await post('/v1/me/represented-org-membership-requests', pToken,
      { ...requestBody, requestId: wrongRequest, ownerSubject: B2 }, 'request-b2')).status).toBe(200);
    const wrongRepresentation = randomUUID();
    expect((await post('/v1/access/represented-org-mandate-changes', aToken,
      { ...accept, ownerSubject: B2, requestId: wrongRequest,
        representationId: wrongRepresentation, expectedAuthorityEpoch: await epoch() },
      'accept-b2')).status).toBe(200);
    const noConsent = { ...proof(representationId, randomUUID()),
      expectedAuthorityEpoch: await epoch() };
    expect((await post('/v1/access/represented-org-membership-changes', pToken,
      noConsent)).status).toBe(403);
    expect((await post('/v1/access/represented-org-membership-changes', pToken,
      { ...noConsent, representationId: wrongRepresentation })).status).toBe(403);
    expect((await post('/v1/access/represented-org-membership-changes', pToken,
      { ...noConsent, grantId: randomUUID() })).status).toBe(403);
    const consentResponse = await post('/v1/me/membership-consents', targetToken, {
      profile: 'access-membership-consent-v1', kind: 'org', ownerSubject: B,
      memberSubject: C, expectedGeneration: '0', expectedPolicyRevision: '1',
      termsRevision: 'terms-1' });
    expect(consentResponse.status).toBe(200);
    const consent = await consentResponse.json() as { consentReference: string };
    const joinBody = { ...noConsent, consentReference: consent.consentReference,
      expectedAuthorityEpoch: await epoch() };
    const joinedAttempts = await Promise.all([
      post('/v1/access/represented-org-membership-changes', pToken, joinBody, 'join-b'),
      post('/v1/access/represented-org-membership-changes', pToken, joinBody, 'join-b'),
    ]);
    expect(joinedAttempts.map(result => result.status)).toEqual([200, 200]);
    const joined = await Promise.all(joinedAttempts.map(result => result.json())) as
      { membershipId: string; generation: string; replayed: boolean }[];
    expect(joined.map(result => result.generation)).toEqual(['1', '1']);
    expect(joined.map(result => result.replayed).sort()).toEqual([false, true]);
    expect(JSON.stringify(joined)).not.toContain(ids[0]!);
    expect((await post('/v1/access/represented-org-membership-changes', pToken,
      { ...joinBody, memberSubject: B2 }, 'join-b')).status).toBe(409);
    const effect = await accessPool.query<{ changed_by_principal: string;
      acting_subject: string; representation_id: string; grant_id: string }>(`
      SELECT changed_by_principal, acting_subject, representation_id, grant_id
      FROM access.membership_history WHERE membership_id = $1 AND generation = 1`,
    [joined[0]!.membershipId]);
    expect(effect.rows[0]).toMatchObject({ changed_by_principal: ids[0],
      acting_subject: A, representation_id: representationId, grant_id: grantId });
    const selectedProof = [ids[0], '0', grantId, representationId, A, B,
      '0', '0', '0', '0'];
    type PlanNode = { 'Actual Rows'?: number; 'Actual Loops'?: number;
      'Rows Removed by Filter'?: number; 'Relation Name'?: string; Plans?: PlanNode[] };
    async function selectedProofVisits(extraGrants: number): Promise<number> {
      await accessPool.query(`INSERT INTO access.permission_grant
        (id, issuer_subject, recipient_subject, scope_id, action, valid_until,
          assigned_by_principal, represented_issuer_generation,
          represented_recipient_generation)
        SELECT id, $2, $3, $4, 'access.membership.manage.org',
          now() + interval '1 hour', $5, 0, 0 FROM unnest($1::uuid[]) AS t(id)`,
      [Array.from({ length: extraGrants }, () => randomUUID()), B, A, scope, ids[2]]);
      await accessPool.query('ANALYZE access.permission_grant');
      const explained = await accessPool.query<{ 'QUERY PLAN': { Plan: PlanNode }[] }>(
        `EXPLAIN (ANALYZE, BUFFERS, WAL, FORMAT JSON, TIMING OFF) ${REPRESENTED_ORG_MANAGER_SQL}`,
        selectedProof);
      const plan = explained.rows[0]?.['QUERY PLAN'][0]?.Plan;
      expect(plan).toBeDefined();
      let visits = 0;
      function count(node: PlanNode): void {
        if (node['Relation Name'] === 'permission_grant'
          || node['Relation Name'] === 'representation') {
          visits += ((node['Actual Rows'] ?? 0) + (node['Rows Removed by Filter'] ?? 0))
            * (node['Actual Loops'] ?? 1);
        }
        for (const child of node.Plans ?? []) count(child);
      }
      count(plan!);
      return visits;
    }
    // A sequential scan over a tiny relation is acceptable; it must switch
    // to bounded selected-row work when unrelated grant history grows.
    expect(await selectedProofVisits(64)).toBeLessThanOrEqual(80);
    expect(await selectedProofVisits(15_936)).toBeLessThanOrEqual(16);
    await accessPool.query(`UPDATE access.membership_policy SET revision = 2
      WHERE kind = 'org' AND owner_subject = $1`, [B]);
    const oldPolicyLeave = { ...joinBody, action: 'leave', expectedGeneration: '1' };
    delete (oldPolicyLeave as { consentReference?: string }).consentReference;
    delete (oldPolicyLeave as { termsRevision?: string }).termsRevision;
    expect((await post('/v1/access/represented-org-membership-changes', pToken,
      { ...oldPolicyLeave, expectedAuthorityEpoch: await epoch() })).status).toBe(409);
    const expiringGrantId = randomUUID();
    const expiresAt = new Date(Date.now() + 3000);
    expect((await post('/v1/access/represented-org-grant-changes', bToken,
      { ...grant, grantId: expiringGrantId, expectedAuthorityEpoch: await epoch(),
        validUntil: expiresAt.toISOString() })).status).toBe(200);
    await Bun.sleep(Math.max(0, expiresAt.getTime() - Date.now() + 25));
    const expiredGrantLeave = { ...oldPolicyLeave, expectedPolicyRevision: '2',
      grantId: expiringGrantId, expectedAuthorityEpoch: await epoch() };
    expect((await post('/v1/access/represented-org-membership-changes', pToken,
      expiredGrantLeave)).status).toBe(403);
    await accessPool.query('UPDATE access.principal SET active = false WHERE id = $1', [ids[0]]);
    expect((await post('/v1/access/represented-org-membership-changes', pToken,
      { ...expiredGrantLeave, grantId, expectedPrincipalEpoch: '1',
        expectedAuthorityEpoch: await epoch() })).status).toBe(403);
    await accessPool.query('UPDATE access.principal SET active = true WHERE id = $1', [ids[0]]);
    const renewedRequestId = randomUUID();
    expect((await post('/v1/me/represented-org-membership-requests', pToken,
      { ...requestBody, requestId: renewedRequestId }, 'request-renewed')).status).toBe(200);
    const renewedRepresentationId = randomUUID();
    expect((await post('/v1/access/represented-org-mandate-changes', aToken,
      { ...accept, requestId: renewedRequestId, representationId: renewedRepresentationId,
        expectedAuthorityEpoch: await epoch() }, 'accept-renewed')).status).toBe(200);
    const leave = { ...oldPolicyLeave, expectedPolicyRevision: '2',
      representationId: renewedRepresentationId, expectedPrincipalEpoch: '2' };
    expect((await post('/v1/access/represented-org-membership-changes', pToken,
      { ...leave, expectedAuthorityEpoch: await epoch(),
        expectedRepresentationGeneration: '9' })).status).toBe(403);
    expect((await post('/v1/access/represented-org-membership-changes', pToken,
      { ...leave, expectedAuthorityEpoch: await epoch(),
        expectedGrantGeneration: '9' })).status).toBe(403);
    await accessPool.query(`UPDATE access.authority_subject SET active = false WHERE id = $1`, [A]);
    await accessPool.query(`UPDATE access.authority_subject SET active = true WHERE id = $1`, [A]);
    expect((await post('/v1/access/represented-org-membership-changes', pToken,
      { ...leave, expectedAuthorityEpoch: await epoch(),
        expectedActingGeneration: '2' })).status).toBe(403);
    await accessPool.query(`UPDATE access.private_membership SET state = 'left',
      generation = generation + 1, terms_revision = NULL, consent_reference = NULL
      WHERE principal_id = $1 AND owner_subject = $2`, [ids[0], A]);
    expect((await post('/v1/access/represented-org-membership-changes', pToken,
      { ...leave, expectedAuthorityEpoch: await epoch() })).status).toBe(403);
    await accessPool.query(`UPDATE access.private_membership SET state = 'joined',
      generation = generation + 1, terms_revision = 'terms-1', consent_reference = $3
      WHERE principal_id = $1 AND owner_subject = $2`, [ids[0], A, pConsent]);
    expect((await post('/v1/access/represented-org-membership-changes', pToken,
      { ...leave, expectedAuthorityEpoch: await epoch() })).status).toBe(403);
    await expect(accessPool.query(`UPDATE access.representation
      SET represented_subject_generation = 2 WHERE id = $1`, [renewedRepresentationId])).rejects.toThrow();
    await expect(accessPool.query(`UPDATE access.permission_grant
      SET represented_recipient_generation = 2 WHERE id = $1`, [grantId])).rejects.toThrow();
    const revokeGrant = { profile: 'access-represented-org-grant-change-v1',
      action: 'revoke', issuerSubject: B, ownerSubject: B, grantId,
      expectedAuthorityEpoch: await epoch(), expectedObjectGeneration: '0' };
    expect((await post('/v1/access/represented-org-grant-changes', bToken,
      revokeGrant, 'revoke-grant-b')).status).toBe(200);
    expect((await post('/v1/access/represented-org-grant-changes', bToken,
      revokeGrant, 'revoke-grant-b')).status).toBe(200);
    const revokeMandate = { profile: 'access-represented-org-mandate-change-v1',
      action: 'revoke', issuerSubject: A, ownerSubject: B, representationId: renewedRepresentationId,
      expectedAuthorityEpoch: await epoch(), expectedObjectGeneration: '0' };
    expect((await post('/v1/access/represented-org-mandate-changes', aToken,
      revokeMandate, 'revoke-mandate-b')).status).toBe(200);
    await expect(accessPool.query('UPDATE access.representation SET active = true WHERE id = $1',
      [renewedRepresentationId])).rejects.toThrow();
    await expect(accessPool.query('UPDATE access.permission_grant SET active = true WHERE id = $1',
      [grantId])).rejects.toThrow();
    const lostReply = await post('/v1/access/represented-org-membership-changes',
      pToken, joinBody, 'join-b');
    expect(lostReply.status).toBe(200);
    expect((await lostReply.json() as { replayed: boolean }).replayed).toBe(true);
    await accessPool.query('UPDATE access.recovery_fence SET open = false WHERE id = true');
    expect((await post('/v1/access/represented-org-membership-changes', pToken,
      { ...leave, expectedAuthorityEpoch: await epoch() })).status).toBe(503);
    await accessPool.query('UPDATE access.recovery_fence SET open = true WHERE id = true');
  } finally {
    await account.stop();
    await Promise.all([accountPool.end(), accessPool.end()]);
    await databases.close();
    rmSync(state, { recursive: true, force: true });
  }
}, 180_000);
