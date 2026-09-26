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
import { AccessMemberships } from '../../../services/main/src/modules/access/memberships.ts';
import { AccessMembershipConsents } from '../../../services/main/src/modules/access/membership-consents.ts';
import { AccessManagedOrganizations, type ManagedGrantChangeResult, type OrgRosterPolicyInput } from '../../../services/main/src/modules/access/managed-organizations.ts';
import { MANAGED_ORG_ACTION } from '../../../services/main/src/modules/access/managed-org-authority.ts';
import { AccountAssertionVerifier } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { accessStateCoverage } from '../../../services/main/src/modules/work/access-recovery-coverage.ts';
import { cloneQaAccountAccessDatabases } from '../support/databases.ts';
import { seedOrgRealm } from '../support/org-realm.ts';
import { seedManagedOrganization } from '../support/managed-organization.ts';

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

test('IAM24/IAM23/IAM06: explicit managed organization grants protect a real roster policy operation (partial)', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.FUSEKI_URL || !Bun.env.ACCOUNT_MAIN_RESOURCE) {
    throw new Error('Run through the isolated QA integration tier');
  }
  const state = join(root, '.temp', `managed-org-api-${randomUUID()}`);
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
      const email = `managed-org-${name}-${randomUUID()}@example.test`;
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
    const scopes = 'access:manage access:membership-consent';
    const verifierClient = await auth.api.adminCreateOAuthClient({ headers, body: {
      client_name: 'Managed organization verifier', scope: scopes,
      token_endpoint_auth_method: 'client_secret_post', grant_types: ['client_credentials'],
      client_credentials_scopes: scopes.split(' ') } });
    const redirectUri = 'http://localhost:3000/auth/callback';
    const oauthClient = await auth.api.adminCreateOAuthClient({ headers, body: {
      client_name: 'Managed organization client', application_type: 'native',
      redirect_uris: [redirectUri], token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'], scope: `openid ${scopes}`, skip_consent: true, require_pkce: true } });
    async function tokenFor(user: { email: string; password: string }, scope = `openid ${scopes}`) {
      const signIn = await fetch(`${base}/api/auth/sign-in/email`, { method: 'POST',
        headers: { 'content-type': 'application/json', origin: base },
        body: JSON.stringify({ email: user.email, password: user.password }) });
      expect(signIn.status).toBe(200);
      const verifier = randomBytes(32).toString('base64url');
      const authorize = new URL(`${base}/api/auth/oauth2/authorize`);
      for (const [key, value] of Object.entries({ response_type: 'code', client_id: oauthClient.client_id,
        redirect_uri: redirectUri, scope, state: randomUUID(), resource: Bun.env.ACCOUNT_MAIN_RESOURCE,
        code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' })) {
        authorize.searchParams.set(key, value);
      }
      const authorized = await fetch(authorize, { headers: { cookie: signIn.headers.get('set-cookie')! }, redirect: 'manual' });
      expect(authorized.status).toBe(302);
      const code = new URL(authorized.headers.get('location')!).searchParams.get('code')!;
      const exchange = await fetch(`${base}/api/auth/oauth2/token`, { method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({
          grant_type: 'authorization_code', client_id: oauthClient.client_id, code, redirect_uri: redirectUri,
          code_verifier: verifier, resource: Bun.env.ACCOUNT_MAIN_RESOURCE }) });
      expect(exchange.status).toBe(200);
      return (await exchange.json() as { access_token: string }).access_token;
    }
    const orgUser = await signUp('organization'), realmUser = await signUp('realm'), outsider = await signUp('outsider');
    const orgToken = await tokenFor(orgUser), realmToken = await tokenFor(realmUser);
    const outsiderToken = await tokenFor(outsider), noScope = await tokenFor(outsider, 'openid');
    const fixture = await seedOrgRealm(accessPool, `${base}/api/auth`, { org: orgUser.id, realm: realmUser.id });
    const { org, realm, otherRealm, realmManager } = fixture;
    const managed = await seedManagedOrganization(accessPool, fixture);
    const counts = { calls: 0, rows: 0, writes: 0 };
    let observe: ((sql: string, parameters?: unknown[]) => void) | undefined;
    const measuredPool = { connect: async () => {
      const client = await accessPool.connect();
      return { query: async (sql: string, parameters?: unknown[]) => {
        counts.calls++; observe?.(sql, parameters);
        const result = await client.query(sql, parameters);
        counts.rows += result.rows.length;
        if (/^\s*(INSERT|UPDATE|DELETE)/.test(sql)) counts.writes += result.rowCount ?? 0;
        return result;
      }, release: () => client.release() };
    } } as unknown as Pool;
    const owner = new AccessManagedOrganizations(measuredPool);
    const participation = new AccessOrgRealmParticipation(accessPool);
    const admission = new AccessAdmissionRegistry(accessPool);
    const fuseki = new FusekiClient(Bun.env.FUSEKI_URL);
    const main = createMainApp(fuseki, { environment: { fuseki,
      lineage: { dataEpoch: Bun.env.MAIN_DATA_EPOCH!, routingEpoch: Bun.env.MAIN_ROUTING_EPOCH! },
      objectDirectory: join(state, 'objects') },
    account: new AccountAssertionVerifier({ issuer: `${base}/api/auth`, audience: Bun.env.ACCOUNT_MAIN_RESOURCE,
      jwksUrl: `${base}/api/auth/jwks`, introspectUrl: `${base}/api/auth/oauth2/introspect`,
      clientId: verifierClient.client_id, clientSecret: verifierClient.client_secret! }),
    access: admission, orgRealmParticipation: participation, managedOrganizations: owner,
    memberships: new AccessMemberships(accessPool), membershipConsents: new AccessMembershipConsents(accessPool) });
    const post = (path: string, bearer: string, body: object, key = randomUUID()) => main.handle(new Request(
      `http://main.local${path}`, { method: 'POST', headers: { authorization: `Bearer ${bearer}`,
        'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify(body) }));
    const get = (path: string, bearer = orgToken) => main.handle(new Request(`http://main.local${path}`,
      { headers: { authorization: `Bearer ${bearer}` } }));
    const grants = '/v1/access/managed-organization-grants', policies = '/v1/access/organization-roster-policy';
    const readState = async () => {
      const response = await get(`/v1/access/organization-management?organizationSubject=${encodeURIComponent(org)}`);
      expect(response.status).toBe(200);
      return await response.json() as { authorityEpoch: string; policyRevision: string; admissionsOpen: boolean };
    };
    const issueBody = async (overrides = {}) => ({ profile: 'access-managed-organization-grant-v1', operation: 'issue',
      organizationSubject: org, expectedAuthorityEpoch: (await readState()).authorityEpoch,
      recipient: { kind: 'realm', id: realm }, actions: [MANAGED_ORG_ACTION.roster], delegationCeiling: 0,
      validFrom: new Date(Date.now() - 1000).toISOString(), validUntil: new Date(Date.now() + 1200_000).toISOString(), ...overrides });
    const issue = async (overrides = {}) => {
      const response = await post(grants, orgToken, await issueBody(overrides));
      expect(response.status).toBe(200);
      return await response.json() as ManagedGrantChangeResult;
    };
    const operation = async (grantId: string, overrides: Partial<OrgRosterPolicyInput> = {}) => {
      const representationId = overrides.representationId ?? managed.recipientRepresentation;
      // Fixture mutations also advance the owner's generation trigger. Ordinary
      // calls use that generation; the stale-input test overrides it explicitly.
      const representation = await accessPool.query<{ generation: string }>(
        'SELECT generation FROM access.representation WHERE id = $1', [representationId]);
      return { profile: 'access-organization-roster-policy-v1', organizationSubject: org,
        recipient: { kind: 'realm', id: realm }, grantId, expectedGrantGeneration: '1',
        representationId, expectedRepresentationGeneration: representation.rows[0]!.generation,
        expectedPolicyRevision: (await readState()).policyRevision, admissionsOpen: false, ...overrides };
    };
    const revokeBody = async (grantId: string) => ({ profile: 'access-managed-organization-grant-v1', operation: 'revoke',
      organizationSubject: org, grantId, expectedGeneration: '1', expectedAuthorityEpoch: (await readState()).authorityEpoch });
    const joinRealm = async (target: string, generation: string) => {
      const basis = { realm: target, organizationSubject: org, expectedGeneration: generation, expectedPolicyRevision: '1' };
      const proposed = await post('/v1/access/org-realm-proposals', realmToken,
        { profile: 'access-org-realm-proposal-v1', ...basis, termsRevision: 'terms-1' });
      expect(proposed.status).toBe(200);
      const proposal = await proposed.json() as { proposalId: string };
      expect((await post('/v1/access/org-realm-changes', orgToken,
        { profile: 'access-org-realm-change-v1', ...basis, action: 'join', proposalId: proposal.proposalId,
          termsRevision: 'terms-1' })).status).toBe(200);
    };
    // Structural participation and operational membership never manufacture a grant.
    await joinRealm(realm, '0'); await joinRealm(otherRealm, '0');
    await accessPool.query(`INSERT INTO access.membership
      (id, kind, owner_subject, member_subject, state, generation, policy_revision, terms_revision, consent_reference)
      VALUES ($1,'org',$2,$3,'joined',1,1,'roster-terms','fixture')`, [randomUUID(), org, realmManager]);
    expect((await post(policies, realmToken, await operation(randomUUID()))).status).toBe(403);
    const noGrantCount = await accessPool.query('SELECT count(*)::int AS count FROM access.managed_org_grant');
    expect(noGrantCount.rows[0]?.count).toBe(0);
    // A catalog relationship is irrelevant even when returned to a caller elsewhere.
    // The protected owner performs no graph reads; exercise real descriptive RDF in the QA graph.
    await fuseki.update(`INSERT DATA { GRAPH <urn:rezics:qa:managed-org-description> {
      <${org}> <https://schema.org/parentOrganization> <${realmManager}> ;
        <https://schema.org/memberOf> <${realm}> ; <https://schema.org/sameAs> <${managed.parent}> . } }`);
    expect((await post(policies, realmToken, await operation(randomUUID()))).status).toBe(403);
    const initial = await issueBody();
    expect((await post(grants, noScope, initial)).status).toBe(401);
    expect((await post(grants, realmToken, initial)).status).toBe(403);
    expect((await post(grants, outsiderToken, initial)).status).toBe(403);
    expect((await post(grants, orgToken, { ...initial, actions: ['access.representation.manage'] })).status).toBe(400);
    expect((await post(grants, orgToken, { ...initial, delegationCeiling: 1 })).status).toBe(400);
    expect((await post(grants, orgToken, { ...initial, validUntil: new Date(Date.now() + 7200_000).toISOString() })).status).toBe(403);
    for (const [table, id] of [['representation', managed.issuerRepresentation],
      ['permission_grant', managed.managementGrant], ['permission_grant', managed.ceilingGrant]]) {
      await accessPool.query(`UPDATE access.${table} SET active = false WHERE id = $1`, [id]);
      expect((await post(grants, orgToken, initial)).status).toBe(403);
      await accessPool.query(`UPDATE access.${table} SET active = true, generation = generation + 1 WHERE id = $1`, [id]);
    }
    const issueKey = randomUUID();
    const issuedResponses = await Promise.all([0, 1].map(() => post(grants, orgToken, initial, issueKey)));
    expect(issuedResponses.map(response => response.status)).toEqual([200, 200]);
    const issued = await issuedResponses[0]!.json() as ManagedGrantChangeResult;
    expect(await issuedResponses[1]!.json()).toMatchObject({ grantId: issued.grantId, generation: '1' });
    expect((await post(grants, orgToken, { ...initial, recipient: { kind: 'realm', id: otherRealm } }, issueKey)).status).toBe(409);
    expect(JSON.stringify(issued)).not.toContain(fixture.orgPrincipalId);
    expect(JSON.stringify(issued)).not.toContain('issuer_proof');
    const read = await get(`${grants}/${issued.grantId}?side=recipient`, realmToken);
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ representation: { id: managed.recipientRepresentation, generation: '0' },
      resource: { kind: 'org-roster', organizationSubject: org } });
    expect((await get(`${grants}/${issued.grantId}?side=recipient`, outsiderToken)).status).toBe(403);
    const effect = await operation(issued.grantId), effectKey = randomUUID();
    expect((await post(policies, realmToken, { ...effect, recipient: { kind: 'realm', id: otherRealm } })).status).toBe(403);
    expect((await post(policies, realmToken, { ...effect, organizationSubject: managed.parent })).status).toBe(403);
    expect((await post(policies, orgToken, effect)).status).toBe(403);
    expect((await post(policies, outsiderToken, effect)).status).toBe(403);
    const coverage = await accessStateCoverage(accessPool);
    counts.calls = 0; counts.rows = 0; counts.writes = 0;
    const effectResponse = await post(policies, realmToken, effect, effectKey);
    expect(effectResponse.status).toBe(200);
    const effectResult = await effectResponse.json();
    expect(counts.calls).toBeLessThanOrEqual(32); expect(counts.rows).toBeLessThanOrEqual(20); expect(counts.writes).toBe(4);
    expect(await accessStateCoverage(accessPool)).not.toEqual(coverage);
    expect(await readState()).toMatchObject({ policyRevision: '2', admissionsOpen: false });
    expect((await accessPool.query(`SELECT open, revision FROM access.membership_policy
      WHERE kind = 'realm' AND owner_subject = $1`, [realmManager])).rows[0]).toEqual({ open: true, revision: '1' });
    expect((await post(policies, realmToken, effect)).status).toBe(409);
    expect(await (await post(policies, realmToken, effect, effectKey)).json()).toEqual({ ...(effectResult as object), replayed: true });
    expect((await post(policies, realmToken, { ...effect, admissionsOpen: true }, effectKey)).status).toBe(409);
    // A real downstream join is denied by the new policy, then succeeds after reopening.
    const member = managed.parent;
    for (const [subject, principalId, action] of [[org, fixture.orgPrincipalId, 'access.membership.manage.org'],
      [member, fixture.realmPrincipalId, 'access.membership.consent']]) {
      await accessPool.query(`INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until)
        VALUES ($1,$2,$3,$4,now() + interval '1 hour')`, [randomUUID(), principalId, subject, action]);
      await accessPool.query(`INSERT INTO access.permission_grant (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
        VALUES ($1,$2,$2,'work:create:root',$3,now() + interval '1 hour')`, [randomUUID(), subject, action]);
    }
    const consentBody = { profile: 'access-membership-consent-v1', kind: 'org', ownerSubject: org,
      memberSubject: member, expectedGeneration: '0', expectedPolicyRevision: '2', termsRevision: 'roster-terms' };
    expect((await post('/v1/me/membership-consents', realmToken, consentBody)).status).toBe(403);
    const reopen = await operation(issued.grantId, { admissionsOpen: true });
    expect((await post(policies, realmToken, reopen)).status).toBe(200);
    const consentResponse = await post('/v1/me/membership-consents', realmToken, { ...consentBody, expectedPolicyRevision: '3' });
    expect(consentResponse.status).toBe(200);
    const consent = await consentResponse.json() as { consentReference: string };
    expect((await post('/v1/access/membership-changes', orgToken, { ...consentBody,
      profile: 'access-membership-change-v1', action: 'join', expectedPolicyRevision: '3',
      consentReference: consent.consentReference })).status).toBe(200);

    // Each original proof component is exact. Replacement authority cannot repair a saved grant.
    for (const [table, id] of [['representation', managed.issuerRepresentation],
      ['permission_grant', managed.managementGrant], ['permission_grant', managed.ceilingGrant],
      ['authority_subject', org], ['org_participation_subject', org], ['authority_subject', realmManager]]) {
      const before = await issue();
      await accessPool.query(`UPDATE access.${table} SET generation = generation + 1 WHERE ${table === 'org_participation_subject' ? 'subject' : 'id'} = $1`, [id]);
      expect((await post(policies, realmToken, await operation(before.grantId))).status).toBe(403);
    }
    const shortened = await issue();
    await accessPool.query(`UPDATE access.permission_grant SET valid_until = now() + interval '1 minute' WHERE id = $1`, [managed.ceilingGrant]);
    expect((await post(policies, realmToken, await operation(shortened.grantId))).status).toBe(403);
    await accessPool.query(`UPDATE access.permission_grant SET valid_until = now() + interval '1 hour', generation = generation + 1 WHERE id = $1`, [managed.ceilingGrant]);
    // Current org authority can revoke an old grant after its issuer branch changes,
    // even when the assignment ceiling has been removed.
    const obsoleteRevoke = await revokeBody(issued.grantId);
    await accessPool.query('UPDATE access.permission_grant SET active = false WHERE id = $1', [managed.ceilingGrant]);
    expect((await post(grants, orgToken, obsoleteRevoke)).status).toBe(200);
    expect(await (await post(grants, orgToken, initial, issueKey)).json()).toMatchObject({ grantId: issued.grantId, replayed: true });
    await accessPool.query('UPDATE access.permission_grant SET active = true, generation = generation + 1 WHERE id = $1', [managed.ceilingGrant]);
    const current = await issue();
    await accessPool.query('UPDATE access.representation SET generation = generation + 1 WHERE id = $1', [managed.recipientRepresentation]);
    expect((await post(policies, realmToken, await operation(current.grantId, { expectedRepresentationGeneration: '0' }))).status).toBe(409);
    const currentOperation = await operation(current.grantId);
    await accessPool.query(`UPDATE access.representation SET valid_until = now() - interval '1 second' WHERE id = $1`, [managed.recipientRepresentation]);
    expect((await post(policies, realmToken, currentOperation)).status).toBe(403);
    await accessPool.query(`UPDATE access.representation SET valid_until = now() + interval '1 hour' WHERE id = $1`, [managed.recipientRepresentation]);
    const future = await issue({ validFrom: new Date(Date.now() + 60_000).toISOString() });
    expect((await post(policies, realmToken, await operation(future.grantId))).status).toBe(403);
    const expired = await issue({ validUntil: new Date(Date.now() + 400).toISOString() });
    await Bun.sleep(450);
    expect((await post(policies, realmToken, await operation(expired.grantId))).status).toBe(403);
    const deactivated = await issue();
    const deactivatedOperation = await operation(deactivated.grantId);
    await admission.strongDeactivatePrincipal(fixture.orgPrincipalId, '0');
    expect((await post(policies, realmToken, deactivatedOperation)).status).toBe(403);
    await accessPool.query('UPDATE access.principal SET active = true WHERE id = $1', [fixture.orgPrincipalId]);
    expect((await post(policies, realmToken, await operation(deactivated.grantId))).status).toBe(403);
    const parentGrant = await issue({ recipient: { kind: 'parent', id: managed.parent } });
    expect((await post(policies, realmToken, await operation(parentGrant.grantId, {
      recipient: { kind: 'parent', id: managed.parent }, representationId: managed.parentRepresentation }))).status).toBe(200);
    await expect(accessPool.query('DELETE FROM access.org_participation_subject WHERE subject = $1', [managed.parent])).rejects.toThrow();
    await accessPool.query('UPDATE access.org_participation_subject SET generation = generation + 1 WHERE subject = $1', [managed.parent]);
    expect((await post(policies, realmToken, await operation(parentGrant.grantId, {
      recipient: { kind: 'parent', id: managed.parent }, representationId: managed.parentRepresentation }))).status).toBe(403);

    const concurrent = await issue();
    const revocation = await revokeBody(concurrent.grantId), revocationKey = randomUUID();
    const concurrentIssue = await issueBody();
    const races = await Promise.all([post(grants, orgToken, revocation, revocationKey),
      post(grants, orgToken, concurrentIssue)]);
    expect(races.map(response => response.status).sort()).toEqual([200, 409]);
    if (races[0]!.status === 409) {
      expect((await post(grants, orgToken, await revokeBody(concurrent.grantId), revocationKey)).status).toBe(200);
    }
    expect((await post(policies, realmToken, await operation(concurrent.grantId))).status).toBe(409);
    expect((await post(policies, realmToken, await operation(concurrent.grantId, {
      expectedGrantGeneration: '2' }))).status).toBe(403);
    // A leave/rejoin cannot repair a revoked grant or transfer its right to another Realm.
    expect((await post('/v1/access/org-realm-changes', orgToken, { profile: 'access-org-realm-change-v1',
      realm, organizationSubject: org, expectedGeneration: '1', expectedPolicyRevision: '1', action: 'leave' })).status).toBe(200);
    await joinRealm(realm, '2');
    expect((await post(policies, realmToken, await operation(concurrent.grantId))).status).toBe(409);
    // Receipt recovery performs no write, even after revocation and unrelated current state changes.
    const receiptGrant = await issue();
    const receiptBody = await operation(receiptGrant.grantId);
    const receiptKey = randomUUID();
    const savedEffect = await post(policies, realmToken, receiptBody, receiptKey);
    expect(savedEffect.status).toBe(200);
    const savedResult = await savedEffect.json();
    const receiptRevoke = await revokeBody(receiptGrant.grantId), receiptRevokeKey = randomUUID();
    const revoked = await post(grants, orgToken, receiptRevoke, receiptRevokeKey);
    expect(revoked.status).toBe(200);
    expect((await post(grants, orgToken, receiptRevoke, receiptRevokeKey)).status).toBe(200);
    counts.writes = 0;
    expect(await (await post(policies, realmToken, receiptBody, receiptKey)).json()).toEqual({ ...(savedResult as object), replayed: true });
    expect(counts.writes).toBe(0);

    const bounded = await issue();
    const measurements: typeof counts[] = [];
    for (const size of [0, 32, 256]) {
      if (size) await accessPool.query(`INSERT INTO access.managed_org_grant
        (id, organization_subject, organization_generation, organization_admission_generation, recipient_kind,
          recipient_id, recipient_realm, recipient_parent, recipient_subject, recipient_generation, recipient_admission_generation,
          action, delegation_ceiling, valid_from, valid_until, issuer_proof)
        SELECT gen_random_uuid(), organization_subject, organization_generation, organization_admission_generation,
          recipient_kind, recipient_id, recipient_realm, recipient_parent, recipient_subject, recipient_generation, recipient_admission_generation,
          action, delegation_ceiling, valid_from, valid_until, issuer_proof
        FROM access.managed_org_grant CROSS JOIN generate_series(1,$2) WHERE id = $1`, [bounded.grantId, size]);
      const body = await operation(bounded.grantId);
      counts.calls = 0; counts.rows = 0; counts.writes = 0;
      expect((await post(policies, realmToken, body)).status).toBe(200);
      measurements.push({ ...counts });
    }
    expect(measurements[1]).toEqual(measurements[0]); expect(measurements[2]).toEqual(measurements[0]);
    expect(measurements[0]!.calls).toBeLessThanOrEqual(32); expect(measurements[0]!.rows).toBeLessThanOrEqual(20);
    expect(measurements[0]!.writes).toBe(4);
    const competingBody = await operation(bounded.grantId, { admissionsOpen: true });
    const competingPolicies = await Promise.all([0, 1].map(() => post(policies, realmToken, competingBody)));
    expect(competingPolicies.map(response => response.status).sort()).toEqual([200, 409]);
    await accessPool.query('ANALYZE access.managed_org_grant');
    const plan = await accessPool.query('EXPLAIN (FORMAT JSON) SELECT id FROM access.managed_org_grant WHERE id = $1', [bounded.grantId]);
    expect(JSON.stringify(plan.rows)).toContain('managed_org_grant_pkey');
    // A recipient mandate can expire while an issuer row lock is awaited.
    const lock = await accessPool.connect();
    try {
      await lock.query('BEGIN');
      await lock.query('SELECT id FROM access.permission_grant WHERE id = $1 FOR UPDATE', [managed.ceilingGrant]);
      await accessPool.query(`UPDATE access.representation SET valid_until = clock_timestamp() + interval '1 second' WHERE id = $1`, [managed.recipientRepresentation]);
      const reached = new Promise<boolean>(resolveReached => {
        observe = (sql, parameters) => { if (sql.includes('WHERE id = $1 AND recipient_subject') && parameters?.[0] === managed.ceilingGrant) resolveReached(true); };
      });
      const racing = post(policies, realmToken, await operation(bounded.grantId));
      expect(await Promise.race([reached, Bun.sleep(800).then(() => false)])).toBe(true);
      await Bun.sleep(1050); await lock.query('COMMIT');
      expect((await racing).status).toBe(403);
    } finally { observe = undefined; await lock.query('ROLLBACK'); lock.release(); }
    await accessPool.query(`UPDATE access.representation SET valid_until = now() + interval '1 hour' WHERE id = $1`, [managed.recipientRepresentation]);
    const blocked = await accessPool.connect();
    try {
      await blocked.query('BEGIN');
      await blocked.query("SELECT id FROM access.scope_gate WHERE id = 'work:create:root' FOR SHARE");
      const beforeWait = Date.now();
      expect((await post(policies, realmToken, await operation(bounded.grantId))).status).toBe(503);
      expect(Date.now() - beforeWait).toBeLessThan(4000);
    } finally { await blocked.query('ROLLBACK'); blocked.release(); }
    for (const table of ['managed_org_grant_event', 'org_roster_policy_history', 'managed_org_receipt']) {
      await expect(accessPool.query(`DELETE FROM access.${table}`)).rejects.toThrow();
    }
    await expect(accessPool.query('UPDATE access.managed_org_grant SET recipient_id = $2 WHERE id = $1', [bounded.grantId, otherRealm])).rejects.toThrow();
    await expect(accessPool.query('UPDATE access.managed_org_grant SET active = true, generation = 1 WHERE id = $1', [receiptGrant.grantId])).rejects.toThrow();
    const fenceBody = await operation(bounded.grantId);
    await accessPool.query('UPDATE access.recovery_fence SET open = false WHERE id = true');
    expect((await post(policies, realmToken, fenceBody)).status).toBe(503);
    await accessPool.query('UPDATE access.recovery_fence SET open = true WHERE id = true');
    await accountPool.query('DELETE FROM session WHERE "userId" = $1', [realmUser.id]);
    counts.writes = 0;
    expect((await post(policies, realmToken, fenceBody)).status).toBe(401);
    expect(counts.writes).toBe(0);
  } finally {
    await account.stop();
    await Promise.all([accountPool.end(), accessPool.end()]);
    await databases.close();
    rmSync(state, { recursive: true, force: true });
  }
}, 180_000);
