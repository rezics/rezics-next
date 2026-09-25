import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { expect, test } from 'bun:test';
import { getMigrations } from 'better-auth/db/migration';
import { Pool } from 'pg';
import { cloneQaAccountAccessDatabases } from '../../../tests/qa/support/databases.ts';
import { accountAuthOptions, createAccountAuth } from '../../account/src/auth.ts';
import { createAccountApp } from '../../account/src/app.ts';
import { installConsentRefreshFence } from '../../account/src/consent-fence.ts';
import { createMainApp } from '../src/app.ts';
import { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { AccessAdmissionRegistry, AdmissionDenied } from '../src/modules/access/admission.ts';
import { AccessActingContexts } from '../src/modules/access/contexts.ts';
import { AccessGroups, GroupDenied, GroupStale, GroupUnavailable,
  groupWorkCreateProof } from '../src/modules/access/groups.ts';
import { AccountAssertionVerifier } from '../src/modules/account/verify-assertion.ts';
import { accessStateCoverage } from '../src/modules/work/access-recovery-coverage.ts';

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('no test port'));
      server.close(() => resolvePort(address.port));
    });
  });
}

test('IAM01/IAM03/IAM04: Account and Access check explicit Agents without pooling or tab state', async () => {
  const runId = Bun.env.REZICS_QA_RUN_ID;
  if (!runId || !Bun.env.ACCOUNT_DATABASE_URL || !Bun.env.ACCESS_DATABASE_URL
    || !Bun.env.FUSEKI_URL || !Bun.env.MAIN_DATA_EPOCH || !Bun.env.MAIN_ROUTING_EPOCH
    || !Bun.env.MAIN_OBJECT_DIRECTORY || !Bun.env.ACCOUNT_SECRET
    || !Bun.env.ACCOUNT_MAIN_RESOURCE) {
    throw new Error('Run through the isolated QA integration tier');
  }
  const databases = await cloneQaAccountAccessDatabases(runId);
  const accountPool = new Pool({ connectionString: databases.urls.account, max: 8 });
  const accessPool = new Pool({ connectionString: databases.urls.access, max: 8 });
  const accountPort = await freePort();
  const base = `http://127.0.0.1:${accountPort}`;
  const resource = Bun.env.ACCOUNT_MAIN_RESOURCE;
  const operators = new Set<string>();
  const config = { baseURL: base, secret: Bun.env.ACCOUNT_SECRET,
    resource, pool: accountPool, operatorUserIds: operators };
  let account: ReturnType<typeof createAccountApp> | undefined;
  try {
    const migration = await getMigrations(accountAuthOptions(config));
    expect(migration.unsafeChanges).toEqual([]);
    expect(migration.schemaProblems).toEqual([]);
    await migration.runMigrations();
    await installConsentRefreshFence(accountPool);
    const auth = createAccountAuth(config);
    account = createAccountApp(auth, accountPool).listen({ hostname: '127.0.0.1', port: accountPort });
    const signUp = async (name: string) => {
      const email = `${name}-${randomUUID()}@example.test`;
      const password = randomBytes(24).toString('base64url');
      const response = await fetch(`${base}/api/auth/sign-up/email`, { method: 'POST',
        headers: { 'content-type': 'application/json', origin: base },
        body: JSON.stringify({ name, email, password }) });
      expect(response.status).toBe(200);
      const body = await response.json() as { user: { id: string } };
      return { id: body.user.id, email, password, cookie: response.headers.get('set-cookie')! };
    };
    const operator = await signUp('operator');
    operators.add(operator.id);
    const adminHeaders = new Headers({ cookie: operator.cookie, origin: base });
    const mainClient = await auth.api.adminCreateOAuthClient({ headers: adminHeaders,
      body: { client_name: 'Acting context Main verifier', scope: 'work:create',
        token_endpoint_auth_method: 'client_secret_post', grant_types: ['client_credentials'],
        client_credentials_scopes: ['work:create'] } });
    const redirectUri = 'http://localhost:3000/auth/callback';
    const webClient = await auth.api.adminCreateOAuthClient({ headers: adminHeaders,
      body: { client_name: 'Acting context browser', application_type: 'native',
        redirect_uris: [redirectUri], token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code'], scope: 'openid work:create',
        skip_consent: true, require_pkce: true } });
    const first = await signUp('first');
    const second = await signUp('second');
    const tokenFor = async (member: typeof first) => {
      const signedIn = await fetch(`${base}/api/auth/sign-in/email`, { method: 'POST',
        headers: { 'content-type': 'application/json', origin: base },
        body: JSON.stringify({ email: member.email, password: member.password }) });
      expect(signedIn.status).toBe(200);
      const verifier = randomBytes(32).toString('base64url');
      const authorize = new URL(`${base}/api/auth/oauth2/authorize`);
      for (const [key, value] of Object.entries({ response_type: 'code',
        client_id: webClient.client_id, redirect_uri: redirectUri,
        scope: 'openid work:create', state: randomUUID(), resource,
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256',
      })) authorize.searchParams.set(key, value);
      const approved = await fetch(authorize, {
        headers: { cookie: signedIn.headers.get('set-cookie')! }, redirect: 'manual' });
      expect(approved.status).toBe(302);
      const code = new URL(approved.headers.get('location')!).searchParams.get('code')!;
      const exchange = await fetch(`${base}/api/auth/oauth2/token`, { method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code',
          client_id: webClient.client_id, code, redirect_uri: redirectUri,
          code_verifier: verifier, resource }) });
      expect(exchange.status).toBe(200);
      return (await exchange.json() as { access_token: string }).access_token;
    };
    const [firstToken, secondToken] = await Promise.all([tokenFor(first), tokenFor(second)]);
    const principalOne = randomUUID();
    const principalTwo = randomUUID();
    const agents = Array.from({ length: 4 }, () => `https://rezics.com/id/${randomUUID()}`);
    const [agentA, agentB, grantedOnly, representedOnly] = agents as [string, string, string, string];
    const institution = `https://rezics.com/id/${randomUUID()}`;
    for (const [id, member] of [[principalOne, first], [principalTwo, second]] as const) {
      await accessPool.query(`INSERT INTO access.principal (id, account_issuer, account_subject)
        VALUES ($1,$2,$3)`, [id, `${base}/api/auth`, member.id]);
    }
    for (const agent of agents) {
      await accessPool.query("INSERT INTO access.authority_subject (id, kind) VALUES ($1,'agent')", [agent]);
    }
    await accessPool.query("INSERT INTO access.authority_subject (id, kind) VALUES ($1,'institution')",
      [institution]);
    await accessPool.query("INSERT INTO access.scope_gate (id) VALUES ('work:create:root')");
    const represent = async (principal: string, agent: string) => accessPool.query(`
      INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until)
      VALUES ($1,$2,$3,'work.create',now() + interval '1 hour')`,
    [randomUUID(), principal, agent]);
    const grant = async (agent: string) => accessPool.query(`
      INSERT INTO access.permission_grant
        (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1,$2,$2,'work:create:root','work.create',now() + interval '1 hour')`,
    [randomUUID(), agent]);
    await Promise.all([
      represent(principalOne, agentA), represent(principalOne, agentB),
      represent(principalOne, representedOnly), represent(principalTwo, agentA),
      represent(principalOne, institution),
      grant(agentA), grant(agentB), grant(grantedOnly), grant(institution),
    ]);
    const fuseki = new FusekiClient(Bun.env.FUSEKI_URL);
    const access = new AccessAdmissionRegistry(accessPool);
    const main = createMainApp(fuseki, {
      environment: { fuseki, lineage: { dataEpoch: Bun.env.MAIN_DATA_EPOCH,
        routingEpoch: Bun.env.MAIN_ROUTING_EPOCH },
        objectDirectory: Bun.env.MAIN_OBJECT_DIRECTORY },
      account: new AccountAssertionVerifier({ issuer: `${base}/api/auth`, audience: resource,
        jwksUrl: `${base}/api/auth/jwks`, introspectUrl: `${base}/api/auth/oauth2/introspect`,
        clientId: mainClient.client_id, clientSecret: mainClient.client_secret! }),
      access, actingContexts: new AccessActingContexts(accessPool),
    });
    const discover = (token: string) => main.handle(new Request(
      'http://main.local/v1/me/acting-contexts?task=work.create',
      { headers: { authorization: `Bearer ${token}` } }));
    expect((await main.handle(new Request(
      'http://main.local/v1/me/acting-contexts?task=work.create'))).status).toBe(401);
    const firstDiscovery = await discover(firstToken);
    expect(firstDiscovery.status).toBe(200);
    const firstBody = await firstDiscovery.json() as { authorityEpoch: string;
      contexts: Array<{ actingSubject: string }>;
      directContexts: Array<{ actingSubject: string }>;
      preferredActingSubject: string | null; preferenceRevision: string | null };
    expect(firstBody.contexts.map(item => item.actingSubject).sort())
      .toEqual([agentA, agentB].sort());
    expect(firstBody.preferredActingSubject).toBeNull();
    expect(firstBody.preferenceRevision).toBeNull();
    expect(firstBody.directContexts).toEqual([]);
    expect(JSON.stringify(firstBody)).not.toContain(principalOne);
    expect(JSON.stringify(firstBody)).not.toContain(principalTwo);
    expect(JSON.stringify(firstBody)).not.toContain(first.id);
    expect(JSON.stringify(firstBody)).not.toContain(second.id);
    const secondDiscovery = await discover(secondToken);
    expect(secondDiscovery.status).toBe(200);
    expect((await secondDiscovery.json() as { contexts: Array<{ actingSubject: string }> })
      .contexts).toEqual([{ actingSubject: agentA }]);
    const check = (token: string, actingSubject: string,
      expectedAuthorityEpoch = firstBody.authorityEpoch,
      authorityPath: 'represented-agent' | 'direct-principal' = 'represented-agent') =>
      main.handle(new Request('http://main.local/v1/me/acting-context-checks', {
        method: 'POST', headers: { 'content-type': 'application/json',
          authorization: `Bearer ${token}` },
        body: JSON.stringify({ profile: 'work-create-acting-context-check-v1',
          task: 'work.create', actingSubject, expectedAuthorityEpoch, authorityPath }),
      }));
    const [tabA, tabB] = await Promise.all([
      check(firstToken, agentA), check(firstToken, agentB),
    ]);
    expect(tabA.status).toBe(200);
    expect(tabB.status).toBe(200);
    expect(await tabA.json()).toMatchObject({ actingSubject: agentA,
      decision: 'eligible-now', reusable: false });
    expect(await tabB.json()).toMatchObject({ actingSubject: agentB,
      decision: 'eligible-now', reusable: false });
    expect((await check(firstToken, agentA)).status).toBe(200);
    expect((await check(secondToken, agentA)).status).toBe(200);
    // IAM04: the principal grant and public attribution are each necessary.
    // Neither is a representation path or an Agent permission grant.
    const coverageBeforeDirect = await accessStateCoverage(accessPool);
    const directGrant = randomUUID();
    const attribution = randomUUID();
    await accessPool.query(`INSERT INTO access.principal_permission_grant
      (id, issuer_subject, principal_id, scope_id, action, valid_until)
      VALUES ($1,$2,$3,'work:create:root','work.create',now() + interval '1 hour')`,
    [directGrant, agentA, principalOne]);
    expect((await check(firstToken, representedOnly, firstBody.authorityEpoch,
      'direct-principal')).status).toBe(403);
    await accessPool.query(`INSERT INTO access.principal_agent_attribution
      (id, principal_id, agent_subject, action, valid_until)
      VALUES ($1,$2,$3,'work.create',now() + interval '1 hour')`,
    [attribution, principalOne, representedOnly]);
    const coverageAfterDirect = await accessStateCoverage(accessPool);
    expect(BigInt(coverageAfterDirect.count) - BigInt(coverageBeforeDirect.count)).toBe(2n);
    expect(coverageAfterDirect.digest).not.toBe(coverageBeforeDirect.digest);
    expect((await check(firstToken, representedOnly)).status).toBe(403);
    expect((await check(firstToken, representedOnly, firstBody.authorityEpoch,
      'direct-principal')).status).toBe(200);
    expect((await check(secondToken, representedOnly, firstBody.authorityEpoch,
      'direct-principal')).status).toBe(403);
    const directDiscovery = await (await discover(firstToken)).json() as {
      contexts: Array<{ actingSubject: string }>;
      directContexts: Array<{ actingSubject: string }> };
    expect(directDiscovery.contexts.map(item => item.actingSubject).sort())
      .toEqual([agentA, agentB].sort());
    expect(directDiscovery.directContexts).toEqual([{ actingSubject: representedOnly }]);
    const directRequest = { principal: { issuer: `${base}/api/auth`, subject: first.id },
      actingSubject: representedOnly, authorityPath: 'direct-principal' as const,
      scope: 'work:create:root', action: 'work.create',
      idempotencyKey: randomUUID(), requestDigest: createHash('sha256').update('IAM04').digest('hex') };
    await expect(access.register({ ...directRequest, authorityPath: 'represented-agent' }))
      .rejects.toBeInstanceOf(AdmissionDenied);
    const directAdmission = await access.register(directRequest);
    expect(directAdmission).toMatchObject({ authorityPath: 'direct-principal',
      actingSubject: representedOnly, dispatchEligible: true });
    const [selectedAgent, selectedDirect] = await Promise.all([
      check(firstToken, representedOnly),
      check(firstToken, representedOnly, firstBody.authorityEpoch, 'direct-principal'),
    ]);
    expect([selectedAgent.status, selectedDirect.status]).toEqual([403, 200]);
    await accessPool.query(`UPDATE access.principal_permission_grant
      SET active = false, generation = generation + 1 WHERE id = $1`, [directGrant]);
    expect((await check(firstToken, representedOnly, firstBody.authorityEpoch,
      'direct-principal')).status).toBe(403);
    await expect(access.claim(directAdmission.id, directRequest.requestDigest))
      .rejects.toBeInstanceOf(AdmissionDenied);
    await accessPool.query(`UPDATE access.principal_permission_grant
      SET active = true, generation = generation + 1 WHERE id = $1`, [directGrant]);
    await accessPool.query(`UPDATE access.principal_agent_attribution
      SET active = false, generation = generation + 1 WHERE id = $1`, [attribution]);
    expect((await check(firstToken, representedOnly, firstBody.authorityEpoch,
      'direct-principal')).status).toBe(403);
    await expect(access.claim(directAdmission.id, directRequest.requestDigest))
      .rejects.toBeInstanceOf(AdmissionDenied);
    await accessPool.query(`UPDATE access.principal_agent_attribution
      SET active = true, generation = generation + 1 WHERE id = $1`, [attribution]);
    await expect(access.claim(directAdmission.id, directRequest.requestDigest))
      .rejects.toBeInstanceOf(AdmissionDenied);
    const freshDirectAdmission = await access.register({ ...directRequest,
      idempotencyKey: randomUUID() });
    expect((await access.claim(freshDirectAdmission.id, directRequest.requestDigest)).authorityPath)
      .toBe('direct-principal');
    // A deactivated and reactivated public Agent is a different proof generation.
    const agentEpochAdmission = await access.register({ ...directRequest,
      idempotencyKey: randomUUID() });
    await accessPool.query(`UPDATE access.authority_subject
      SET active = false, generation = generation + 1 WHERE id = $1`, [representedOnly]);
    expect((await check(firstToken, representedOnly, firstBody.authorityEpoch,
      'direct-principal')).status).toBe(403);
    await expect(access.claim(agentEpochAdmission.id, directRequest.requestDigest))
      .rejects.toBeInstanceOf(AdmissionDenied);
    await accessPool.query(`UPDATE access.authority_subject
      SET active = true, generation = generation + 1 WHERE id = $1`, [representedOnly]);
    expect((await check(firstToken, representedOnly, firstBody.authorityEpoch,
      'direct-principal')).status).toBe(200);
    await expect(access.claim(agentEpochAdmission.id, directRequest.requestDigest))
      .rejects.toBeInstanceOf(AdmissionDenied);
    // The authenticated principal's enforcement epoch is bound independently.
    const principalEpochAdmission = await access.register({ ...directRequest,
      idempotencyKey: randomUUID() });
    await accessPool.query(`UPDATE access.principal
      SET active = false, enforcement_epoch = enforcement_epoch + 1 WHERE id = $1`, [principalOne]);
    expect((await check(firstToken, representedOnly, firstBody.authorityEpoch,
      'direct-principal')).status).toBe(403);
    await expect(access.claim(principalEpochAdmission.id, directRequest.requestDigest))
      .rejects.toBeInstanceOf(AdmissionDenied);
    await accessPool.query(`UPDATE access.principal
      SET active = true, enforcement_epoch = enforcement_epoch + 1 WHERE id = $1`, [principalOne]);
    await expect(access.claim(principalEpochAdmission.id, directRequest.requestDigest))
      .rejects.toBeInstanceOf(AdmissionDenied);
    const currentDirectAdmission = await access.register({ ...directRequest,
      idempotencyKey: randomUUID() });
    expect((await access.claim(currentDirectAdmission.id, directRequest.requestDigest)).authorityPath)
      .toBe('direct-principal');
    const prefer = (token: string, actingSubject: string | null,
      expectedRevision: string | null, idempotencyKey: string = randomUUID()) =>
      main.handle(new Request('http://main.local/v1/me/acting-context-preferences/work.create', {
        method: 'PUT', headers: { 'content-type': 'application/json',
          authorization: `Bearer ${token}` },
        body: JSON.stringify({ profile: 'work-create-acting-context-preference-v1',
          task: 'work.create', actingSubject, expectedRevision, idempotencyKey }),
      }));
    const firstKey = randomUUID();
    const coverageBeforePreference = await accessStateCoverage(accessPool);
    const firstPreference = await prefer(firstToken, agentA, null, firstKey);
    expect(firstPreference.status).toBe(200);
    const preferredA = await firstPreference.json() as { revision: string;
      actingSubject: string | null; replayed: boolean };
    expect(preferredA).toMatchObject({ actingSubject: agentA, replayed: false });
    const coverageAfterPreference = await accessStateCoverage(accessPool);
    expect(BigInt(coverageAfterPreference.count) - BigInt(coverageBeforePreference.count)).toBe(2n);
    expect(coverageAfterPreference.digest).not.toBe(coverageBeforePreference.digest);
    expect((await (await prefer(firstToken, agentA, null, firstKey)).json()))
      .toMatchObject({ revision: preferredA.revision, replayed: true });
    expect(await accessStateCoverage(accessPool)).toEqual(coverageAfterPreference);
    expect((await prefer(firstToken, agentB, null, firstKey)).status).toBe(409);
    expect((await prefer(firstToken, agentA, preferredA.revision, 'bad key')).status).toBe(400);
    expect((await prefer(firstToken, institution, preferredA.revision)).status).toBe(403);
    expect((await prefer(firstToken, agentB, null)).status).toBe(409);
    expect((await prefer(secondToken, agentB, null)).status).toBe(403);
    const secondPreference = await prefer(firstToken, agentB, preferredA.revision);
    expect(secondPreference.status).toBe(200);
    let preferredB = await secondPreference.json() as { revision: string };
    expect(preferredB.revision).not.toBe(preferredA.revision);
    const competing = await Promise.all([
      prefer(firstToken, null, preferredB.revision),
      prefer(firstToken, agentA, preferredB.revision),
    ]);
    expect(competing.map(result => result.status).sort()).toEqual([200, 409]);
    const winner = competing.find(result => result.status === 200);
    if (!winner) throw new Error('concurrent preference write had no winner');
    const winningRevision = (await winner.json() as { revision: string }).revision;
    const restoredPreference = await prefer(firstToken, agentB, winningRevision);
    expect(restoredPreference.status).toBe(200);
    preferredB = await restoredPreference.json() as { revision: string };
    expect(await (await prefer(firstToken, agentA, null, firstKey)).json())
      .toMatchObject({ revision: preferredA.revision, replayed: true });
    expect(await (await discover(firstToken)).json()).toMatchObject({
      preferredActingSubject: agentB, preferenceRevision: preferredB.revision,
    });
    expect(await (await discover(secondToken)).json()).toMatchObject({
      preferredActingSubject: null, preferenceRevision: null,
    });
    // The saved default never retargets an already selected tab/request.
    expect((await check(firstToken, agentA)).status).toBe(200);
    for (const unavailable of [grantedOnly, representedOnly, institution,
      `https://rezics.com/id/${randomUUID()}`]) {
      expect((await check(firstToken, unavailable)).status).toBe(403);
    }
    expect((await check(secondToken, agentB)).status).toBe(403);
    // A discovery result is not a capability: both dependency types are read
    // again before a selected Agent can be used for a check.
    await accessPool.query(`UPDATE access.representation SET active = false, generation = generation + 1
      WHERE principal_id = $1 AND subject_id = $2 AND action = 'work.create'`,
    [principalOne, agentB]);
    expect((await check(firstToken, agentB)).status).toBe(403);
    expect(await (await discover(firstToken)).json()).toMatchObject({
      preferredActingSubject: null, preferenceRevision: preferredB.revision,
    });
    const cleared = await prefer(firstToken, null, preferredB.revision);
    expect(cleared.status).toBe(200);
    const clearedBody = await cleared.json() as { revision: string };
    expect(await (await discover(firstToken)).json()).toMatchObject({
      preferredActingSubject: null, preferenceRevision: clearedBody.revision,
    });
    expect((await check(firstToken, agentA)).status).toBe(200);
    await accessPool.query(`UPDATE access.permission_grant SET active = false, generation = generation + 1
      WHERE recipient_subject = $1 AND scope_id = 'work:create:root' AND action = 'work.create'`,
    [agentA]);
    expect((await check(firstToken, agentA)).status).toBe(403);
    expect((await check(secondToken, agentA)).status).toBe(403);
    await accessPool.query(`UPDATE access.permission_grant SET active = true, generation = generation + 1
      WHERE recipient_subject = $1 AND scope_id = 'work:create:root' AND action = 'work.create'`,
    [agentA]);
    expect((await check(firstToken, agentA)).status).toBe(200);
    const beforeClose = await discover(firstToken);
    expect(beforeClose.status).toBe(200);
    expect(await beforeClose.json()).toMatchObject({
      contexts: [{ actingSubject: agentA }],
    });
    const scopeEpochDirect = await access.register({ ...directRequest,
      idempotencyKey: randomUUID() });
    const scopeEpochRepresented = await access.register({ ...directRequest,
      actingSubject: agentA, authorityPath: 'represented-agent',
      idempotencyKey: randomUUID() });
    const closed = await access.strongCloseScope('work:create:root', firstBody.authorityEpoch);
    expect(closed.authorityEpoch).not.toBe(firstBody.authorityEpoch);
    const fenced = await accessPool.query<{ open: boolean; dispatch_open: boolean }>(
      "SELECT open, dispatch_open FROM access.scope_gate WHERE id = 'work:create:root'");
    expect(fenced.rows[0]).toMatchObject({ open: false, dispatch_open: false });
    const stale = await check(firstToken, agentA);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: 'stale_context' });
    expect((await check(firstToken, representedOnly, firstBody.authorityEpoch,
      'direct-principal')).status).toBe(409);
    expect((await check(firstToken, agentA, closed.authorityEpoch)).status).toBe(403);
    expect((await check(firstToken, representedOnly, closed.authorityEpoch,
      'direct-principal')).status).toBe(403);
    expect((await prefer(firstToken, agentA, clearedBody.revision)).status).toBe(403);
    expect((await prefer(firstToken, null, clearedBody.revision)).status).toBe(200);
    const afterClose = await discover(firstToken);
    expect(afterClose.status).toBe(200);
    expect(await afterClose.json()).toMatchObject({ authorityEpoch: closed.authorityEpoch,
      contexts: [], complete: true });
    // A later reopening cannot revive either mode's old admission.
    await accessPool.query(`UPDATE access.scope_gate SET open = true, dispatch_open = true
      WHERE id = 'work:create:root'`);
    await expect(access.claim(scopeEpochDirect.id, directRequest.requestDigest))
      .rejects.toBeInstanceOf(AdmissionDenied);
    await expect(access.claim(scopeEpochRepresented.id, directRequest.requestDigest))
      .rejects.toBeInstanceOf(AdmissionDenied);

    // IAM36 first profile: private Agent memberships, same-scope parent grant,
    // and a claim that cannot keep an old group path after its grant changes.
    const groupManager = new AccessGroups(accessPool);
    const managerRepresentation = randomUUID();
    await accessPool.query(`INSERT INTO access.representation
      (id, principal_id, subject_id, action, valid_until)
      VALUES ($1,$2,$3,'access.group.manage',now() + interval '2 hours')`,
    [managerRepresentation, principalOne, agentA]);
    for (const action of ['access.group.manage', 'access.group.assign.work.create']) {
      await accessPool.query(`INSERT INTO access.permission_grant
        (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
        VALUES ($1,$2,$2,'work:create:root',$3,now() + interval '2 hours')`,
      [randomUUID(), agentA, action]);
    }
    const parentMember = `https://rezics.com/id/${randomUUID()}`;
    await accessPool.query("INSERT INTO access.authority_subject (id, kind) VALUES ($1,'agent')",
      [parentMember]);
    await represent(principalOne, parentMember);
    const parent = randomUUID();
    const child = randomUUID();
    const parentMembership = randomUUID();
    const childMembership = randomUUID();
    const childGrant = randomUUID();
    let groupGeneration = '0';
    const mutation = () => ({ principal: { issuer: `${base}/api/auth`, subject: first.id },
      issuerSubject: agentA, expectedGroupGeneration: groupGeneration });
    groupGeneration = await groupManager.create(mutation(), parent, null);
    groupGeneration = await groupManager.create(mutation(), child, parent);
    groupGeneration = await groupManager.addMember(mutation(), parentMembership, parent, parentMember);
    groupGeneration = await groupManager.addMember(mutation(), childMembership, child, representedOnly);
    const until = new Date(Date.now() + 60 * 60_000);
    groupGeneration = await groupManager.grant(mutation(), childGrant, child, until);
    const proofClient = await accessPool.connect();
    try {
      expect(await groupWorkCreateProof(proofClient, parentMember)).toBeNull();
    } finally { proofClient.release(); }
    expect((await check(firstToken, parentMember, closed.authorityEpoch)).status).toBe(403);
    expect((await check(firstToken, representedOnly, closed.authorityEpoch)).status).toBe(200);
    const childDiscovery = await (await discover(firstToken)).json() as {
      contexts: Array<{ actingSubject: string }> };
    expect(childDiscovery.contexts).toContainEqual({ actingSubject: representedOnly });
    expect(JSON.stringify(childDiscovery)).not.toContain(child);
    const groupRequest = { ...directRequest, authorityPath: 'represented-agent' as const,
      idempotencyKey: randomUUID() };
    const childAdmission = await access.register(groupRequest);
    const savedProof = await accessPool.query<{ group_member_id: string; group_grant_id: string }>(
      'SELECT group_member_id, group_grant_id FROM access.admission WHERE id = $1', [childAdmission.id]);
    expect(savedProof.rows[0]).toMatchObject({ group_member_id: childMembership,
      group_grant_id: childGrant });
    await expect(groupManager.reparent({ ...mutation(), expectedGroupGeneration: '0' },
      child, '0', null)).rejects.toBeInstanceOf(GroupStale);
    await expect(groupManager.reparent(mutation(), parent, '0', child))
      .rejects.toBeInstanceOf(GroupDenied);
    await expect(groupManager.reparent(mutation(), child, '0', null))
      .rejects.toBeInstanceOf(GroupDenied);
    groupGeneration = await groupManager.revokeGrant(mutation(), childGrant, '0');
    await expect(access.claim(childAdmission.id, groupRequest.requestDigest))
      .rejects.toBeInstanceOf(AdmissionDenied);
    expect((await check(firstToken, representedOnly, closed.authorityEpoch)).status).toBe(403);
    const parentGrant = randomUUID();
    groupGeneration = await groupManager.grant(mutation(), parentGrant, parent, until);
    expect((await check(firstToken, representedOnly, closed.authorityEpoch)).status).toBe(200);
    expect((await check(firstToken, parentMember, closed.authorityEpoch)).status).toBe(200);
    const inherited = await access.register({ ...groupRequest, idempotencyKey: randomUUID() });
    expect((await access.claim(inherited.id, groupRequest.requestDigest)).state).toBe('claimed');

    const emptyRoot = randomUUID();
    const emptyChild = randomUUID();
    groupGeneration = await groupManager.create(mutation(), emptyRoot, null);
    groupGeneration = await groupManager.create(mutation(), emptyChild, emptyRoot);
    await expect(groupManager.reparent(mutation(), emptyRoot, '0', emptyChild))
      .rejects.toBeInstanceOf(GroupDenied);

    // Admission refuses a hierarchy deeper than the qualified 32-edge profile.
    let deepest = parent;
    for (let depth = 1; depth <= 32; depth++) {
      const next = randomUUID();
      groupGeneration = await groupManager.create(mutation(), next, deepest);
      deepest = next;
    }
    await expect(groupManager.create(mutation(), randomUUID(), deepest))
      .rejects.toBeInstanceOf(GroupUnavailable);

    // Both authority modes share the same discovery output ceiling. A 51st
    // complete choice must be unavailable, never a truncated complete list.
    const beforeLimit = await discover(firstToken);
    expect(beforeLimit.status).toBe(200);
    const beforeLimitBody = await beforeLimit.json() as {
      contexts: unknown[]; directContexts: unknown[] };
    const missing = 50 - beforeLimitBody.contexts.length - beforeLimitBody.directContexts.length;
    expect(missing).toBeGreaterThan(0);
    const extraAgents = Array.from({ length: missing + 1 }, () =>
      `https://rezics.com/id/${randomUUID()}`);
    await accessPool.query(`INSERT INTO access.authority_subject (id, kind)
      SELECT id, 'agent' FROM unnest($1::text[]) AS id`, [extraAgents]);
    await accessPool.query(`INSERT INTO access.principal_agent_attribution
      (id, principal_id, agent_subject, action, valid_until)
      SELECT gen_random_uuid(), $2, agent, 'work.create', now() + interval '1 hour'
      FROM unnest($1::text[]) AS agent`, [extraAgents.slice(0, missing), principalOne]);
    const atCeiling = await discover(firstToken);
    expect(atCeiling.status).toBe(200);
    const atCeilingBody = await atCeiling.json() as {
      contexts: unknown[]; directContexts: unknown[]; complete: boolean };
    expect(atCeilingBody.contexts.length + atCeilingBody.directContexts.length).toBe(50);
    expect(atCeilingBody.complete).toBe(true);
    await accessPool.query(`INSERT INTO access.principal_agent_attribution
      (id, principal_id, agent_subject, action, valid_until)
      VALUES (gen_random_uuid(), $1, $2, 'work.create', now() + interval '1 hour')`,
    [principalOne, extraAgents[missing]!]);
    expect((await discover(firstToken)).status).toBe(503);
  } finally {
    if (account) await account.stop();
    await accountPool.end();
    await accessPool.end();
    await databases.close();
  }
}, 120_000);
