import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { Pool } from 'pg';
import { AccountAssertionDenied, AccountAssertionVerifier }
  from '../../../services/main/src/modules/account/verify-assertion.ts';
import { cloneQaAccountAccessDatabases } from '../support/databases.ts';
import { type AccountOwner, countStatements, databaseName, decodePayload, mainWithAccount,
  qaEnvironment, representAgents, startAccount } from './account-boundary-fixture.ts';

const env = qaEnvironment();
let databases: Awaited<ReturnType<typeof cloneQaAccountAccessDatabases>>;
let accessPool: Pool;
let account: AccountOwner;
let verifierClient: { client_id: string; client_secret?: string };
let verifier: AccountAssertionVerifier;

beforeAll(async () => {
  databases = await cloneQaAccountAccessDatabases(env.runId);
  accessPool = new Pool({ connectionString: databases.urls.access, max: 4 });
  account = await startAccount({ pool: { connectionString: databases.urls.account, max: 8 },
    secret: env.secret, resource: env.resource });
  verifierClient = await account.workloadApp('Main verifier', ['work:create']);
  verifier = new AccountAssertionVerifier(account.verifierConfig(verifierClient));
});

afterAll(async () => {
  await account?.stop();
  await accessPool?.end();
  await databases?.close();
});

type View = { installationId: string; clientId: string; state: string; scopes: string[];
  revokedAt: string | null };

const change = async (body: object, cookie = account.operator.cookie) => {
  const response = await account.post('/api/account/installation-changes', body, cookie);
  return { status: response.status, body: await response.json() as View & { error?: string } };
};
const installation = async (clientId: string, cookie = account.operator.cookie) => {
  const response = await fetch(`${account.local}/api/account/installations/${encodeURIComponent(clientId)}`,
    { headers: { cookie } });
  return { status: response.status, body: await response.json() as View };
};
const refreshRows = async (clientId: string) => Number((await account.pool.query<{ count: string }>(
  'SELECT count(*) FROM "oauthRefreshToken" WHERE "clientId" = $1', [clientId])).rows[0]!.count);

