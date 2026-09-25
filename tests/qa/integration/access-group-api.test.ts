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
import { AccessGroups } from '../../../services/main/src/modules/access/groups.ts';
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

test('IAM05/IAM36: admitted group API preserves receipts, ceilings and selected proof', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.FUSEKI_URL || !Bun.env.MAIN_DATA_EPOCH
    || !Bun.env.MAIN_ROUTING_EPOCH || !Bun.env.ACCESS_DATABASE_URL
    || !Bun.env.ACCOUNT_DATABASE_URL || !Bun.env.ACCOUNT_MAIN_RESOURCE) {
    throw new Error('Run through the isolated QA integration tier');
  }
  const state = join(root, '.temp', `group-api-${randomUUID()}`);
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
      const email = `groups-${name}-${randomUUID()}@example.test`;
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
    const mainClient = await auth.api.adminCreateOAuthClient({ headers, body: {
      client_name: 'Group API verifier', scope: 'access:manage',
      token_endpoint_auth_method: 'client_secret_post', grant_types: ['client_credentials'],
      client_credentials_scopes: ['access:manage'] } });
    const redirectUri = 'http://localhost:3000/auth/callback';
    const scope = 'openid access:manage work:create';
    const client = await auth.api.adminCreateOAuthClient({ headers, body: {
      client_name: 'Group API browser', application_type: 'native',
      redirect_uris: [redirectUri], token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'], scope, skip_consent: true, require_pkce: true } });
    const member = await signUp('member');
    const manager = `https://rezics.com/id/${randomUUID()}`;
    const subject = `https://rezics.com/id/${randomUUID()}`;
    const principalId = randomUUID();
    await accessPool.query('INSERT INTO access.principal (id, account_issuer, account_subject) VALUES ($1,$2,$3)',
      [principalId, `${base}/api/auth`, member.id]);
    await accessPool.query("INSERT INTO access.authority_subject (id, kind) VALUES ($1,'agent'),($2,'agent')",
      [manager, subject]);
    const signIn = await fetch(`${base}/api/auth/sign-in/email`, { method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ email: member.email, password: member.password }) });
    expect(signIn.status).toBe(200);
    const verifier = randomBytes(32).toString('base64url');
    const authorize = new URL(`${base}/api/auth/oauth2/authorize`);
    for (const [key, value] of Object.entries({ response_type: 'code',
      client_id: client.client_id, redirect_uri: redirectUri, scope, state: randomUUID(),
      resource: Bun.env.ACCOUNT_MAIN_RESOURCE,
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
    const token = (await exchange.json() as { access_token: string }).access_token;
    const fuseki = new FusekiClient(Bun.env.FUSEKI_URL);
    const dependencies = { environment: { fuseki,
      lineage: { dataEpoch: Bun.env.MAIN_DATA_EPOCH, routingEpoch: Bun.env.MAIN_ROUTING_EPOCH },
      objectDirectory: join(state, 'objects') },
    account: new AccountAssertionVerifier({ issuer: `${base}/api/auth`,
      audience: Bun.env.ACCOUNT_MAIN_RESOURCE, jwksUrl: `${base}/api/auth/jwks`,
      introspectUrl: `${base}/api/auth/oauth2/introspect`,
      clientId: mainClient.client_id, clientSecret: mainClient.client_secret! }),
    access: new AccessAdmissionRegistry(accessPool),
    actingContexts: new AccessActingContexts(accessPool), groups: new AccessGroups(accessPool) };
    let main = createMainApp(fuseki, dependencies);
    const request = (method: string, path: string, body?: object,
      key = `group-${randomUUID()}`, bearer = token) => main.handle(new Request(`http://main.local${path}`, {
        method, headers: { authorization: `Bearer ${bearer}`,
          ...(body ? { 'content-type': 'application/json', 'idempotency-key': key } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }));
    const scopePath = `/v1/access/group-scope?issuerSubject=${encodeURIComponent(manager)}`;
    expect((await request('GET', scopePath, undefined, '', 'invalid')).status).toBe(401);
    expect((await request('GET', scopePath)).status).toBe(403);
    await accessPool.query("INSERT INTO access.scope_gate (id) VALUES ('work:create:root') ON CONFLICT DO NOTHING");
    await accessPool.query(`INSERT INTO access.representation
      (id, principal_id, subject_id, action, valid_until) VALUES
      ($1,$2,$3,'access.group.manage',now() + interval '1 hour'),
      ($4,$2,$5,'work.create',now() + interval '1 hour')`,
    [randomUUID(), principalId, manager, randomUUID(), subject]);
    await accessPool.query(`INSERT INTO access.permission_grant
      (id, issuer_subject, recipient_subject, scope_id, action, valid_until) VALUES
      ($1,$2,$2,'work:create:root','access.group.manage',now() + interval '1 hour'),
      ($3,$2,$2,'work:create:root','access.group.assign.work.create',now() + interval '1 hour')`,
    [randomUUID(), manager, randomUUID()]);
    const readGeneration = async () => {
      const response = await request('GET', scopePath);
      expect(response.status).toBe(200);
      return await response.json() as { groupGeneration: string;
        groups: { id: string; parentId: string | null; generation: string }[];
        members: { id: string; groupId: string; generation: string }[];
        grants: { id: string; groupId: string; generation: string }[] };
    };
    let generation = (await readGeneration()).groupGeneration;
    const command = (action: string, fields: Record<string, unknown>, expected = generation) => ({
      profile: 'work-create-group-change-v1', issuerSubject: manager,
      expectedGroupGeneration: expected, action, ...fields });
    const rootGroup = randomUUID();
    const createRoot = command('create', { groupId: rootGroup, parentId: null });
    const rootKey = `root-${randomUUID()}`;
    const first = await request('POST', '/v1/access/group-changes', createRoot, rootKey);
    expect(first.status).toBe(200);
    generation = (await first.json() as { groupGeneration: string }).groupGeneration;
    main = createMainApp(fuseki, { ...dependencies, groups: new AccessGroups(accessPool) });
    const replay = await request('POST', '/v1/access/group-changes', createRoot, rootKey);
    expect(replay.status).toBe(200);
    expect((await replay.json() as { groupGeneration: string }).groupGeneration).toBe(generation);
    expect((await request('POST', '/v1/access/group-changes',
      { ...createRoot, groupId: randomUUID() }, rootKey)).status).toBe(409);
    const a = randomUUID(), b = randomUUID();
    const [left, right] = await Promise.all([
      request('POST', '/v1/access/group-changes', command('create', { groupId: a, parentId: null })),
      request('POST', '/v1/access/group-changes', command('create', { groupId: b, parentId: null })),
    ]);
    expect([left.status, right.status].sort()).toEqual([200, 409]);
    const child = left.status === 200 ? a : b;
    generation = (await readGeneration()).groupGeneration;
    const reparent = await request('POST', '/v1/access/group-changes',
      command('reparent', { groupId: child, expectedObjectGeneration: '0', parentId: rootGroup }));
    expect(reparent.status).toBe(200);
    generation = (await reparent.json() as { groupGeneration: string }).groupGeneration;
    const invalidLifetime = await request('POST', '/v1/access/group-changes',
      command('grant', { grantId: randomUUID(), groupId: rootGroup,
        validUntil: new Date(Date.now() + 2 * 60 * 60_000).toISOString() }));
    expect(invalidLifetime.status).toBe(403);
    const grantId = randomUUID();
    const granted = await request('POST', '/v1/access/group-changes',
      command('grant', { grantId, groupId: rootGroup,
        validUntil: new Date(Date.now() + 30 * 60_000).toISOString() }));
    expect(granted.status).toBe(200);
    generation = (await granted.json() as { groupGeneration: string }).groupGeneration;
    const memberId = randomUUID();
    const added = await request('POST', '/v1/access/group-changes',
      command('add-member', { memberId, groupId: child, agentSubject: subject }));
    expect(added.status).toBe(200);
    generation = (await added.json() as { groupGeneration: string }).groupGeneration;
    const groupState = await readGeneration();
    expect(groupState.groupGeneration).toBe(generation);
    expect(groupState.groups.find(group => group.id === child)).toEqual({
      id: child, parentId: rootGroup, generation: '1' });
    expect(groupState.members.find(member => member.id === memberId)).toMatchObject({
      id: memberId, groupId: child, generation: '0' });
    expect(groupState.grants.find(grant => grant.id === grantId)).toMatchObject({
      id: grantId, groupId: rootGroup, generation: '0' });
    const authorityEpoch = (await accessPool.query<{ authority_epoch: string }>(
      "SELECT authority_epoch FROM access.scope_gate WHERE id = 'work:create:root'"))
      .rows[0]!.authority_epoch;
    const selected = { profile: 'work-create-acting-context-check-v1', task: 'work.create',
      actingSubject: subject, expectedAuthorityEpoch: authorityEpoch };
    expect((await request('POST', '/v1/me/acting-context-checks', selected)).status).toBe(200);
    expect((await request('POST', '/v1/access/group-changes', command('reparent', {
      groupId: child, expectedObjectGeneration: '1', parentId: null }))).status).toBe(403);
    const revoked = await request('POST', '/v1/access/group-changes', command('revoke-member', {
      memberId, expectedObjectGeneration: '0' }));
    expect(revoked.status).toBe(200);
    generation = (await revoked.json() as { groupGeneration: string }).groupGeneration;
    expect((await request('POST', '/v1/me/acting-context-checks', selected)).status).toBe(403);
    expect((await readGeneration()).members.some(member => member.id === memberId)).toBe(false);
    const expiringGrantId = randomUUID();
    const expiringGrant = command('grant', { grantId: expiringGrantId, groupId: rootGroup,
      validUntil: new Date(Date.now() + 2_000).toISOString() });
    const expiringKey = `expiry-${randomUUID()}`;
    const expiringFirst = await request('POST', '/v1/access/group-changes', expiringGrant, expiringKey);
    expect(expiringFirst.status).toBe(200);
    const expiringGeneration = (await expiringFirst.json() as { groupGeneration: string }).groupGeneration;
    await Bun.sleep(2_050);
    const expiringReplay = await request('POST', '/v1/access/group-changes', expiringGrant, expiringKey);
    expect(expiringReplay.status).toBe(200);
    expect((await expiringReplay.json() as { groupGeneration: string }).groupGeneration)
      .toBe(expiringGeneration);
    expect((await readGeneration()).grants.some(grant => grant.id === expiringGrantId)).toBe(false);
    await expect(accessPool.query(`UPDATE access.group_change_receipt
      SET result_generation = 0 WHERE idempotency_key = $1`, [rootKey])).rejects.toThrow();
    const existingGroups = Number((await accessPool.query<{ count: string }>(
      "SELECT count(*) AS count FROM access.recipient_group WHERE scope_id = 'work:create:root'"))
      .rows[0]!.count);
    await accessPool.query(`INSERT INTO access.recipient_group (id, scope_id)
      SELECT gen_random_uuid(), 'work:create:root' FROM generate_series(1, $1::integer)`,
    [257 - existingGroups]);
    expect((await request('GET', scopePath)).status).toBe(503);
  } finally {
    await account.stop();
    await Promise.all([accountPool.end(), accessPool.end()]);
    rmSync(state, { recursive: true, force: true });
  }
}, 180_000);
