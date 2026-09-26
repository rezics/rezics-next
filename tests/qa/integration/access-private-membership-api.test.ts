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
import { AccessPrivateMemberships } from '../../../services/main/src/modules/access/private-memberships.ts';
import { AccessPrivateRecipients } from '../../../services/main/src/modules/access/private-recipients.ts';
import { AccountAssertionVerifier } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { accessStateCoverage } from '../../../services/main/src/modules/work/access-recovery-coverage.ts';
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

test('IAM06/IAM10/IAM33/IAM34: private membership binds exact direct, group and role authority', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.FUSEKI_URL || !Bun.env.MAIN_DATA_EPOCH
    || !Bun.env.MAIN_ROUTING_EPOCH || !Bun.env.ACCESS_DATABASE_URL
    || !Bun.env.ACCOUNT_DATABASE_URL || !Bun.env.ACCOUNT_MAIN_RESOURCE) {
    throw new Error('Run through the isolated QA integration tier');
  }
  const state = join(root, '.temp', `private-membership-${randomUUID()}`);
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
      const email = `private-membership-${name}-${randomUUID()}@example.test`;
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
      client_name: 'Private membership verifier', scope: 'access:manage access:role access:membership-consent work:create',
      token_endpoint_auth_method: 'client_secret_post', grant_types: ['client_credentials'],
      client_credentials_scopes: ['access:manage', 'access:role', 'access:membership-consent', 'work:create'] } });
    const redirectUri = 'http://localhost:3000/auth/callback';
    const oauthClient = await auth.api.adminCreateOAuthClient({ headers, body: {
      client_name: 'Private membership native client', application_type: 'native',
      redirect_uris: [redirectUri], token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'],
      scope: 'openid access:manage access:role access:membership-consent work:create',
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
    const recipient = await signUp('recipient');
    const outsider = await signUp('outsider');
    const managerToken = await tokenFor(manager, 'openid access:manage access:role work:create');
    const recipientToken = await tokenFor(recipient, 'openid access:membership-consent work:create');
    const outsiderToken = await tokenFor(outsider, 'openid access:manage access:membership-consent');
    const org = `https://rezics.com/id/${randomUUID()}`;
    const realm = `https://rezics.com/id/${randomUUID()}`;
    const attribution = `https://rezics.com/id/${randomUUID()}`;
    const managerId = randomUUID();
    const recipientId = randomUUID();
    const outsiderId = randomUUID();
    await accessPool.query(`INSERT INTO access.principal
      (id, account_issuer, account_subject) VALUES ($1,$2,$3),($4,$2,$5),($6,$2,$7)`,
    [managerId, `${base}/api/auth`, manager.id, recipientId, recipient.id,
      outsiderId, outsider.id]);
    await accessPool.query(`INSERT INTO access.authority_subject (id, kind)
      VALUES ($1,'agent'),($2,'agent'),($3,'agent')`, [org, realm, attribution]);
    await accessPool.query(`INSERT INTO access.scope_gate (id) VALUES ('work:create:root')
      ON CONFLICT DO NOTHING`);
    await accessPool.query(`INSERT INTO access.membership_policy
      (kind, owner_subject, revision, terms_revision) VALUES
      ('org',$1,1,'org-terms-1'),('realm',$2,1,'realm-terms-1')`, [org, realm]);
    for (const [subject, action] of [[org, 'access.membership.manage.org'],
      [realm, 'access.membership.manage.realm']]) {
      await accessPool.query(`INSERT INTO access.representation
        (id, principal_id, subject_id, action, valid_until)
        VALUES ($1,$2,$3,$4,now() + interval '1 hour')`,
      [randomUUID(), managerId, subject, action]);
      await accessPool.query(`INSERT INTO access.permission_grant
        (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
        VALUES ($1,$2,$2,'work:create:root',$3,now() + interval '1 hour')`,
      [randomUUID(), subject, action]);
    }
    await accessPool.query(`INSERT INTO access.principal_agent_attribution
      (id, principal_id, agent_subject, action, valid_until)
      VALUES ($1,$2,$3,'work.create',now() + interval '1 hour')`,
    [randomUUID(), recipientId, attribution]);
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
    groups: new AccessGroups(accessPool),
    privateMemberships: new AccessPrivateMemberships(accessPool),
    privateRecipients: new AccessPrivateRecipients(accessPool) });
    const request = (path: string, bearer: string, body: object, key = randomUUID()) =>
      main.handle(new Request(`http://main.local${path}`, { method: 'POST',
        headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json',
          'idempotency-key': key }, body: JSON.stringify(body) }));
    const read = (bearer: string) => main.handle(new Request('http://main.local/v1/me/private-memberships',
      { headers: { authorization: `Bearer ${bearer}` } }));
    const consentPath = '/v1/me/private-membership-consents';
    const path = '/v1/access/private-membership-changes';
    const consentBody = (kind: 'org' | 'realm', ownerSubject: string, generation: string) => ({
      profile: 'access-private-membership-consent-v1', kind, ownerSubject,
      expectedGeneration: generation, expectedPolicyRevision: '1',
      termsRevision: kind === 'org' ? 'org-terms-1' : 'realm-terms-1' });
    const joinBody = (kind: 'org' | 'realm', ownerSubject: string, generation: string,
      consentReference: string) => ({ profile: 'access-private-membership-change-v1',
      kind, ownerSubject, action: 'join', expectedGeneration: generation,
      expectedPolicyRevision: '1', termsRevision: kind === 'org' ? 'org-terms-1' : 'realm-terms-1',
      consentReference });
    const leaveBody = (kind: 'org' | 'realm', ownerSubject: string,
      generation: string, membershipId: string) => ({
      profile: 'access-private-membership-change-v1', kind, ownerSubject,
      action: 'leave', membershipId, expectedGeneration: generation,
      expectedPolicyRevision: '1' });
    const issue = async (kind: 'org' | 'realm', ownerSubject: string, generation: string) => {
      const response = await request(consentPath, recipientToken,
        consentBody(kind, ownerSubject, generation));
      expect(response.status).toBe(200);
      return (await response.json() as { consentReference: string }).consentReference;
    };

    const before = await accessStateCoverage(accessPool);
    const orgConsent = await issue('org', org, '0');
    expect(await accessStateCoverage(accessPool)).not.toEqual(before);
    const realmConsent = await issue('realm', realm, '0');
    const consentKey = randomUUID();
    const consentIntent = consentBody('org', org, '0');
    const replayConsent = await request(consentPath, recipientToken, consentIntent, consentKey);
    expect(replayConsent.status).toBe(200);
    expect((await request(consentPath, recipientToken, consentIntent, consentKey)).status).toBe(200);
    expect((await request(consentPath, recipientToken,
      consentBody('realm', realm, '0'), consentKey)).status).toBe(409);
    expect((await request(consentPath, managerToken, consentIntent)).status).toBe(401);
    expect((await request(path, recipientToken, joinBody('org', org, '0', orgConsent))).status).toBe(401);
    expect((await request(path, outsiderToken, joinBody('org', org, '0', orgConsent))).status).toBe(403);
    expect((await request(path, managerToken, joinBody('org', org, '0', realmConsent))).status).toBe(403);
    const expiredConsent = randomUUID();
    await accessPool.query(`INSERT INTO access.private_membership_consent
      (id, principal_id, principal_epoch, kind, owner_subject, policy_revision,
        terms_revision, next_generation, created_at, expires_at)
      VALUES ($1,$2,0,'org',$3,1,'org-terms-1',1,
        now() - interval '6 minutes',now() - interval '1 minute')`,
    [expiredConsent, recipientId, org]);
    expect((await request(path, managerToken,
      joinBody('org', org, '0', expiredConsent))).status).toBe(403);
    const revocable = await issue('org', org, '0');
    expect((await request('/v1/me/private-membership-consent-revocations', recipientToken, {
      profile: 'access-private-membership-consent-revocation-v1',
      consentReference: revocable })).status).toBe(200);
    expect((await request('/v1/me/private-membership-consent-revocations', outsiderToken, {
      profile: 'access-private-membership-consent-revocation-v1',
      consentReference: revocable })).status).toBe(403);
    expect((await request(path, managerToken, joinBody('org', org, '0', revocable))).status).toBe(403);
    const joinKey = randomUUID();
    const joinedResponse = await request(path, managerToken,
      joinBody('org', org, '0', orgConsent), joinKey);
    expect(joinedResponse.status).toBe(200);
    const joined = await joinedResponse.json() as { membershipId: string;
      generation: string; authorityEpoch: string; replayed: boolean };
    expect(joined).toMatchObject({ generation: '1', replayed: false });
    expect(JSON.stringify(joined)).not.toContain(recipient.id);
    expect(JSON.stringify(joined)).not.toContain(recipientId);
    expect((await request(path, managerToken, joinBody('org', org, '0', orgConsent), joinKey)).status).toBe(200);
    expect((await request(path, managerToken,
      joinBody('org', org, '0', revocable), joinKey)).status).toBe(409);
    expect((await request(path, managerToken,
      joinBody('org', org, '0', orgConsent))).status).toBe(403);
    expect((await read(managerToken)).status).toBe(401);
    const outsiderRead = await read(outsiderToken);
    expect(outsiderRead.status).toBe(200);
    expect(await outsiderRead.json()).toMatchObject({ memberships: [] });
    const recipientRead = await read(recipientToken);
    expect(recipientRead.status).toBe(200);
    const mine = await recipientRead.json() as { memberships: { membershipId: string }[] };
    expect(mine.memberships.map(item => item.membershipId)).toContain(joined.membershipId);
    expect(JSON.stringify(mine)).not.toContain(recipientId);
    const realmJoinedResponse = await request(path, managerToken,
      joinBody('realm', realm, '0', realmConsent));
    expect(realmJoinedResponse.status).toBe(200);
    const realmJoined = await realmJoinedResponse.json() as { membershipId: string;
      generation: string };
    expect(realmJoined.generation).toBe('1');
    const firstPage = await main.handle(new Request(
      'http://main.local/v1/me/private-memberships?limit=1',
      { headers: { authorization: `Bearer ${recipientToken}` } }));
    expect(firstPage.status).toBe(200);
    const page = await firstPage.json() as { memberships: { membershipId: string }[];
      nextCursor: string | null };
    expect(page.memberships.length).toBe(1);
    expect(page.nextCursor).not.toBeNull();
    const secondPage = await main.handle(new Request(
      `http://main.local/v1/me/private-memberships?limit=1&after=${page.nextCursor}`,
      { headers: { authorization: `Bearer ${recipientToken}` } }));
    expect(secondPage.status).toBe(200);
    const nextPage = await secondPage.json() as { memberships: { membershipId: string }[];
      nextCursor: string | null };
    expect(nextPage.memberships.length).toBe(1);
    expect(nextPage.memberships[0]!.membershipId).not.toBe(page.memberships[0]!.membershipId);
    expect(nextPage.nextCursor).toBeNull();
    const directProof = () => admission.register({ principal: {
      issuer: `${base}/api/auth`, subject: recipient.id }, actingSubject: attribution,
      authorityPath: 'direct-principal', scope: 'work:create:root', action: 'work.create',
      idempotencyKey: randomUUID(), requestDigest: createHash('sha256')
        .update(randomUUID()).digest('hex') });
    for (const action of ['access.group.manage', 'access.role.bind']) {
      await accessPool.query(`INSERT INTO access.representation
        (id, principal_id, subject_id, action, valid_until)
        VALUES ($1,$2,$3,$4,now() + interval '1 hour')`,
      [randomUUID(), managerId, org, action]);
      await accessPool.query(`INSERT INTO access.permission_grant
        (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
        VALUES ($1,$2,$2,'work:create:root',$3,now() + interval '1 hour')`,
      [randomUUID(), org, action]);
    }
    for (const action of ['access.group.assign.work.create', 'access.grant.assign.work.create']) {
      await accessPool.query(`INSERT INTO access.permission_grant
        (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
        VALUES ($1,$2,$2,'work:create:root',$3,now() + interval '2 hours')`,
      [randomUUID(), org, action]);
    }
    const groupId = randomUUID(), groupGrantId = randomUUID(), roleFamilyId = randomUUID();
    await accessPool.query(`INSERT INTO access.recipient_group (id, scope_id)
      VALUES ($1,'work:create:root')`, [groupId]);
    await accessPool.query(`INSERT INTO access.group_permission_grant
      (id, group_id, issuer_subject, scope_id, action, valid_until)
      VALUES ($1,$2,$3,'work:create:root','work.create',now() + interval '1 hour')`,
    [groupGrantId, groupId, org]);
    const roleClient = await accessPool.connect();
    try {
      await roleClient.query('BEGIN');
      await roleClient.query(`INSERT INTO access.role_family
        (id, owner_subject, scope_id, head_revision)
        VALUES ($1,$2,'work:create:root',1)`, [roleFamilyId, org]);
      await roleClient.query(`INSERT INTO access.role_revision
        (family_id, revision, permissions) VALUES ($1,1,ARRAY['work.create']::text[])`,
      [roleFamilyId]);
      await roleClient.query('COMMIT');
    } catch (error) { await roleClient.query('ROLLBACK'); throw error; }
    finally { roleClient.release(); }
    const epochs = async () => (await accessPool.query<{
      authority_epoch: string; group_generation: string }>(`SELECT authority_epoch,
      group_generation FROM access.scope_gate WHERE id = 'work:create:root'`)).rows[0]!;
    const groupChange = async (body: object, key = randomUUID()) => request(
      '/v1/access/private-group-member-changes', managerToken, body, key);
    const roleChange = async (body: object, key = randomUUID()) => request(
      '/v1/access/private-role-binding-changes', managerToken, body, key);
    const memberId = randomUUID();
    let current = await epochs();
    const addGroup = { profile: 'access-private-group-member-change-v1',
      action: 'add-group-member', issuerSubject: org, memberId, groupId,
      membershipId: joined.membershipId, membershipGeneration: '1',
      expectedAuthorityEpoch: current.authority_epoch,
      expectedGroupGeneration: current.group_generation };
    expect((await request('/v1/access/private-group-member-changes', outsiderToken,
      addGroup)).status).toBe(403);
    const addGroupKey = randomUUID();
    const addedGroup = await groupChange(addGroup, addGroupKey);
    expect(addedGroup.status).toBe(200);
    const addedGroupBody = await addedGroup.json() as { groupGeneration: string };
    expect(addedGroupBody.groupGeneration).toBe(current.group_generation);
    expect(JSON.stringify(addedGroupBody)).not.toContain(recipientId);
    expect(await (await groupChange(addGroup, addGroupKey)).json()).toMatchObject({ replayed: true });
    expect((await groupChange({ ...addGroup, memberId: randomUUID() }, addGroupKey)).status).toBe(409);
    expect((await accessPool.query<{ principal_id: string }>(`
      SELECT principal_id FROM access.private_group_member WHERE id = $1`,
    [memberId])).rows[0]?.principal_id).toBe(recipientId);
    const publicGroupScope = await main.handle(new Request(
      `http://main.local/v1/access/group-scope?issuerSubject=${encodeURIComponent(org)}`,
      { headers: { authorization: `Bearer ${managerToken}` } }));
    expect(publicGroupScope.status).toBe(200);
    const groupScopeBody = await publicGroupScope.json() as { members: unknown[] };
    expect(groupScopeBody.members).toEqual([]);
    expect(JSON.stringify(groupScopeBody)).not.toContain(recipientId);
    const groupAdmissionRequest = { principal: { issuer: `${base}/api/auth`, subject: recipient.id },
      actingSubject: attribution, authorityPath: 'direct-principal' as const,
      scope: 'work:create:root', action: 'work.create', idempotencyKey: randomUUID(),
      requestDigest: createHash('sha256').update(randomUUID()).digest('hex') };
    const groupProof = await admission.register(groupAdmissionRequest);
    expect(groupProof.dispatchEligible).toBe(true);
    expect((await accessPool.query<{ private_group_member_id: string; private_group_grant_id: string }>(`
      SELECT private_group_member_id, private_group_grant_id
      FROM access.admission WHERE id = $1`, [groupProof.id])).rows[0]).toMatchObject({
      private_group_member_id: memberId, private_group_grant_id: groupGrantId });
    expect((await admission.claim(groupProof.id, groupProof.requestDigest)).state).toBe('claimed');
    const discovery = await main.handle(new Request('http://main.local/v1/me/acting-contexts?task=work.create',
      { headers: { authorization: `Bearer ${recipientToken}` } }));
    expect(discovery.status).toBe(200);
    expect(await discovery.json()).toMatchObject({ directContexts: [{ actingSubject: attribution }] });
    current = await epochs();
    const revokeGroup = { profile: 'access-private-group-member-change-v1',
      action: 'revoke-group-member', issuerSubject: org, memberId,
      expectedObjectGeneration: '0', expectedAuthorityEpoch: current.authority_epoch,
      expectedGroupGeneration: current.group_generation };
    expect((await groupChange(revokeGroup)).status).toBe(200);
    expect((await admission.register(groupAdmissionRequest)).dispatchEligible).toBe(false);
    await expect(admission.claim(groupProof.id, groupProof.requestDigest)).rejects.toThrow();
    expect((await accessPool.query<{ active: boolean }>(`
      SELECT active FROM access.group_permission_grant WHERE id = $1`,
    [groupGrantId])).rows[0]?.active).toBe(true);
    expect((await accessPool.query<{ active: boolean }>(`
      SELECT active FROM access.private_group_member WHERE id = $1`,
    [memberId])).rows[0]?.active).toBe(false);
    current = await epochs();
    const roleBindingId = randomUUID();
    const bindRole = { profile: 'access-private-role-binding-change-v1',
      action: 'bind-role', issuerSubject: org, bindingId: roleBindingId,
      familyId: roleFamilyId, roleRevision: '1', membershipId: joined.membershipId,
      membershipGeneration: '1', validUntil: new Date(Date.now() + 3_600_000).toISOString(),
      expectedAuthorityEpoch: current.authority_epoch };
    const bindRoleKey = randomUUID();
    const boundRole = await roleChange(bindRole, bindRoleKey);
    expect(boundRole.status).toBe(200);
    expect(JSON.stringify(await boundRole.json())).not.toContain(recipientId);
    expect(await (await roleChange(bindRole, bindRoleKey)).json()).toMatchObject({ replayed: true });
    expect((await roleChange({ ...bindRole, bindingId: randomUUID() }, bindRoleKey)).status).toBe(409);
    const roleProof = await directProof();
    expect((await accessPool.query<{ private_role_binding_id: string }>(`
      SELECT private_role_binding_id FROM access.admission WHERE id = $1`,
    [roleProof.id])).rows[0]?.private_role_binding_id).toBe(roleBindingId);
    expect((await admission.claim(roleProof.id, roleProof.requestDigest)).state).toBe('claimed');
    current = await epochs();
    expect((await roleChange({ profile: 'access-private-role-binding-change-v1',
      action: 'revoke-role', issuerSubject: org, bindingId: roleBindingId,
      expectedObjectGeneration: '0', expectedAuthorityEpoch: current.authority_epoch })).status).toBe(200);
    await expect(admission.claim(roleProof.id, roleProof.requestDigest)).rejects.toThrow();
    current = await epochs();
    const activeRoleId = randomUUID();
    expect((await roleChange({ ...bindRole, bindingId: activeRoleId,
      expectedAuthorityEpoch: current.authority_epoch })).status).toBe(200);
    current = await epochs();
    const secondMemberId = randomUUID();
    const addSecondGroup = { ...addGroup, memberId: secondMemberId,
      expectedAuthorityEpoch: current.authority_epoch,
      expectedGroupGeneration: current.group_generation };
    expect((await groupChange(addSecondGroup)).status).toBe(200);
    await expect(accessPool.query(`UPDATE access.private_group_member
      SET private_membership_generation = 3 WHERE id = $1`, [secondMemberId])).rejects.toThrow();
    await expect(accessPool.query(`UPDATE access.private_role_binding
      SET private_membership_generation = 3 WHERE id = $1`, [roleBindingId])).rejects.toThrow();
    const dependentId = randomUUID();
    await accessPool.query(`INSERT INTO access.principal_permission_grant
      (id, issuer_subject, principal_id, scope_id, action, valid_until,
        private_membership_id, private_membership_generation)
      VALUES ($1,$2,$3,'work:create:root','work.create',now() + interval '1 hour',$4,1)`,
    [dependentId, org, recipientId, joined.membershipId]);
    const firstProof = await directProof();
    expect(firstProof.dispatchEligible).toBe(true);
    const independentId = randomUUID();
    await accessPool.query(`INSERT INTO access.principal_permission_grant
      (id, issuer_subject, principal_id, scope_id, action, valid_until)
      VALUES ($1,$2,$3,'work:create:root','work.create',now() + interval '1 hour')`,
    [independentId, realm, recipientId]);
    await accessPool.query(`INSERT INTO access.private_membership_ban
      (kind, owner_subject, principal_id, reason_ref)
      VALUES ('org',$1,$2,'independent-org-ban')`, [org, recipientId]);
    const raceGroupId = randomUUID(), raceMemberId = randomUUID(), raceRoleId = randomUUID();
    await accessPool.query(`INSERT INTO access.recipient_group (id, scope_id)
      VALUES ($1,'work:create:root')`, [raceGroupId]);
    current = await epochs();
    const racingGroup = { ...addGroup, memberId: raceMemberId, groupId: raceGroupId,
      expectedAuthorityEpoch: current.authority_epoch,
      expectedGroupGeneration: current.group_generation };
    const racingRole = { ...bindRole, bindingId: raceRoleId,
      expectedAuthorityEpoch: current.authority_epoch };
    const leaveKey = randomUUID();
    const [racedGroup, racedRole, racedLeave] = await Promise.all([
      groupChange(racingGroup), roleChange(racingRole), request(path, managerToken,
        leaveBody('org', org, '1', joined.membershipId), leaveKey),
    ]);
    expect(racedLeave.status).toBe(200);
    expect([200, 403, 409]).toContain(racedGroup.status);
    expect([200, 403, 409]).toContain(racedRole.status);
    expect((await accessPool.query<{ active: boolean }>(`
      SELECT active FROM access.private_group_member WHERE id = $1`,
    [raceMemberId])).rows[0]?.active).not.toBe(true);
    expect((await accessPool.query<{ active: boolean }>(`
      SELECT active FROM access.private_role_binding WHERE id = $1`,
    [raceRoleId])).rows[0]?.active).not.toBe(true);
    await expect(admission.claim(firstProof.id, firstProof.requestDigest)).rejects.toThrow();
    await expect(admission.claim(roleProof.id, roleProof.requestDigest)).rejects.toThrow();
    expect((await accessPool.query<{ active: boolean }>(`
      SELECT active FROM access.private_group_member WHERE id = $1`,
    [secondMemberId])).rows[0]?.active).toBe(false);
    expect((await accessPool.query<{ active: boolean }>(`
      SELECT active FROM access.private_role_binding WHERE id = $1`,
    [roleBindingId])).rows[0]?.active).toBe(false);
    expect((await accessPool.query<{ active: boolean }>(`
      SELECT active FROM access.private_role_binding WHERE id = $1`,
    [activeRoleId])).rows[0]?.active).toBe(false);
    expect((await accessPool.query<{ active: boolean }>(`
      SELECT active FROM access.group_permission_grant WHERE id = $1`,
    [groupGrantId])).rows[0]?.active).toBe(true);
    expect((await accessPool.query<{ active: boolean }>(`
      SELECT active FROM access.principal_permission_grant WHERE id = $1`,
    [dependentId])).rows[0]?.active).toBe(false);
    expect((await accessPool.query<{ active: boolean }>(`
      SELECT active FROM access.principal_permission_grant WHERE id = $1`,
    [independentId])).rows[0]?.active).toBe(true);
    await accessPool.query('UPDATE access.principal_permission_grant SET active = false WHERE id = $1',
      [independentId]);
    await expect(directProof()).rejects.toThrow();
    await accessPool.query('UPDATE access.principal_permission_grant SET active = true WHERE id = $1',
      [independentId]);
    await expect(accessPool.query(`UPDATE access.principal_permission_grant
      SET active = true WHERE id = $1`, [dependentId])).rejects.toThrow();
    expect((await request(path, managerToken,
      leaveBody('org', org, '1', joined.membershipId), leaveKey)).status).toBe(200);
    expect((await request(path, managerToken,
      leaveBody('org', org, '1', joined.membershipId))).status).toBe(409);
    expect((await request(consentPath, recipientToken,
      consentBody('org', org, '2'))).status).toBe(403);
    expect((await request(consentPath, recipientToken,
      consentBody('realm', realm, '1'))).status).toBe(403);
    await accessPool.query(`UPDATE access.private_membership_ban SET active = false
      WHERE kind = 'org' AND owner_subject = $1 AND principal_id = $2`, [org, recipientId]);
    const rejoinConsent = await issue('org', org, '2');
    expect((await request(path, managerToken,
      joinBody('org', org, '2', orgConsent))).status).toBe(403);
    const competingConsent = await issue('org', org, '2');
    const rejoinAttempts = await Promise.all([
      request(path, managerToken, joinBody('org', org, '2', rejoinConsent)),
      request(path, managerToken, joinBody('org', org, '2', competingConsent)),
    ]);
    expect(rejoinAttempts.map(response => response.status).sort()).toEqual([200, 409]);
    const rejoinedResponse = rejoinAttempts.find(response => response.status === 200)!;
    expect(rejoinedResponse.status).toBe(200);
    expect(await rejoinedResponse.json()).toMatchObject({
      membershipId: joined.membershipId, generation: '3' });
    const historicalReplay = await request(path, managerToken,
      joinBody('org', org, '0', orgConsent), joinKey);
    expect(historicalReplay.status).toBe(200);
    expect(await historicalReplay.json()).toMatchObject({
      membershipId: joined.membershipId, generation: '1', replayed: true });
    await expect(accessPool.query(`UPDATE access.principal_permission_grant
      SET private_membership_generation = 3, active = true WHERE id = $1`,
    [dependentId])).rejects.toThrow();
    await expect(accessPool.query(`UPDATE access.private_group_member
      SET active = true WHERE id = $1`, [secondMemberId])).rejects.toThrow();
    await expect(accessPool.query(`UPDATE access.private_role_binding
      SET active = true WHERE id = $1`, [roleBindingId])).rejects.toThrow();
    await expect(accessPool.query(`INSERT INTO access.private_group_member
      (id, group_id, principal_id, private_membership_id,
        private_membership_generation, assigned_by_principal)
      VALUES ($1,$2,$3,$4,1,$5)`,
    [randomUUID(), raceGroupId, recipientId, joined.membershipId, managerId])).rejects.toThrow();
    await expect(accessPool.query(`INSERT INTO access.private_role_binding
      (id, family_id, role_revision, issuer_subject, principal_id,
        private_membership_id, private_membership_generation, valid_until,
        assigned_by_principal)
      VALUES ($1,$2,1,$3,$4,$5,1,now() + interval '1 hour',$6)`,
    [randomUUID(), roleFamilyId, org, recipientId, joined.membershipId,
      managerId])).rejects.toThrow();
    await expect(accessPool.query(`UPDATE access.private_membership
      SET generation = 1 WHERE id = $1`, [joined.membershipId])).rejects.toThrow();
    await expect(accessPool.query(`UPDATE access.private_membership_history
      SET state = 'left' WHERE membership_id = $1 AND generation = 1`,
    [joined.membershipId])).rejects.toThrow();
    const newDependentId = randomUUID();
    await accessPool.query(`INSERT INTO access.principal_permission_grant
      (id, issuer_subject, principal_id, scope_id, action, valid_until,
        private_membership_id, private_membership_generation)
      VALUES ($1,$2,$3,'work:create:root','work.create',now() + interval '1 hour',$4,3)`,
    [newDependentId, org, recipientId, joined.membershipId]);
    current = await epochs();
    const rejoinedMemberId = randomUUID(), rejoinedRoleId = randomUUID();
    expect((await groupChange({ ...addGroup, memberId: rejoinedMemberId,
      membershipGeneration: '3', expectedAuthorityEpoch: current.authority_epoch,
      expectedGroupGeneration: current.group_generation })).status).toBe(200);
    current = await epochs();
    expect((await roleChange({ ...bindRole, bindingId: rejoinedRoleId,
      membershipGeneration: '3', expectedAuthorityEpoch: current.authority_epoch })).status).toBe(200);
    await accessPool.query(`INSERT INTO access.principal_permission_grant
      (id, issuer_subject, principal_id, scope_id, action, valid_until,
        private_membership_id, private_membership_generation)
      SELECT gen_random_uuid(), $1, $2, 'work:create:root', 'work.create',
        now() + interval '1 hour', $3, 3 FROM generate_series(1, 254)`,
    [org, recipientId, joined.membershipId]);
    expect((await request(path, managerToken,
      leaveBody('org', org, '3', joined.membershipId))).status).toBe(503);
    expect((await accessPool.query<{ generation: string; state: string }>(`
      SELECT generation, state FROM access.private_membership WHERE id = $1`,
    [joined.membershipId])).rows[0]).toMatchObject({ generation: '3', state: 'joined' });
    expect((await accessPool.query<{ active: boolean }>(`
      SELECT active FROM access.private_group_member WHERE id = $1`,
    [rejoinedMemberId])).rows[0]?.active).toBe(true);
    expect((await accessPool.query<{ active: boolean }>(`
      SELECT active FROM access.private_role_binding WHERE id = $1`,
    [rejoinedRoleId])).rows[0]?.active).toBe(true);
    await accessPool.query(`UPDATE access.membership_policy SET open = false
      WHERE kind = 'realm' AND owner_subject = $1`, [realm]);
    expect((await request(path, managerToken,
      leaveBody('realm', realm, '1', realmJoined.membershipId))).status).toBe(200);
    expect((await accessPool.query<{ active: boolean }>(`
      SELECT active FROM access.principal_permission_grant WHERE id = $1`,
    [newDependentId])).rows[0]?.active).toBe(true);
    const beforeFence = await directProof();
    await admission.strongDeactivatePrincipal(recipientId, '0');
    await expect(admission.claim(beforeFence.id, beforeFence.requestDigest)).rejects.toThrow();
    await expect(directProof()).rejects.toThrow();
    current = await epochs();
    expect((await groupChange({ ...addGroup, memberId: randomUUID(),
      membershipGeneration: '3', expectedAuthorityEpoch: current.authority_epoch,
      expectedGroupGeneration: current.group_generation })).status).toBe(403);
    expect((await read(recipientToken)).status).toBe(403);
    expect((await request(consentPath, recipientToken,
      consentBody('org', org, '3'))).status).toBe(403);
    const deleted = await admission.strongDeactivateAccountSubject(`${base}/api/auth`, recipient.id);
    expect(deleted?.principalId).toBe(recipientId);
    expect((await accessPool.query<{ kind: string }>(`SELECT kind FROM access.outbox
      WHERE principal_id = $1 AND kind = 'account.deletion_fenced'`,
    [recipientId])).rows[0]?.kind).toBe('account.deletion_fenced');
    expect((await accessPool.query<{ generation: string }>(`
      SELECT generation FROM access.private_membership WHERE id = $1`,
    [joined.membershipId])).rows[0]?.generation).toBe('3');
    expect(await accessStateCoverage(accessPool)).not.toEqual(before);
    await accessPool.query('UPDATE access.recovery_fence SET open = false WHERE id = true');
    expect((await request(path, managerToken,
      leaveBody('org', org, '3', joined.membershipId))).status).toBe(503);
    await accessPool.query('UPDATE access.recovery_fence SET open = true WHERE id = true');
    // The unused independent grant is deliberately retained by the membership leave.
    expect((await accessPool.query<{ active: boolean }>(`
      SELECT active FROM access.principal_permission_grant WHERE id = $1`,
    [independentId])).rows[0]?.active).toBe(true);
  } finally {
    await account.stop();
    await Promise.all([accountPool.end(), accessPool.end()]);
    await databases.close();
    rmSync(state, { recursive: true, force: true });
  }
}, 180_000);