test('IAM09: a revoked App installation cannot regain access by refresh, pending code, workload token or reinstallation, and an App update cannot widen its ceiling', async () => {
  const scope = 'openid work:create offline_access';
  const app = await account.nativeApp('Installed App', scope);
  const peer = await account.nativeApp('Independent App', scope, true);
  const job = await account.workloadApp('Installed job', ['work:create']);
  const member = await account.signUp('member');
  const { agents } = await representAgents(accessPool, account.issuer, member.id, 1);
  const { discover, check } = mainWithAccount(env, accessPool, verifier);
  const allowed = async (token: string) => {
    const found = await discover(token);
    if (found.status !== 200) return found.status;
    return (await check(token, agents[0]!, found.body.authorityEpoch)).status;
  };
  const workload = (token: string) => verifier.verify(new Request(`${env.resource}/v1/works`,
    { method: 'POST', headers: { authorization: `Bearer ${token}` } }), ['work:create']);

  const installed = await installation(app.client_id);
  expect(installed.status).toBe(200);
  expect(installed.body).toMatchObject({ clientId: app.client_id, state: 'active',
    scopes: ['offline_access', 'openid', 'work:create'], revokedAt: null });
  expect((await installation(app.client_id, member.cookie)).status).toBe(403);
  expect((await fetch(`${account.local}/api/account/installations/${app.client_id}`)).status).toBe(401);

  const original = await account.issue(app.client_id, member, scope);
  expect(decodePayload(original.access_token).rezics_installation_id).toBe(installed.body.installationId);
  expect(await allowed(original.access_token)).toBe(200);
  const peerTokens = await account.issue(peer.client_id, member, scope, false);
  expect(await allowed(peerTokens.access_token)).toBe(200);
  const jobIssued = await account.clientCredentials(job, 'work:create');
  expect(jobIssued.status).toBe(200);
  const jobToken = (await jobIssued.json() as { access_token: string }).access_token;
  expect((await workload(jobToken)).subject).toBe(job.client_id);

  // An App update widens its registration, not its installed ceiling.
  await account.auth.api.adminUpdateOAuthClient({ headers: account.adminHeaders,
    body: { client_id: app.client_id,
      update: { scope: 'openid work:create work:edit offline_access' } } });
  const consentBefore = await account.pool.query<{ scopes: string[]; generation: string }>(
    `SELECT scopes, "rezicsGeneration"::text AS generation FROM "oauthConsent"
     WHERE "userId" = $1 AND "clientId" = $2`, [member.id, app.client_id]);
  const widened = await account.authorize(app.client_id, member,
    'openid work:create work:edit offline_access');
  expect(widened).toBeInstanceOf(Response);
  expect((widened as Response).status).toBe(400);
  expect(await (widened as Response).json()).toEqual({ error: 'invalid_scope' });
  const consentAfter = await account.pool.query<{ scopes: string[]; generation: string }>(
    `SELECT scopes, "rezicsGeneration"::text AS generation FROM "oauthConsent"
     WHERE "userId" = $1 AND "clientId" = $2`, [member.id, app.client_id]);
  expect(consentAfter.rows).toEqual(consentBefore.rows);
  expect((await account.refresh(app.client_id, original.refresh_token!, 'work:create work:edit')).ok)
    .toBe(false);
  expect((await installation(app.client_id)).body.scopes).toEqual(installed.body.scopes);
  expect((await change({ change: 'install', clientId: app.client_id,
    scopes: ['openid', 'work:create', 'work:edit', 'offline_access'], changeKey: randomUUID() })).status)
    .toBe(409);

  const pendingCode = await account.authorize(app.client_id, member, scope);
  expect(pendingCode).not.toBeInstanceOf(Response);
  expect((await change({ change: 'revoke', installationId: installed.body.installationId },
    member.cookie)).status).toBe(403);
  const wrongOrigin = await fetch(`${account.local}/api/account/installation-changes`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: account.operator.cookie,
      origin: 'https://attacker.example' },
    body: JSON.stringify({ change: 'revoke', installationId: installed.body.installationId }) });
  expect(wrongOrigin.status).toBe(403);
  expect((await change({ change: 'revoke', installationId: randomUUID() })).status).toBe(404);
  const familyRows = await refreshRows(app.client_id);

  const revoked = await change({ change: 'revoke', installationId: installed.body.installationId });
  expect(revoked.status).toBe(200);
  expect(revoked.body).toMatchObject({ state: 'revoked', installationId: installed.body.installationId });
  expect(revoked.body.revokedAt).toBeTruthy();
  const replay = await change({ change: 'revoke', installationId: installed.body.installationId });
  expect(replay).toEqual(revoked);

  expect(await account.introspect(verifierClient, original.access_token)).toEqual({ active: false });
  expect(await allowed(original.access_token)).toBe(401);
  expect((await account.refresh(app.client_id, original.refresh_token!)).ok).toBe(false);
  expect(await refreshRows(app.client_id)).toBe(familyRows);
  const staleCode = await account.exchange(app.client_id,
    pendingCode as { code: string; verifier: string });
  expect(staleCode.status).toBe(400);
  expect(await staleCode.json()).toMatchObject({ error: 'invalid_grant' });
  const uninstalled = await account.authorize(app.client_id, member, scope);
  expect((uninstalled as Response).status).toBe(400);
  expect(await (uninstalled as Response).json()).toEqual({ error: 'unauthorized_client' });
  // The user's consent and the other App are separate bases.
  expect(consentAfter.rowCount).toBe(1);
  expect((await account.pool.query('SELECT 1 FROM "oauthConsent" WHERE "userId" = $1 AND "clientId" = $2',
    [member.id, app.client_id])).rowCount).toBe(1);
  expect(await allowed(peerTokens.access_token)).toBe(200);
  expect((await account.refresh(peer.client_id, peerTokens.refresh_token!)).status).toBe(200);
  expect((await workload(jobToken)).subject).toBe(job.client_id);

  // Reinstalling is a new identity with its own ceiling; old families stay dead.
  const changeKey = randomUUID();
  const reinstall = { change: 'install', clientId: app.client_id, scopes: ['openid', 'work:create', 'offline_access'], changeKey };
  const reinstalled = await change(reinstall);
  expect(reinstalled.status).toBe(200);
  expect(reinstalled.body.installationId).not.toBe(installed.body.installationId);
  expect(reinstalled.body.state).toBe('active');
  expect(await change(reinstall)).toEqual(reinstalled);
  expect((await change({ ...reinstall, scopes: ['openid', 'work:create'] })).status).toBe(409);
  expect((await change({ ...reinstall, changeKey: randomUUID() })).status).toBe(409);
  expect((await change({ ...reinstall, changeKey: randomUUID(), scopes: ['rating:read'] })).status).toBe(400);
  expect(await account.introspect(verifierClient, original.access_token)).toEqual({ active: false });
  expect((await account.refresh(app.client_id, original.refresh_token!)).ok).toBe(false);
  const renewed = await account.issue(app.client_id, member, scope);
  expect(decodePayload(renewed.access_token).rezics_installation_id).toBe(reinstalled.body.installationId);
  expect(await allowed(renewed.access_token)).toBe(200);

  // A refresh racing revocation either commits first and is fenced after, or fails.
  const [raceRevoked, racingRefresh] = await Promise.all([
    change({ change: 'revoke', installationId: reinstalled.body.installationId }),
    account.refresh(app.client_id, renewed.refresh_token!),
  ]);
  expect(raceRevoked.status).toBe(200);
  if (racingRefresh.ok) {
    const raced = await racingRefresh.json() as { access_token: string; refresh_token: string };
    expect(await account.introspect(verifierClient, raced.access_token)).toEqual({ active: false });
    expect((await account.refresh(app.client_id, raced.refresh_token)).ok).toBe(false);
  }
  expect(await allowed(renewed.access_token)).toBe(401);

  // Workload principals are scoped to their installation.
  const jobInstallation = await installation(job.client_id);
  expect(jobInstallation.body.scopes).toEqual(['work:create']);
  expect((await change({ change: 'revoke', installationId: jobInstallation.body.installationId })).status)
    .toBe(200);
  await expect(workload(jobToken)).rejects.toBeInstanceOf(AccountAssertionDenied);
  const refused = await account.clientCredentials(job, 'work:create');
  expect(refused.status).toBe(400);
  expect(await refused.json()).toMatchObject({ error: 'unauthorized_client' });
}, 60_000);

