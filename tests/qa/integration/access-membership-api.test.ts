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
import { AccessMemberships } from '../../../services/main/src/modules/access/memberships.ts';
import { AccountAssertionVerifier } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { accessStateCoverage } from '../../../services/main/src/modules/work/access-recovery-coverage.ts';

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

test('IAM06: Org/Realm leave and rejoin fence dependent grants but retain bans', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.FUSEKI_URL || !Bun.env.MAIN_DATA_EPOCH
    || !Bun.env.MAIN_ROUTING_EPOCH || !Bun.env.ACCESS_DATABASE_URL
    || !Bun.env.ACCOUNT_DATABASE_URL || !Bun.env.ACCOUNT_MAIN_RESOURCE) {
    throw new Error('Run through the isolated QA integration tier');
  }
  const state = join(root, '.temp', `membership-api-${randomUUID()}`);
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
      const email = `membership-${name}-${randomUUID()}@example.test`;
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
      client_name: 'Membership verifier', scope: 'access:manage access:grant work:create',
      token_endpoint_auth_method: 'client_secret_post', grant_types: ['client_credentials'],
      client_credentials_scopes: ['access:manage', 'access:grant', 'work:create'] } });
    const redirectUri = 'http://localhost:3000/auth/callback';
    const oauthClient = await auth.api.adminCreateOAuthClient({ headers, body: {
      client_name: 'Membership native client', application_type: 'native',
      redirect_uris: [redirectUri], token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'],
      scope: 'openid access:manage access:grant work:create',
      skip_consent: true, require_pkce: true } });
    async function tokenFor(user: { email: string; password: string }, scope: string) {
      const signIn = await fetch(`${base}/api/auth/sign-in/email`, { method: 'POST',
        headers: { 'content-type': 'application/json', origin: base },
        body: JSON.stringify({ email: user.email, password: user.password }) });
      expect(signIn.status).toBe(200);
      const verifier = randomBytes(32).toString('base64url');
      const authorize = new URL(`${base}/api/auth/oauth2/authorize`);
      for (const [key, value] of Object.entries({ response_type: 'code',
        client_id: oauthClient.client_id, redirect_uri: redirectUri, scope,
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
        body: new URLSearchParams({ grant_type: 'authorization_code',
          client_id: oauthClient.client_id, code, redirect_uri: redirectUri,
          code_verifier: verifier, resource: Bun.env.ACCOUNT_MAIN_RESOURCE }) });
      expect(exchange.status).toBe(200);
      return (await exchange.json() as { access_token: string }).access_token;
    }
    const manager = await signUp('manager');
    const outsider = await signUp('outsider');
    const token = await tokenFor(manager, 'openid access:manage access:grant work:create');
    const noScopeToken = await tokenFor(outsider, 'openid work:create');
    const outsiderToken = await tokenFor(outsider, 'openid access:manage');
    const org = `https://rezics.com/id/${randomUUID()}`;
    const realm = `https://rezics.com/id/${randomUUID()}`;
    const member = `https://rezics.com/id/${randomUUID()}`;
    const issuer = `https://rezics.com/id/${randomUUID()}`;
    const principalId = randomUUID();
    await accessPool.query(`INSERT INTO access.principal
      (id, account_issuer, account_subject) VALUES ($1,$2,$3)`,
    [principalId, `${base}/api/auth`, manager.id]);
    await accessPool.query(`INSERT INTO access.authority_subject (id, kind) VALUES
      ($1,'agent'),($2,'agent'),($3,'agent'),($4,'agent')`, [org, realm, member, issuer]);
    await accessPool.query("INSERT INTO access.scope_gate (id) VALUES ('work:create:root') ON CONFLICT DO NOTHING");
    await accessPool.query(`INSERT INTO access.membership_policy
      (kind, owner_subject, revision, terms_revision) VALUES
      ('org',$1,1,'org-terms-1'),('realm',$2,1,'realm-terms-1')`, [org, realm]);
    for (const [subject, action] of [
      [org, 'access.membership.manage.org'],
      [realm, 'access.membership.manage.realm'],
      [issuer, 'access.grant.assign.work.create'],
      [member, 'work.create'],
    ]) {
      await accessPool.query(`INSERT INTO access.representation
        (id, principal_id, subject_id, action, valid_until) VALUES
        ($1,$2,$3,$4,now() + interval '1 hour')`,
      [randomUUID(), principalId, subject, action]);
    }
    for (const [subject, action] of [
      [org, 'access.membership.manage.org'],
      [realm, 'access.membership.manage.realm'],
      [issuer, 'access.grant.assign.work.create'],
    ]) {
      await accessPool.query(`INSERT INTO access.permission_grant
        (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
        VALUES ($1,$2,$2,'work:create:root',$3,now() + interval '1 hour')`,
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
    actingContexts: new AccessActingContexts(accessPool),
    grants: new AccessGrants(accessPool), memberships: new AccessMemberships(accessPool) });
    const request = (path: string, bearer: string, body: object, key = randomUUID()) =>
      main.handle(new Request(`http://main.local${path}`, { method: 'POST',
        headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json',
          'idempotency-key': key }, body: JSON.stringify(body) }));
    const path = '/v1/access/membership-changes';
    const joinBody = (kind: 'org' | 'realm', ownerSubject: string,
      expectedGeneration: string, expectedPolicyRevision = '1') => ({
      profile: 'access-membership-change-v1', kind, ownerSubject, memberSubject: member,
      action: 'join', expectedGeneration, expectedPolicyRevision,
      termsRevision: kind === 'org' ? 'org-terms-1' : 'realm-terms-1',
      consentReference: `account-consent-${manager.id}` });
    const leaveBody = (kind: 'org' | 'realm', ownerSubject: string,
      expectedGeneration: string) => ({ profile: 'access-membership-change-v1',
      kind, ownerSubject, memberSubject: member, action: 'leave',
      expectedGeneration, expectedPolicyRevision: '1' });
    const orgJoin = joinBody('org', org, '0');
    const beforeMembership = await accessStateCoverage(accessPool);
    expect((await request(path, noScopeToken, orgJoin)).status).toBe(401);
    expect((await request(path, outsiderToken, orgJoin)).status).toBe(403);
    expect((await request(path, token, joinBody('org', org, '0', '0'))).status).toBe(409);
    expect((await request(path, token, { ...orgJoin,
      termsRevision: 'obsolete-org-terms' })).status).toBe(403);
    const joinKey = randomUUID();
    const joinedResponse = await request(path, token, orgJoin, joinKey);
    expect(joinedResponse.status).toBe(200);
    const joined = await joinedResponse.json() as { membershipId: string; generation: string;
      authorityEpoch: string; replayed: boolean };
    expect(joined).toMatchObject({ generation: '1', replayed: false });
    expect(await accessStateCoverage(accessPool)).not.toEqual(beforeMembership);
    const replay = await request(path, token, orgJoin, joinKey);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ membershipId: joined.membershipId,
      generation: '1', authorityEpoch: joined.authorityEpoch, replayed: true });
    expect((await request(path, token, { ...orgJoin, consentReference: 'different' }, joinKey)).status).toBe(409);
    const realmJoinedResponse = await request(path, token, joinBody('realm', realm, '0'));
    expect(realmJoinedResponse.status).toBe(200);
    const realmJoined = await realmJoinedResponse.json() as { membershipId: string;
      generation: string; authorityEpoch: string };
    expect(realmJoined.generation).toBe('1');
    const currentEpoch = () => accessPool.query<{ authority_epoch: string }>(`
      SELECT authority_epoch FROM access.scope_gate WHERE id = 'work:create:root'`)
      .then(result => result.rows[0]!.authority_epoch);
    const grantId = randomUUID();
    const grantBody = (membershipId: string, generation: string, grant: string) => ({
      profile: 'work-create-agent-grant-change-v1', action: 'create',
      issuerSubject: issuer, expectedAuthorityEpoch: '', grantId: grant,
      recipientSubject: member, validUntil: new Date(Date.now() + 30 * 60_000).toISOString(),
      membershipDependency: { membershipId, generation } });
    const grant = { ...grantBody(joined.membershipId, '1', grantId),
      expectedAuthorityEpoch: await currentEpoch() };
    expect((await request('/v1/access/grant-changes', token, grant)).status).toBe(200);
    const selected = async () => request('/v1/me/acting-context-checks', token, {
      profile: 'work-create-acting-context-check-v1', task: 'work.create',
      actingSubject: member, expectedAuthorityEpoch: await currentEpoch() });
    expect((await selected()).status).toBe(200);
    await accessPool.query(`INSERT INTO access.membership_ban
      (kind, owner_subject, member_subject, reason_ref) VALUES ('org',$1,$2,'case-1')`,
    [org, member]);
    const leaveKey = randomUUID();
    const leftResponse = await request(path, token, leaveBody('org', org, '1'), leaveKey);
    expect(leftResponse.status).toBe(200);
    const left = await leftResponse.json() as { generation: string; authorityEpoch: string };
    expect(left.generation).toBe('2');
    expect((await selected()).status).toBe(403);
    expect((await request(path, token, leaveBody('org', org, '1'), leaveKey)).status).toBe(200);
    expect((await request(path, token, joinBody('org', org, '1'))).status).toBe(409);
    expect((await request(path, token, joinBody('org', org, '2'))).status).toBe(403);
    expect((await accessPool.query<{ active: boolean }>(`SELECT active FROM access.membership_ban
      WHERE kind = 'org' AND owner_subject = $1 AND member_subject = $2`,
    [org, member])).rows[0]?.active).toBe(true);
    expect((await accessPool.query<{ active: boolean }>(`
      SELECT active FROM access.permission_grant WHERE id = $1`, [grantId])).rows[0]?.active).toBe(false);
    await expect(accessPool.query(`UPDATE access.permission_grant SET active = true
      WHERE id = $1`, [grantId])).rejects.toThrow();
    await accessPool.query(`UPDATE access.membership_ban SET active = false
      WHERE kind = 'org' AND owner_subject = $1 AND member_subject = $2`, [org, member]);
    const rejoinedResponse = await request(path, token, joinBody('org', org, '2'));
    expect(rejoinedResponse.status).toBe(200);
    const rejoined = await rejoinedResponse.json() as { generation: string };
    expect(rejoined.generation).toBe('3');
    expect((await selected()).status).toBe(403);
    const staleGrant = { ...grantBody(joined.membershipId, '1', randomUUID()),
      expectedAuthorityEpoch: await currentEpoch() };
    expect((await request('/v1/access/grant-changes', token, staleGrant)).status).toBe(403);
    const newGrant = { ...grantBody(joined.membershipId, '3', randomUUID()),
      expectedAuthorityEpoch: await currentEpoch() };
    expect((await request('/v1/access/grant-changes', token, newGrant)).status).toBe(200);
    expect((await selected()).status).toBe(200);
    const realmGrantId = randomUUID();
    const realmGrant = { ...grantBody(realmJoined.membershipId, '1', realmGrantId),
      expectedAuthorityEpoch: await currentEpoch() };
    expect((await request('/v1/access/grant-changes', token, realmGrant)).status).toBe(200);
    await accessPool.query(`INSERT INTO access.membership_ban
      (kind, owner_subject, member_subject, reason_ref) VALUES ('realm',$1,$2,'case-2')`,
    [realm, member]);
    await accessPool.query(`UPDATE access.membership_policy SET open = false
      WHERE kind = 'realm' AND owner_subject = $1`, [realm]);
    const [leftRealm1, leftRealm2] = await Promise.all([
      request(path, token, leaveBody('realm', realm, '1')),
      request(path, token, leaveBody('realm', realm, '1')),
    ]);
    expect([leftRealm1.status, leftRealm2.status].sort()).toEqual([200, 409]);
    expect((await accessPool.query<{ generation: string; state: string }>(`
      SELECT generation, state FROM access.membership WHERE id = $1`,
    [realmJoined.membershipId])).rows[0]).toMatchObject({ generation: '2', state: 'left' });
    expect((await accessPool.query<{ active: boolean }>(`
      SELECT active FROM access.permission_grant WHERE id = $1`,
    [realmGrantId])).rows[0]?.active).toBe(false);
    expect((await selected()).status).toBe(200);
    await accessPool.query(`UPDATE access.membership_policy SET open = true
      WHERE kind = 'realm' AND owner_subject = $1`, [realm]);
    expect((await request(path, token, joinBody('realm', realm, '2'))).status).toBe(403);
    expect((await accessPool.query<{ active: boolean }>(`SELECT active FROM access.membership_ban
      WHERE kind = 'realm' AND owner_subject = $1 AND member_subject = $2`,
    [realm, member])).rows[0]?.active).toBe(true);
    await accessPool.query(`UPDATE access.membership_ban SET active = false
      WHERE kind = 'realm' AND owner_subject = $1 AND member_subject = $2`, [realm, member]);
    const realmRejoined = await request(path, token, joinBody('realm', realm, '2'));
    expect(realmRejoined.status).toBe(200);
    expect(await realmRejoined.json()).toMatchObject({ generation: '3' });
    expect((await accessPool.query<{ active: boolean }>(`
      SELECT active FROM access.permission_grant WHERE id = $1`,
    [realmGrantId])).rows[0]?.active).toBe(false);
    await accessPool.query(`INSERT INTO access.permission_grant
      (id, issuer_subject, recipient_subject, scope_id, action, valid_until,
        membership_id, membership_generation)
      SELECT gen_random_uuid(), $1, $2, 'work:create:root', 'work.create',
        now() + interval '30 minutes', $3, 3 FROM generate_series(1, 257)`,
    [issuer, member, realmJoined.membershipId]);
    expect((await request(path, token, leaveBody('realm', realm, '3'))).status).toBe(503);
    expect((await accessPool.query<{ generation: string; state: string }>(`
      SELECT generation, state FROM access.membership WHERE id = $1`,
    [realmJoined.membershipId])).rows[0]).toMatchObject({ generation: '3', state: 'joined' });
    expect((await accessPool.query<{ generation: string }>(`
      SELECT generation FROM access.membership WHERE id = $1`,
    [joined.membershipId])).rows[0]?.generation).toBe('3');
    await expect(accessPool.query(`UPDATE access.membership_history SET state = 'left'
      WHERE membership_id = $1 AND generation = 1`, [joined.membershipId])).rejects.toThrow();
    await accessPool.query('UPDATE access.recovery_fence SET open = false WHERE id = true');
    expect((await request(path, token, leaveBody('realm', realm, '3'))).status).toBe(503);
    await accessPool.query('UPDATE access.recovery_fence SET open = true WHERE id = true');
  } finally {
    await account.stop();
    await Promise.all([accountPool.end(), accessPool.end()]);
    rmSync(state, { recursive: true, force: true });
  }
}, 180_000);
