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
import { AccessEligibleOrgMemberSet } from '../../../services/main/src/modules/access/eligible-org-member-set.ts';
import { AccessMembershipConsents } from '../../../services/main/src/modules/access/membership-consents.ts';
import { AccessMemberships, SELECTED_ORG_MEMBER_SET_MANAGER_SQL }
  from '../../../services/main/src/modules/access/memberships.ts';
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

test('IAM25: B grants the exact eligible A-member set; P exercises it as P', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.FUSEKI_URL || !Bun.env.MAIN_DATA_EPOCH
    || !Bun.env.MAIN_ROUTING_EPOCH || !Bun.env.ACCESS_DATABASE_URL
    || !Bun.env.ACCOUNT_DATABASE_URL || !Bun.env.ACCOUNT_MAIN_RESOURCE) {
    throw new Error('Run through the isolated QA integration tier');
  }
  const state = join(root, '.temp', `eligible-org-${randomUUID()}`);
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
      const email = `iam25-${name}-${randomUUID()}@example.test`;
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
      client_name: 'IAM25 Main verifier',
      scope: 'access:manage access:grant access:membership-consent',
      token_endpoint_auth_method: 'client_secret_post', grant_types: ['client_credentials'],
      client_credentials_scopes: ['access:manage', 'access:grant',
        'access:membership-consent'] } });
    const callback = 'http://localhost:3000/auth/callback';
    const oauth = await auth.api.adminCreateOAuthClient({ headers, body: {
      client_name: 'IAM25 native client', application_type: 'native',
      redirect_uris: [callback], token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'],
      scope: 'openid access:manage access:grant access:membership-consent',
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
    const p = await signUp('p');
    const outsider = await signUp('outsider');
    const bManager = await signUp('b-manager');
    const target = await signUp('target');
    const pToken = await tokenFor(p, 'openid access:manage');
    const outsiderToken = await tokenFor(outsider, 'openid access:manage');
    const bToken = await tokenFor(bManager, 'openid access:grant');
    const targetToken = await tokenFor(target, 'openid access:membership-consent');
    const [A, B, B2, C] = Array.from({ length: 4 }, () =>
      `https://rezics.com/id/${randomUUID()}`);
    const ids = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    for (const [i, user] of [p, outsider, bManager, target].entries()) {
      await accessPool.query(`INSERT INTO access.principal
        (id, account_issuer, account_subject) VALUES ($1,$2,$3)`,
      [ids[i], `${base}/api/auth`, user!.id]);
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
    const pMembership = randomUUID(), pConsent = randomUUID();
    await accessPool.query(`INSERT INTO access.private_membership_consent
      (id, principal_id, principal_epoch, kind, owner_subject, policy_revision,
        terms_revision, next_generation, expires_at)
      VALUES ($1,$2,0,'org',$3,1,'terms-1',1,now() + interval '5 minutes')`,
    [pConsent, ids[0], A]);
    await accessPool.query(`INSERT INTO access.private_membership
      (id, kind, owner_subject, principal_id, state, generation,
        policy_revision, terms_revision, consent_reference)
      VALUES ($1,'org',$2,$3,'joined',1,1,'terms-1',$4)`,
    [pMembership, A, ids[0], pConsent]);
    for (const action of ['work.create', 'access.representation.manage',
      'access.org.profile.edit']) {
      await accessPool.query(`INSERT INTO access.representation
        (id, principal_id, subject_id, action, valid_until)
        VALUES ($1,$2,$3,$4,now() + interval '3 hours')`,
      [randomUUID(), ids[0], A, action]);
    }
    for (const [principalId, subject, action] of [
      [ids[2], B, 'access.grant.assign.membership.manage.org'],
      [ids[3], C, 'access.membership.consent'],
    ]) {
      await accessPool.query(`INSERT INTO access.representation
        (id, principal_id, subject_id, action, valid_until)
        VALUES ($1,$2,$3,$4,now() + interval '3 hours')`,
      [randomUUID(), principalId, subject, action]);
      await accessPool.query(`INSERT INTO access.permission_grant
        (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
        VALUES ($1,$2,$2,'work:create:root',$3,now() + interval '3 hours')`,
      [randomUUID(), subject, action]);
    }
    // P's A membership plus A's exact institutional B grant is not a mandate.
    const scope = `access:org-roster:${B!.slice(-36)}`;
    await accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [scope]);
    await accessPool.query(`INSERT INTO access.org_roster_scope
      (owner_subject, scope_id) VALUES ($1,$2)`, [B, scope]);
    await accessPool.query(`INSERT INTO access.permission_grant
      (id, issuer_subject, recipient_subject, scope_id, action, valid_until,
        assigned_by_principal, represented_issuer_generation, represented_recipient_generation)
      VALUES ($1,$2,$3,$4,'access.membership.manage.org',
        now() + interval '1 hour',$5,0,0)`,
    [randomUUID(), B, A, scope, ids[2]]);
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
    eligibleOrgMemberSet: new AccessEligibleOrgMemberSet(accessPool) });
    const post = (path: string, token: string, body: object, key = randomUUID()) =>
      main.handle(new Request(`http://main.local${path}`, { method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json',
          'idempotency-key': key }, body: JSON.stringify(body) }));
    const get = (path: string, token: string) => main.handle(new Request(
      `http://main.local${path}`, { headers: { authorization: `Bearer ${token}` } }));
    const epoch = () => accessPool.query<{ authority_epoch: string }>(`
      SELECT authority_epoch FROM access.scope_gate WHERE id = 'work:create:root'`)
      .then(result => result.rows[0]!.authority_epoch);
    const selectorId = randomUUID(), grantId = randomUUID();
    const grantBody = { profile: 'access-eligible-org-member-set-grant-change-v1',
      action: 'grant', issuerSubject: B, recipientSubject: A, selectorId, grantId,
      expectedAuthorityEpoch: await epoch(),
      validUntil: new Date(Date.now() + 60 * 60_000).toISOString() };
    const missingSet = { profile: 'access-selected-org-membership-change-v1',
      action: 'join', ownerSubject: B, memberSubject: C, recipientSubject: A,
      selectorId, expectedSelectorVersion: '1', grantId,
      expectedGrantGeneration: '0', privateMembershipId: pMembership,
      expectedPrivateMembershipGeneration: '1', expectedPrincipalEpoch: '0',
      expectedRecipientGeneration: '0', expectedOwnerGeneration: '0',
      expectedAuthorityEpoch: await epoch(), expectedGeneration: '0',
      expectedPolicyRevision: '1', termsRevision: 'terms-1',
      consentReference: randomUUID() };
    expect((await post('/v1/access/selected-org-membership-changes', pToken,
      missingSet)).status).toBe(403);
    expect((await post('/v1/access/eligible-org-member-set-grant-changes', bToken,
      { ...grantBody, issuerSubject: B2, expectedAuthorityEpoch: await epoch() })).status).toBe(403);
    expect((await post('/v1/access/eligible-org-member-set-grant-changes', bToken,
      { ...grantBody, validUntil: new Date(Date.now() + 4 * 60 * 60_000).toISOString(),
        expectedAuthorityEpoch: await epoch() })).status).toBe(403);
    const grantResponse = await post('/v1/access/eligible-org-member-set-grant-changes',
      bToken, grantBody, 'grant-b');
    expect(grantResponse.status).toBe(200);
    expect(JSON.stringify(await grantResponse.json())).not.toContain(ids[0]!);
    expect((await post('/v1/access/eligible-org-member-set-grant-changes',
      bToken, grantBody, 'grant-b')).status).toBe(200);
    expect((await post('/v1/access/eligible-org-member-set-grant-changes',
      bToken, { ...grantBody, grantId: randomUUID() }, 'grant-b')).status).toBe(409);
    expect((await post('/v1/access/eligible-org-member-set-grant-changes', bToken,
      { ...grantBody, grantId: randomUUID(), selectorId: randomUUID(),
        expectedAuthorityEpoch: await epoch() })).status).toBe(409);
    const grantRead = await get(`/v1/access/eligible-org-member-set-grants/${grantId}?issuerSubject=${encodeURIComponent(B!)}`, bToken);
    expect(grantRead.status).toBe(200);
    expect(await grantRead.json()).toMatchObject({ selectorId, grantId,
      recipientSubject: A, ownerSubject: B, generation: '0', active: true });
    expect((await get(`/v1/access/eligible-org-member-set-grants/${grantId}?issuerSubject=${encodeURIComponent(B2!)}`, bToken)).status).toBe(403);
    expect((await post('/v1/access/selected-org-membership-changes', pToken,
      { ...missingSet, expectedAuthorityEpoch: await epoch() })).status).toBe(403);
    expect((await post('/v1/access/selected-org-membership-changes', outsiderToken,
      { ...missingSet, expectedAuthorityEpoch: await epoch() })).status).toBe(403);
    expect((await post('/v1/access/selected-org-membership-changes', pToken,
      { ...missingSet, recipientSubject: B2, expectedAuthorityEpoch: await epoch() })).status).toBe(403);
    expect((await post('/v1/access/selected-org-membership-changes', pToken,
      { ...missingSet, ownerSubject: B2, expectedAuthorityEpoch: await epoch() })).status).toBe(403);
    const consentResponse = await post('/v1/me/membership-consents', targetToken, {
      profile: 'access-membership-consent-v1', kind: 'org', ownerSubject: B,
      memberSubject: C, expectedGeneration: '0', expectedPolicyRevision: '1',
      termsRevision: 'terms-1' });
    expect(consentResponse.status).toBe(200);
    const consent = await consentResponse.json() as { consentReference: string };
    const joinBody = { ...missingSet, consentReference: consent.consentReference,
      expectedAuthorityEpoch: await epoch() };
    const attempts = await Promise.all([
      post('/v1/access/selected-org-membership-changes', pToken, joinBody, 'selected-join'),
      post('/v1/access/selected-org-membership-changes', pToken, joinBody, 'selected-join'),
    ]);
    expect(attempts.map(result => result.status)).toEqual([200, 200]);
    const effects = await Promise.all(attempts.map(result => result.json())) as
      { membershipId: string; replayed: boolean; generation: string }[];
    expect(effects.map(result => result.replayed).sort()).toEqual([false, true]);
    expect(effects.map(result => result.generation)).toEqual(['1', '1']);
    expect(JSON.stringify(effects)).not.toContain(ids[0]!);
    const exact = await get('/v1/me/selected-org-membership-changes?idempotencyKey=selected-join', pToken);
    expect(exact.status).toBe(200);
    expect(await exact.json()).toMatchObject({ membershipId: effects[0]!.membershipId,
      generation: '1', replayed: true });
    expect((await post('/v1/access/selected-org-membership-changes', pToken,
      { ...joinBody, memberSubject: B2 }, 'selected-join')).status).toBe(409);
    const history = await accessPool.query<{ changed_by_principal: string;
      acting_subject: string | null; representation_id: string | null;
      selected_selector_id: string; selected_grant_id: string;
      selected_membership_id: string }>(`SELECT changed_by_principal, acting_subject,
      representation_id, selected_selector_id, selected_grant_id, selected_membership_id
      FROM access.membership_history WHERE membership_id = $1 AND generation = 1`,
    [effects[0]!.membershipId]);
    expect(history.rows[0]).toMatchObject({ changed_by_principal: ids[0],
      acting_subject: null, representation_id: null,
      selected_selector_id: selectorId, selected_grant_id: grantId,
      selected_membership_id: pMembership });
    await expect(accessPool.query(`UPDATE access.eligible_org_member_set
      SET predicate = 'something-else' WHERE id = $1`, [selectorId])).rejects.toThrow();
    await expect(accessPool.query(`UPDATE access.eligible_org_member_set_grant
      SET recipient_subject = $2 WHERE id = $1`, [grantId, B2])).rejects.toThrow();
    await expect(accessPool.query(`DELETE FROM access.selected_org_membership_receipt
      WHERE idempotency_key = 'selected-join'`)).rejects.toThrow();
    await expect(accessPool.query(`DELETE FROM access.eligible_org_member_set_grant_receipt
      WHERE idempotency_key = 'grant-b'`)).rejects.toThrow();
    await expect(accessPool.query(`UPDATE access.membership_history
      SET selected_grant_id = NULL WHERE membership_id = $1 AND generation = 1`,
    [effects[0]!.membershipId])).rejects.toThrow();
    // The exact selected proof stays bounded when unrelated grant history grows.
    type PlanNode = { 'Actual Rows'?: number; 'Actual Loops'?: number;
      'Rows Removed by Filter'?: number; 'Relation Name'?: string; Plans?: PlanNode[] };
    const selectedProof = [ids[0], '0', pMembership, selectorId, grantId, '1', A,
      '1', '0', B, '0', '0'];
    async function visits(extra: number): Promise<number> {
      await accessPool.query(`INSERT INTO access.eligible_org_member_set_grant
        (id, selector_id, recipient_subject, selector_version, issuer_subject,
          scope_id, action, valid_until, assigned_by_principal,
          issuer_generation, recipient_generation)
        SELECT id, $2, $3, 1, $4, $5, 'access.membership.manage.org',
          now() + interval '1 hour', $6, 0, 0 FROM unnest($1::uuid[]) AS t(id)`,
      [Array.from({ length: extra }, () => randomUUID()), selectorId, A, B, scope, ids[2]]);
      await accessPool.query('ANALYZE access.eligible_org_member_set_grant');
      const explained = await accessPool.query<{ 'QUERY PLAN': { Plan: PlanNode }[] }>(
        `EXPLAIN (ANALYZE, BUFFERS, WAL, FORMAT JSON, TIMING OFF) ${SELECTED_ORG_MEMBER_SET_MANAGER_SQL}`,
        selectedProof);
      let count = 0;
      function walk(node: PlanNode): void {
        if (node['Relation Name'] === 'eligible_org_member_set_grant') {
          count += ((node['Actual Rows'] ?? 0) + (node['Rows Removed by Filter'] ?? 0))
            * (node['Actual Loops'] ?? 1);
        }
        for (const child of node.Plans ?? []) walk(child);
      }
      walk(explained.rows[0]!['QUERY PLAN'][0]!.Plan);
      return count;
    }
    expect(await visits(64)).toBeLessThanOrEqual(80);
    expect(await visits(15_936)).toBeLessThanOrEqual(16);
    const leave = { ...joinBody, action: 'leave', expectedGeneration: '1',
      expectedAuthorityEpoch: await epoch() };
    delete (leave as { termsRevision?: string }).termsRevision;
    delete (leave as { consentReference?: string }).consentReference;
    await accessPool.query(`UPDATE access.membership_policy SET revision = 2
      WHERE kind = 'org' AND owner_subject = $1`, [B]);
    expect((await post('/v1/access/selected-org-membership-changes', pToken,
      leave)).status).toBe(409);
    const currentLeave = { ...leave, expectedPolicyRevision: '2' };
    await accessPool.query(`UPDATE access.private_membership
      SET state = 'left', generation = generation + 1, terms_revision = NULL,
        consent_reference = NULL WHERE id = $1`, [pMembership]);
    expect((await post('/v1/access/selected-org-membership-changes', pToken,
      { ...currentLeave, expectedAuthorityEpoch: await epoch() })).status).toBe(403);
    await accessPool.query(`UPDATE access.private_membership
      SET state = 'joined', generation = generation + 1,
        terms_revision = 'terms-1', consent_reference = $2 WHERE id = $1`,
    [pMembership, pConsent]);
    expect((await post('/v1/access/selected-org-membership-changes', pToken,
      { ...currentLeave, expectedAuthorityEpoch: await epoch() })).status).toBe(403);
    const freshLeave = { ...currentLeave, expectedPrivateMembershipGeneration: '3',
      expectedAuthorityEpoch: await epoch() };
    expect((await post('/v1/access/selected-org-membership-changes', pToken,
      freshLeave, 'selected-leave')).status).toBe(200);
    const revoke = { profile: 'access-eligible-org-member-set-grant-change-v1',
      action: 'revoke', issuerSubject: B, grantId, expectedAuthorityEpoch: await epoch(),
      expectedObjectGeneration: '0' };
    expect((await post('/v1/access/eligible-org-member-set-grant-changes', bToken,
      revoke, 'revoke-b')).status).toBe(200);
    expect((await post('/v1/access/eligible-org-member-set-grant-changes', bToken,
      revoke, 'revoke-b')).status).toBe(200);
    expect((await post('/v1/access/selected-org-membership-changes', pToken,
      { ...joinBody, expectedPolicyRevision: '2', expectedGeneration: '2',
        expectedPrivateMembershipGeneration: '3', expectedAuthorityEpoch: await epoch() })).status).toBe(403);
    await expect(accessPool.query(`UPDATE access.eligible_org_member_set_grant
      SET active = true WHERE id = $1`, [grantId])).rejects.toThrow();
    expect((await post('/v1/access/selected-org-membership-changes', pToken,
      joinBody, 'selected-join')).status).toBe(200);
    expect((await get('/v1/me/selected-org-membership-changes?idempotencyKey=selected-join',
      outsiderToken)).status).toBe(403);
    const expiredId = randomUUID();
    const expiredAt = new Date(Date.now() + 3000);
    expect((await post('/v1/access/eligible-org-member-set-grant-changes', bToken,
      { ...grantBody, grantId: expiredId, expectedAuthorityEpoch: await epoch(),
        validUntil: expiredAt.toISOString() }, 'short-grant')).status).toBe(200);
    await Bun.sleep(Math.max(0, expiredAt.getTime() - Date.now() + 25));
    expect((await post('/v1/access/selected-org-membership-changes', pToken,
      { ...joinBody, grantId: expiredId, expectedPolicyRevision: '2',
        expectedGeneration: '2', expectedPrivateMembershipGeneration: '3',
        expectedAuthorityEpoch: await epoch() })).status).toBe(403);
    const currentGrantId = randomUUID();
    expect((await post('/v1/access/eligible-org-member-set-grant-changes', bToken,
      { ...grantBody, grantId: currentGrantId, expectedAuthorityEpoch: await epoch() },
      'current-grant')).status).toBe(200);
    const secondConsent = await post('/v1/me/membership-consents', targetToken, {
      profile: 'access-membership-consent-v1', kind: 'org', ownerSubject: B,
      memberSubject: C, expectedGeneration: '2', expectedPolicyRevision: '2',
      termsRevision: 'terms-1' });
    expect(secondConsent.status).toBe(200);
    const secondConsentId = (await secondConsent.json() as { consentReference: string }).consentReference;
    const currentJoin = { ...joinBody, grantId: currentGrantId,
      consentReference: secondConsentId, expectedGeneration: '2',
      expectedPolicyRevision: '2', expectedPrivateMembershipGeneration: '3',
      expectedAuthorityEpoch: await epoch() };
    await accessPool.query('UPDATE access.principal SET active = false WHERE id = $1', [ids[0]]);
    expect((await post('/v1/access/selected-org-membership-changes', pToken,
      currentJoin)).status).toBe(403);
    await accessPool.query('UPDATE access.principal SET active = true WHERE id = $1', [ids[0]]);
    expect((await post('/v1/access/selected-org-membership-changes', pToken,
      { ...currentJoin, expectedAuthorityEpoch: await epoch() })).status).toBe(403);
    expect((await post('/v1/access/selected-org-membership-changes', pToken,
      { ...currentJoin, expectedPrincipalEpoch: '2',
        expectedAuthorityEpoch: await epoch() })).status).toBe(200);
    const leaveAfter = { ...currentJoin, action: 'leave', expectedGeneration: '3',
      expectedPrincipalEpoch: '2', expectedRecipientGeneration: '2' };
    delete (leaveAfter as { termsRevision?: string }).termsRevision;
    delete (leaveAfter as { consentReference?: string }).consentReference;
    await accessPool.query('UPDATE access.authority_subject SET active = false WHERE id = $1', [A]);
    await accessPool.query('UPDATE access.authority_subject SET active = true WHERE id = $1', [A]);
    expect((await post('/v1/access/selected-org-membership-changes', pToken,
      { ...leaveAfter,
        expectedAuthorityEpoch: await epoch() })).status).toBe(403);
    await accessPool.query('UPDATE access.authority_subject SET active = false WHERE id = $1', [B]);
    await accessPool.query('UPDATE access.authority_subject SET active = true WHERE id = $1', [B]);
    expect((await post('/v1/access/selected-org-membership-changes', pToken,
      { ...leaveAfter,
        expectedOwnerGeneration: '2', expectedAuthorityEpoch: await epoch() })).status).toBe(403);
    await accessPool.query('UPDATE access.recovery_fence SET open = false WHERE id = true');
    expect((await post('/v1/access/selected-org-membership-changes', pToken,
      { ...freshLeave, expectedGeneration: '2' })).status).toBe(503);
    await accessPool.query('UPDATE access.recovery_fence SET open = true WHERE id = true');
  } finally {
    await account.stop();
    await Promise.all([accountPool.end(), accessPool.end()]);
    await databases.close();
    rmSync(state, { recursive: true, force: true });
  }
}, 180_000);