test('IAM09: installation checks stay constant-cost as revoked installation history grows', async () => {
  const scope = 'openid work:create offline_access';
  const member = await account.signUp('history-member');
  const fresh = await account.nativeApp('Fresh App', scope, true);
  const churned = await account.nativeApp('Churned App', scope, true);
  const measure = async (token: string) => {
    const counter = countStatements(databaseName(databases.urls.account));
    try {
      expect(await account.introspect(verifierClient, token)).toMatchObject({ active: true });
      return counter.counts.calls;
    } finally { counter.restore(); }
  };
  const freshToken = (await account.issue(fresh.client_id, member, scope, false)).access_token;
  // The provider caches its JWKS read; measure both tokens with a warm cache.
  expect(await account.introspect(verifierClient, freshToken)).toMatchObject({ active: true });
  const baseline = await measure(freshToken);
  const cycleCosts: number[] = [];
  for (let cycle = 0; cycle < 16; cycle++) {
    const current = (await installation(churned.client_id)).body.installationId;
    const counter = countStatements(databaseName(databases.urls.account));
    try {
      expect((await change({ change: 'revoke', installationId: current })).status).toBe(200);
      expect((await change({ change: 'install', clientId: churned.client_id,
        scopes: ['offline_access', 'openid', 'work:create'], changeKey: randomUUID() })).status).toBe(200);
      cycleCosts.push(counter.counts.calls);
    } finally { counter.restore(); }
  }
  // The operator session read plus O(1) indexed statements, at any history length.
  expect(new Set(cycleCosts).size).toBe(1);
  expect(cycleCosts[0]).toBeLessThanOrEqual(16);
  expect((await account.pool.query('SELECT 1 FROM rezics_oauth_installation WHERE client_id = $1',
    [churned.client_id])).rowCount).toBe(17);
  const afterHistory = await measure((await account.issue(churned.client_id, member, scope, false)).access_token);
  expect(afterHistory).toBe(baseline);
  const client = await account.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL enable_seqscan = off');
    const plan = await client.query(`EXPLAIN (FORMAT JSON) SELECT 1 FROM rezics_oauth_installation
      WHERE id = $1 AND client_id = $2 AND state = 'active'`, [randomUUID(), churned.client_id]);
    // Either unique index bounds this read to one row; never a table scan.
    expect(JSON.stringify(plan.rows)).toMatch(/rezics_oauth_installation_pkey|rezics_installation_active_client/);
    expect(JSON.stringify(plan.rows)).not.toContain('Seq Scan');
    const active = await client.query(`EXPLAIN (FORMAT JSON) SELECT id FROM rezics_oauth_installation
      WHERE client_id = $1 AND state = 'active'`, [churned.client_id]);
    expect(JSON.stringify(active.rows)).toContain('rezics_installation_active_client');
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}, 60_000);

