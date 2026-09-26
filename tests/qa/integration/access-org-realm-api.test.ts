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
import { AccessOrgRealmParticipation } from '../../../services/main/src/modules/access/org-realm-participation.ts';
import { ORG_REALM_ACTION } from '../../../services/main/src/modules/access/org-realm-authority.ts';
import { AccountAssertionVerifier } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { accessStateCoverage } from '../../../services/main/src/modules/work/access-recovery-coverage.ts';
import { cloneQaAccountAccessDatabases } from '../support/databases.ts';
import { seedOrgRealm } from '../support/org-realm.ts';

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

test('IAM23/IAM24/IAM06: independent Org/Realm participation requires two exact authorities', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.FUSEKI_URL || !Bun.env.ACCOUNT_MAIN_RESOURCE) {
    throw new Error('Run through the isolated QA integration tier');
  }
  const state = join(root, '.temp', `org-realm-api-${randomUUID()}`);
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
      const email = `org-realm-${name}-${randomUUID()}@example.test`;
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
      client_name: 'Org Realm verifier', scope: 'access:manage work:create',
      token_endpoint_auth_method: 'client_secret_post', grant_types: ['client_credentials'],
      client_credentials_scopes: ['access:manage', 'work:create'] } });
    const redirectUri = 'http://localhost:3000/auth/callback';
    const oauthClient = await auth.api.adminCreateOAuthClient({ headers, body: {
      client_name: 'Org Realm native client', application_type: 'native',
      redirect_uris: [redirectUri], token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'], scope: 'openid access:manage work:create',
      skip_consent: true, require_pkce: true } });
    async function tokenFor(user: { email: string; password: string }, scope = 'openid access:manage work:create') {
      const signIn = await fetch(`${base}/api/auth/sign-in/email`, { method: 'POST',
        headers: { 'content-type': 'application/json', origin: base },
        body: JSON.stringify({ email: user.email, password: user.password }) });
      expect(signIn.status).toBe(200);
      const verifier = randomBytes(32).toString('base64url');
      const authorize = new URL(`${base}/api/auth/oauth2/authorize`);
      for (const [key, value] of Object.entries({ response_type: 'code',
        client_id: oauthClient.client_id, redirect_uri: redirectUri, scope,
        state: randomUUID(), resource: Bun.env.ACCOUNT_MAIN_RESOURCE,
        code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
      })) authorize.searchParams.set(key, value);
      const authorized = await fetch(authorize, {
        headers: { cookie: signIn.headers.get('set-cookie')! }, redirect: 'manual' });
      expect(authorized.status).toBe(302);
      const code = new URL(authorized.headers.get('location')!).searchParams.get('code')!;
      const exchange = await fetch(`${base}/api/auth/oauth2/token`, { method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', client_id: oauthClient.client_id,
          code, redirect_uri: redirectUri, code_verifier: verifier, resource: Bun.env.ACCOUNT_MAIN_RESOURCE }) });
      expect(exchange.status).toBe(200);
      return (await exchange.json() as { access_token: string }).access_token;
    }
    const realmUser = await signUp('realm'), orgUser = await signUp('org');
    const outsider = await signUp('outsider');
    const realmToken = await tokenFor(realmUser), orgToken = await tokenFor(orgUser);
    const outsiderToken = await tokenFor(outsider), noScope = await tokenFor(outsider, 'openid');
    const fixture = await seedOrgRealm(accessPool, `${base}/api/auth`, { realm: realmUser.id, org: orgUser.id });
    const { realm, org, otherRealm, realmManager, authority } = fixture;
    const counts = { calls: 0, rows: 0 };
    let observeQuery: ((sql: string, parameters?: unknown[]) => void) | undefined;
    const measuredPool = { connect: async () => {
      const client = await accessPool.connect();
      return { query: async (sql: string, parameters?: unknown[]) => {
        counts.calls++;
        observeQuery?.(sql, parameters);
        const result = await client.query(sql, parameters);
        counts.rows += result.rows.length;
        return result;
      }, release: () => client.release() };
    } } as unknown as Pool;
    const owner = new AccessOrgRealmParticipation(measuredPool);
    const fuseki = new FusekiClient(Bun.env.FUSEKI_URL);
    const admission = new AccessAdmissionRegistry(accessPool);
    const main = createMainApp(fuseki, { environment: { fuseki,
      lineage: { dataEpoch: Bun.env.MAIN_DATA_EPOCH!, routingEpoch: Bun.env.MAIN_ROUTING_EPOCH! },
      objectDirectory: join(state, 'objects') },
    account: new AccountAssertionVerifier({ issuer: `${base}/api/auth`,
      audience: Bun.env.ACCOUNT_MAIN_RESOURCE, jwksUrl: `${base}/api/auth/jwks`,
      introspectUrl: `${base}/api/auth/oauth2/introspect`,
      clientId: verifierClient.client_id, clientSecret: verifierClient.client_secret! }),
    access: admission, orgRealmParticipation: owner });
    const post = (path: string, bearer: string, body: object, key = randomUUID()) =>
      main.handle(new Request(`http://main.local${path}`, { method: 'POST',
        headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json',
          'idempotency-key': key }, body: JSON.stringify(body) }));
    const proposals = '/v1/access/org-realm-proposals', changes = '/v1/access/org-realm-changes';
    const basis = (generation: string, target = realm, revision = '1') => ({ realm: target,
      organizationSubject: org, expectedGeneration: generation, expectedPolicyRevision: revision });
    const proposalBody = (generation: string, target = realm, revision = '1', terms = 'terms-1') => ({
      ...basis(generation, target, revision), profile: 'access-org-realm-proposal-v1', termsRevision: terms });
    const joinBody = (proposalId: string, generation = '0', target = realm, revision = '1', terms = 'terms-1') => ({
      ...basis(generation, target, revision), profile: 'access-org-realm-change-v1',
      action: 'join', proposalId, termsRevision: terms });
    const changeBody = (action: string, generation: string, revision = '1') => ({
      ...basis(generation, realm, revision), profile: 'access-org-realm-change-v1', action,
      ...(action === 'suspend' || action === 'lift-ban' ? { reasonReference: `case-${action}` } : {}) });
    const issue = async (generation = '0', target = realm, revision = '1', terms = 'terms-1') => {
      const response = await post(proposals, realmToken, proposalBody(generation, target, revision, terms));
      expect(response.status).toBe(200);
      return (await response.json() as { proposalId: string }).proposalId;
    };
    const read = (bearer = orgToken, target = realm, side = 'organization') => main.handle(new Request(
      `http://main.local/v1/access/org-realm-participation?${new URLSearchParams({ realm: target,
        organizationSubject: org, side })}`, { headers: { authorization: `Bearer ${bearer}` } }));
    expect((await post(proposals, noScope, proposalBody('0'))).status).toBe(401);
    expect((await post(proposals, outsiderToken, proposalBody('0'))).status).toBe(403);
    expect((await post(proposals, orgToken, proposalBody('0'))).status).toBe(403);
    expect((await read(outsiderToken)).status).toBe(403);
    expect(await (await read()).json()).toMatchObject({ state: 'absent', generation: '0' });
    const firstKey = randomUUID();
    const firstResponse = await post(proposals, realmToken, proposalBody('0'), firstKey);
    expect(firstResponse.status).toBe(200);
    const first = await firstResponse.json() as { proposalId: string };
    expect(await (await post(proposals, realmToken, proposalBody('0'), firstKey)).json())
      .toMatchObject({ ...first, replayed: true });
    expect((await post(proposals, realmToken, proposalBody('0', otherRealm), firstKey)).status).toBe(409);
    expect((await post(changes, realmToken, joinBody(first.proposalId))).status).toBe(403);
    expect((await post(changes, orgToken, joinBody(first.proposalId, '0', otherRealm))).status).toBe(403);
    expect((await post(changes, orgToken, joinBody(randomUUID()))).status).toBe(403);
    expect((await post(changes, orgToken, joinBody(first.proposalId, '0', realm, '1', 'wrong'))).status).toBe(409);
    const concurrentKey = randomUUID();
    const concurrentProposals = await Promise.all([0, 1].map(() =>
      post(proposals, realmToken, proposalBody('0'), concurrentKey)));
    expect(concurrentProposals.map(result => result.status)).toEqual([200, 200]);
    const concurrentResults = await Promise.all(concurrentProposals.map(response => response.json())) as { proposalId: string }[];
    expect(concurrentResults[0]!.proposalId).toBe(concurrentResults[1]!.proposalId);
    const expired = randomUUID();
    await accessPool.query(`INSERT INTO access.org_realm_proposal
      (id, realm, organization_subject, next_generation, policy_revision, terms_revision,
        organization_generation, organization_admission_generation, principal_id, authority_epoch,
        realm_proof, expires_at, created_at)
      SELECT $1, realm, organization_subject, next_generation, policy_revision, terms_revision,
        organization_generation, organization_admission_generation, principal_id, authority_epoch,
        realm_proof, now() - interval '1 minute', now() - interval '2 minutes'
      FROM access.org_realm_proposal WHERE id = $2`, [expired, first.proposalId]);
    expect((await post(changes, orgToken, joinBody(expired))).status).toBe(403);
    // Holding both mandates does not let one caller approve its own invitation.
    const dual = randomUUID();
    await accessPool.query(`INSERT INTO access.representation
      (id, principal_id, subject_id, action, valid_until)
      VALUES ($1,$2,$3,$4,now() + interval '1 hour')`,
    [dual, fixture.realmPrincipalId, org, ORG_REALM_ACTION.participate]);
    expect((await post(changes, realmToken, joinBody(first.proposalId))).status).toBe(403);
    await accessPool.query('DELETE FROM access.representation WHERE id = $1', [dual]);
    // An ordinary Agent roster entry is not an organization participation registration.
    const unregistered = { ...proposalBody('0'), organizationSubject: realmManager };
    expect((await post(proposals, realmToken, unregistered)).status).toBe(403);
    const orgGrant = authority.get(ORG_REALM_ACTION.participate)!.grantId;
    await accessPool.query('UPDATE access.permission_grant SET active = false WHERE id = $1', [orgGrant]);
    expect((await post(changes, orgToken, joinBody(first.proposalId))).status).toBe(403);
    await accessPool.query('UPDATE access.permission_grant SET active = true, generation = generation + 1 WHERE id = $1', [orgGrant]);
    // Every saved Realm proof component is exact, even if fresh authority exists.
    for (const [table, id] of [
      ['representation', authority.get(ORG_REALM_ACTION.admit)!.representationId],
      ['permission_grant', authority.get(ORG_REALM_ACTION.admit)!.grantId],
      ['authority_subject', realmManager],
    ]) {
      const proposalId = await issue();
      await accessPool.query(`UPDATE access.${table} SET generation = generation + 1 WHERE id = $1`, [id]);
      expect((await post(changes, orgToken, joinBody(proposalId))).status).toBe(403);
    }
    const fencedProposal = await issue();
    await admission.strongDeactivatePrincipal(fixture.realmPrincipalId, '0');
    expect((await post(changes, orgToken, joinBody(fencedProposal))).status).toBe(403);
    await accessPool.query('UPDATE access.principal SET active = true WHERE id = $1', [fixture.realmPrincipalId]);
    const orgStale = await issue();
    await accessPool.query('UPDATE access.org_participation_subject SET generation = generation + 1 WHERE subject = $1', [org]);
    expect((await post(changes, orgToken, joinBody(orgStale))).status).toBe(409);
    const policyStale = await issue();
    await accessPool.query(`UPDATE access.org_realm_policy SET revision = revision + 1,
      terms_revision = 'terms-2' WHERE realm = $1`, [realm]);
    expect((await post(changes, orgToken, joinBody(policyStale))).status).toBe(409);
    expect((await post(changes, orgToken, joinBody(policyStale, '0', realm, '2', 'terms-2'))).status).toBe(409);
    const expiryRace = await issue('0', realm, '2', 'terms-2');
    const realmLock = await accessPool.connect();
    try {
      await realmLock.query('BEGIN');
      await realmLock.query('SELECT id FROM access.representation WHERE id = $1 FOR UPDATE',
        [authority.get(ORG_REALM_ACTION.admit)!.representationId]);
      await accessPool.query(`UPDATE access.permission_grant
        SET valid_until = clock_timestamp() + interval '1 second' WHERE id = $1`, [orgGrant]);
      const reachedRealmProof = new Promise<boolean>(resolveProof => {
        observeQuery = (sql, parameters) => {
          if (sql.startsWith('SELECT p.id FROM access.principal p') && parameters?.[2] === realmManager) {
            resolveProof(true);
          }
        };
      });
      const racing = post(changes, orgToken, joinBody(expiryRace, '0', realm, '2', 'terms-2'));
      expect(await Promise.race([reachedRealmProof, Bun.sleep(800).then(() => false)])).toBe(true);
      await Bun.sleep(1050);
      await realmLock.query('COMMIT');
      expect((await racing).status).toBe(403);
    } finally { observeQuery = undefined; await realmLock.query('ROLLBACK'); realmLock.release(); }
    await accessPool.query(`UPDATE access.permission_grant
      SET valid_until = now() + interval '1 hour', generation = generation + 1 WHERE id = $1`, [orgGrant]);
    // Bulk baseline rosters remain distinct from organization participation.
    await accessPool.query(`INSERT INTO access.membership_policy (kind, owner_subject, revision, terms_revision)
      VALUES ('org',$1,1,'roster-terms'),('realm',$2,1,'agent-realm-terms')`, [org, realmManager]);
    await accessPool.query(`INSERT INTO access.membership
      (id, kind, owner_subject, member_subject, generation, state, policy_revision, terms_revision, consent_reference)
      VALUES ($1,'org',$2,$3,1,'joined',1,'roster-terms','fixture'),
        ($4,'realm',$3,$2,1,'joined',1,'agent-realm-terms','fixture')`,
    [randomUUID(), org, realmManager, randomUUID()]);
    // A dormant independent permission and its representation must never revive on rejoin.
    await accessPool.query(`INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until)
      VALUES ($1,$2,$3,'work.create',now() + interval '1 hour')`, [randomUUID(), fixture.orgPrincipalId, org]);
    await accessPool.query(`INSERT INTO access.permission_grant
      (id, issuer_subject, recipient_subject, scope_id, action, valid_until, active)
      VALUES ($1,$2,$2,'work:create:root','work.create',now() + interval '1 hour',false)`, [randomUUID(), org]);
    const unrelatedSnapshot = async () => (await accessPool.query(`SELECT
      (SELECT jsonb_agg(to_jsonb(m) ORDER BY id) FROM access.membership m) AS roster,
      (SELECT jsonb_agg(to_jsonb(g) ORDER BY id) FROM access.permission_grant g) AS grants,
      (SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM access.representation r) AS mandates`)).rows[0];
    const before = await unrelatedSnapshot();
    const accepted = await issue('0', realm, '2', 'terms-2');
    const acceptBody = joinBody(accepted, '0', realm, '2', 'terms-2');
    const contenders = await Promise.all([0, 1].map(async () => {
      const key = randomUUID();
      const response = await post(changes, orgToken, acceptBody, key);
      return { key, status: response.status, result: await response.json() };
    }));
    expect(contenders.map(item => item.status).sort()).toEqual([200, 409]);
    const winner = contenders.find(item => item.status === 200)!;
    expect(winner.result).toMatchObject({ state: 'joined', mode: 'independent', generation: '1', banned: false });
    expect(JSON.stringify(winner.result)).not.toContain(fixture.orgPrincipalId);
    expect(JSON.stringify(winner.result)).not.toContain(fixture.realmPrincipalId);
    expect(await unrelatedSnapshot()).toEqual(before);
    const coverage = await accessStateCoverage(accessPool);
    const other = await issue('0', otherRealm);
    expect((await post(changes, orgToken, joinBody(other, '0', otherRealm))).status).toBe(200);
    expect(await accessStateCoverage(accessPool)).not.toEqual(coverage);
    expect((await post('/v1/works', orgToken, { profile: 'metadata-only-v1', title: 'No implicit authority',
      actingSubject: org })).status).toBe(403);
    expect((await post(changes, orgToken, changeBody('suspend', '1', '2'))).status).toBe(403);
    expect((await post(changes, realmToken, changeBody('leave', '1', '2'))).status).toBe(403);
    const suspensions = await Promise.all([0, 1].map(() =>
      post(changes, realmToken, changeBody('suspend', '1', '2'))));
    expect(suspensions.map(result => result.status).sort()).toEqual([200, 409]);
    const suspend = suspensions.find(response => response.status === 200)!;
    expect(await suspend.json()).toMatchObject({ state: 'suspended', generation: '2', banned: true });
    const leave = await post(changes, orgToken, changeBody('leave', '2', '2'));
    expect(leave.status).toBe(200);
    expect(await leave.json()).toMatchObject({ state: 'left', generation: '3', banned: true });
    expect((await post(proposals, realmToken, proposalBody('3', realm, '2', 'terms-2'))).status).toBe(403);
    expect(await unrelatedSnapshot()).toEqual(before);
    expect(await (await read(orgToken, otherRealm)).json()).toMatchObject({ state: 'joined', generation: '1' });
    expect(await (await post(changes, orgToken, acceptBody, winner.key)).json())
      .toMatchObject({ ...(winner.result as object), replayed: true });
    expect((await post(changes, orgToken, changeBody('leave', '3', '2'), winner.key)).status).toBe(409);
    await accessPool.query('UPDATE access.org_realm_policy SET open = false, revision = revision + 1 WHERE realm = $1', [realm]);
    expect((await post(changes, realmToken, changeBody('lift-ban', '3', '3'))).status).toBe(200);
    expect(await (await read()).json()).toMatchObject({ state: 'left', generation: '4', banned: false, admissionOpen: false });
    expect((await post(proposals, realmToken, proposalBody('4', realm, '3', 'terms-2'))).status).toBe(403);
    await accessPool.query('UPDATE access.org_realm_policy SET open = true, revision = revision + 1 WHERE realm = $1', [realm]);
    expect((await post(changes, orgToken, joinBody(accepted, '4', realm, '4', 'terms-2'))).status).toBe(409);
    const rejoin = await issue('4', realm, '4', 'terms-2');
    expect((await post(changes, orgToken, joinBody(rejoin, '4', realm, '4', 'terms-2'))).status).toBe(200);
    expect(await unrelatedSnapshot()).toEqual(before);
    expect(await (await read(realmToken, realm, 'realm')).json()).toMatchObject({ state: 'joined', generation: '5' });
    expect((await post('/v1/works', orgToken, { profile: 'metadata-only-v1', title: 'No revived authority',
      actingSubject: org })).status).toBe(403);
    expect((await accessPool.query(`SELECT h.reason_reference FROM access.org_realm_history h
      JOIN access.org_realm_participation p ON p.id = h.participation_id
      WHERE p.realm = $1 AND h.action = 'suspend'`, [realm])).rows)
      .toEqual([{ reason_reference: 'case-suspend' }]);
    // Indexed exact reads keep SQL/selected-row work constant with unrelated retained history.
    const measurements: { calls: number; rows: number }[] = [];
    for (const size of [0, 32, 256]) {
      if (size) await accessPool.query(`INSERT INTO access.org_realm_proposal
        (id, realm, organization_subject, next_generation, policy_revision, terms_revision,
          organization_generation, organization_admission_generation, principal_id, authority_epoch,
          realm_proof, expires_at)
        SELECT gen_random_uuid(), realm, organization_subject, next_generation, policy_revision, terms_revision,
          organization_generation, organization_admission_generation, principal_id, authority_epoch,
          realm_proof, now() + interval '5 minutes' FROM access.org_realm_proposal
        CROSS JOIN generate_series(1,$2) WHERE id = $1`, [accepted, size]);
      counts.calls = 0; counts.rows = 0;
      expect((await read()).status).toBe(200);
      measurements.push({ ...counts });
    }
    expect(measurements[1]).toEqual(measurements[0]);
    expect(measurements[2]).toEqual(measurements[0]);
    expect(measurements[0]!.calls).toBeLessThanOrEqual(12);
    expect(measurements[0]!.rows).toBeLessThanOrEqual(7);
    const shared = await accessPool.connect();
    try {
      await shared.query('BEGIN');
      await shared.query("SELECT id FROM access.scope_gate WHERE id = 'work:create:root' FOR SHARE");
      expect((await read()).status).toBe(200);
      const unrelatedRealm = `https://rezics.com/id/${randomUUID()}`;
      await accessPool.query(`INSERT INTO access.org_realm_policy (realm, manager_subject, revision, terms_revision)
        VALUES ($1,$2,1,'terms-1')`, [unrelatedRealm, realmManager]);
      expect((await post(proposals, realmToken, proposalBody('0', unrelatedRealm))).status).toBe(200);
      // Mutations require exclusive epoch fencing and fail within the owner lock budget.
      expect((await post(changes, orgToken, changeBody('leave', '5', '4'))).status).toBe(503);
    } finally { await shared.query('ROLLBACK'); shared.release(); }
    await expect(accessPool.query('UPDATE access.org_realm_proposal SET terms_revision = $1 WHERE id = $2',
      ['changed', accepted])).rejects.toThrow();
    await expect(accessPool.query('DELETE FROM access.org_realm_history')).rejects.toThrow();
    await expect(accessPool.query('DELETE FROM access.org_realm_receipt')).rejects.toThrow();
    await expect(accessPool.query('DELETE FROM access.org_realm_proposal_use')).rejects.toThrow();
    await expect(accessPool.query('UPDATE access.org_realm_participation SET generation = 1 WHERE realm = $1', [realm])).rejects.toThrow();
    await expect(accessPool.query('DELETE FROM access.org_realm_ban WHERE realm = $1', [realm])).rejects.toThrow();
    await accessPool.query('UPDATE access.recovery_fence SET open = false WHERE id = true');
    expect((await read()).status).toBe(503);
    expect((await post(changes, orgToken, changeBody('leave', '5', '4'))).status).toBe(503);
    expect((await post(proposals, realmToken, proposalBody('0', otherRealm))).status).toBe(503);
    await accessPool.query('UPDATE access.recovery_fence SET open = true WHERE id = true');
    // Account session deactivation rejects the next effect before Access writes.
    await accountPool.query('DELETE FROM session WHERE "userId" = $1', [orgUser.id]);
    expect((await post(changes, orgToken, changeBody('leave', '5', '4'))).status).toBe(401);
    expect((await accessPool.query(`SELECT generation FROM access.org_realm_participation
      WHERE realm = $1 AND organization_subject = $2`, [realm, org])).rows[0]?.generation).toBe('5');
  } finally {
    await account.stop();
    await Promise.all([accountPool.end(), accessPool.end()]);
    await databases.close();
    rmSync(state, { recursive: true, force: true });
  }
}, 180_000);
