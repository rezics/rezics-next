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