test('IAM09: a refreshed token re-evaluates the selected acting-Agent context and cannot widen its consent ceiling at Main', async () => {
  const app = await account.nativeApp('Consenting App', 'openid work:create work:edit offline_access');
  const member = await account.signUp('selector');
  const { agents: [agentA, agentB], representations: [representationA] } =
    await representAgents(accessPool, account.issuer, member.id, 2);
  const { discover, check } = mainWithAccount(env, accessPool, verifier);
  const select = async (token: string, agent: string) => {
    const found = await discover(token);
    if (found.status !== 200) return found.status;
    return (await check(token, agent, found.body.authorityEpoch)).status;
  };

  const first = await account.issue(app.client_id, member, 'openid work:create offline_access');
  // The token names the subject, client, consent and installation, never an Agent.
  const claims = decodePayload(first.access_token);
  expect(Object.keys(claims).filter(key => /act|agent/i.test(key))).toEqual([]);
  expect(JSON.stringify(claims)).not.toContain(agentA!);
  expect(await select(first.access_token, agentA!)).toBe(200);
  expect(await select(first.access_token, agentB!)).toBe(200);

  // Access withdraws the selected context A between issuance and refresh.
  await accessPool.query(`UPDATE access.representation SET active = false, generation = generation + 1
    WHERE id = $1`, [representationA]);
  const refreshed = await account.refresh(app.client_id, first.refresh_token!);
  expect(refreshed.status).toBe(200);
  const second = await refreshed.json() as { access_token: string; refresh_token: string };
  expect(await select(second.access_token, agentA!)).toBe(403);
  expect(await select(first.access_token, agentA!)).toBe(403);
  expect(await select(second.access_token, agentB!)).toBe(200);
  expect((await discover(second.access_token)).body.contexts).toEqual([{ actingSubject: agentB }]);

  // Refresh keeps the consented ceiling; an unconsented registered scope stays out.
  const wider = await account.refresh(app.client_id, second.refresh_token, 'work:create work:edit');
  expect(wider.ok).toBe(false);
  expect(decodePayload(second.access_token).scope).toBe('openid work:create offline_access');

  // Narrowing re-consent ends the wider family; the narrowed token acts for no Agent.
  const narrowed = await account.issue(app.client_id, member, 'openid offline_access');
  expect((await account.refresh(app.client_id, second.refresh_token)).ok).toBe(false);
  expect(await select(second.access_token, agentB!)).toBe(401);
  expect((await check(narrowed.access_token, agentB!, '0')).status).toBe(401);
  const narrowedRefresh = await account.refresh(app.client_id, narrowed.refresh_token!, 'openid work:create offline_access');
  expect(narrowedRefresh.ok).toBe(false);

  // Renewed explicit consent is a new basis, still bound to current Access.
  const renewed = await account.issue(app.client_id, member, 'openid work:create offline_access');
  expect(await select(renewed.access_token, agentA!)).toBe(403);
  expect(await select(renewed.access_token, agentB!)).toBe(200);
}, 60_000);
