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
import { AccessAdmissionRegistry, AdmissionDenied, AdmissionUnavailable,
  type AdmissionRequest } from '../../../services/main/src/modules/access/admission.ts';
import { AccessActingContexts } from '../../../services/main/src/modules/access/contexts.ts';
import { AccessGroups } from '../../../services/main/src/modules/access/groups.ts';
import { AccountAssertionVerifier } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { cloneQaAccountAccessDatabases } from '../support/databases.ts';

const root = resolve(import.meta.dir, '../../..');
const scope = 'openid work:create access:manage';

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

const agent = () => `https://rezics.com/id/${randomUUID()}`;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

interface Owners {
  accessPool: Pool;
  access: AccessAdmissionRegistry;
  groups: AccessGroups;
  main: ReturnType<typeof createMainApp>;
  token: string;
  principal: { issuer: string; subject: string };
  principalId: string;
  addAgents: (...subjects: string[]) => Promise<void>;
  represent: (subject: string, action?: string) => Promise<string>;
  authorityEpoch: () => Promise<string>;
  check: (actingSubject: string,
    authorityPath?: 'represented-agent' | 'direct-principal') => Promise<Response>;
  discover: () => Promise<Response>;
  savedProof: (admissionId: string) => Promise<Record<string, string | null>>;
}

/** Real Account OAuth, Main routes and an isolated Access clone per case. */
async function withOwners(label: string, work: (owners: Owners) => Promise<void>): Promise<void> {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.FUSEKI_URL || !Bun.env.MAIN_DATA_EPOCH
    || !Bun.env.MAIN_ROUTING_EPOCH || !Bun.env.ACCESS_DATABASE_URL
    || !Bun.env.ACCOUNT_DATABASE_URL || !Bun.env.ACCOUNT_MAIN_RESOURCE) {
    throw new Error('Run through the isolated QA integration tier');
  }
  const state = join(root, '.temp', `${label}-${randomUUID()}`);
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const databases = await cloneQaAccountAccessDatabases(Bun.env.REZICS_QA_RUN_ID);
  const accountPool = new Pool({ connectionString: databases.urls.account });
  const accessPool = new Pool({ connectionString: databases.urls.access, max: 12 });
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const resource = Bun.env.ACCOUNT_MAIN_RESOURCE;
  const operators = new Set<string>();
  const auth = createAccountAuth({ baseURL: base, secret: Bun.env.ACCOUNT_SECRET!,
    resource, pool: accountPool, operatorUserIds: operators });
  const account = createAccountApp(auth, accountPool).listen({ hostname: '127.0.0.1', port });
  try {
    const signUp = async (name: string) => {
      const email = `${label}-${name}-${randomUUID()}@example.test`;
      const password = randomBytes(24).toString('base64url');
      const response = await account.handle(new Request(`${base}/api/auth/sign-up/email`, {
        method: 'POST', headers: { 'content-type': 'application/json', origin: base },
        body: JSON.stringify({ name, email, password }),
      }));
      expect(response.status).toBe(200);
      const body = await response.json() as { user: { id: string } };
      return { id: body.user.id, email, password, cookie: response.headers.get('set-cookie')! };
    };
    const operator = await signUp('operator');
    operators.add(operator.id);
    const headers = new Headers({ cookie: operator.cookie, origin: base });
    const mainClient = await auth.api.adminCreateOAuthClient({ headers, body: {
      client_name: `${label} verifier`, scope: 'work:create access:manage',
      token_endpoint_auth_method: 'client_secret_post', grant_types: ['client_credentials'],
      client_credentials_scopes: ['work:create', 'access:manage'] } });
    const redirectUri = 'http://localhost:3000/auth/callback';
    const client = await auth.api.adminCreateOAuthClient({ headers, body: {
      client_name: `${label} product`, application_type: 'native',
      redirect_uris: [redirectUri], token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'], scope, skip_consent: true, require_pkce: true } });
    const member = await signUp('member');
    const signIn = await fetch(`${base}/api/auth/sign-in/email`, { method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ email: member.email, password: member.password }) });
    expect(signIn.status).toBe(200);
    const verifier = randomBytes(32).toString('base64url');
    const authorize = new URL(`${base}/api/auth/oauth2/authorize`);
    for (const [key, value] of Object.entries({ response_type: 'code',
      client_id: client.client_id, redirect_uri: redirectUri, scope, state: randomUUID(),
      resource, code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
    })) authorize.searchParams.set(key, value);
    const authorized = await fetch(authorize, {
      headers: { cookie: signIn.headers.get('set-cookie')! }, redirect: 'manual' });
    expect(authorized.status).toBe(302);
    const code = new URL(authorized.headers.get('location')!).searchParams.get('code')!;
    const exchange = await fetch(`${base}/api/auth/oauth2/token`, { method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', client_id: client.client_id,
        code, redirect_uri: redirectUri, code_verifier: verifier, resource }) });
    expect(exchange.status).toBe(200);
    const token = (await exchange.json() as { access_token: string }).access_token;
    const principal = { issuer: `${base}/api/auth`, subject: member.id };
    const principalId = randomUUID();
    await accessPool.query('INSERT INTO access.principal (id, account_issuer, account_subject) VALUES ($1,$2,$3)',
      [principalId, principal.issuer, principal.subject]);
    await accessPool.query("INSERT INTO access.scope_gate (id) VALUES ('work:create:root') ON CONFLICT DO NOTHING");
    const fuseki = new FusekiClient(Bun.env.FUSEKI_URL);
    const access = new AccessAdmissionRegistry(accessPool);
    const groups = new AccessGroups(accessPool);
    const main = createMainApp(fuseki, { environment: { fuseki,
      lineage: { dataEpoch: Bun.env.MAIN_DATA_EPOCH, routingEpoch: Bun.env.MAIN_ROUTING_EPOCH },
      objectDirectory: join(state, 'objects') },
    account: new AccountAssertionVerifier({ issuer: principal.issuer, audience: resource,
      jwksUrl: `${base}/api/auth/jwks`, introspectUrl: `${base}/api/auth/oauth2/introspect`,
      clientId: mainClient.client_id, clientSecret: mainClient.client_secret! }),
    access, actingContexts: new AccessActingContexts(accessPool), groups });
    const authorityEpoch = async () => (await accessPool.query<{ authority_epoch: string }>(
      "SELECT authority_epoch FROM access.scope_gate WHERE id = 'work:create:root'")).rows[0]!.authority_epoch;
    await work({
      accessPool, access, groups, main, token, principal, principalId,
      addAgents: async (...subjects) => {
        await accessPool.query(`INSERT INTO access.authority_subject (id, kind)
          SELECT id, 'agent' FROM unnest($1::text[]) AS id`, [subjects]);
      },
      represent: async (subject, action = 'work.create') => {
        const id = randomUUID();
        await accessPool.query(`INSERT INTO access.representation
          (id, principal_id, subject_id, action, valid_until)
          VALUES ($1,$2,$3,$4,now() + interval '2 hours')`, [id, principalId, subject, action]);
        return id;
      },
      authorityEpoch,
      check: async (actingSubject, authorityPath = 'represented-agent') => main.handle(new Request(
        'http://main.local/v1/me/acting-context-checks', { method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify({ profile: 'work-create-acting-context-check-v1',
            task: 'work.create', actingSubject, authorityPath,
            expectedAuthorityEpoch: await authorityEpoch() }) })),
      discover: () => main.handle(new Request('http://main.local/v1/me/acting-contexts?task=work.create',
        { headers: { authorization: `Bearer ${token}` } })),
      savedProof: async admissionId => (await accessPool.query<Record<string, string | null>>(`
        SELECT authority_path, direct_grant_id, attribution_id, represented_representation_id,
          represented_grant_id, group_member_id, group_grant_id
        FROM access.admission WHERE id = $1`, [admissionId])).rows[0]!,
    });
  } finally {
    await account.stop();
    await Promise.all([accountPool.end(), accessPool.end()]);
    await databases.close();
    rmSync(state, { recursive: true, force: true });
  }
}

/** Wait until the given number of Access sessions are blocked on row locks. */
async function lockWaiters(pool: Pool, minimum: number): Promise<number> {
  let waiting = 0;
  for (let attempt = 0; attempt < 60; attempt++) {
    waiting = Number((await pool.query<{ count: string }>(`SELECT count(*) AS count
      FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`))
      .rows[0]!.count);
    if (waiting >= minimum) break;
    await Bun.sleep(20);
  }
  return waiting;
}

const deniedOrUnavailable = (result: PromiseSettledResult<unknown>) =>
  result.status === 'rejected'
  && (result.reason instanceof AdmissionDenied || result.reason instanceof AdmissionUnavailable);

test('IAM04: authority moved mid-selection cannot pool direct principal and represented Agent rights', async () => {
  await withOwners('iam04', async owners => {
    const { accessPool, access, principal, principalId, check } = owners;
    const subject = agent();
    await owners.addAgents(subject);
    const representation = await owners.represent(subject);
    const attribution = randomUUID();
    const directGrant = randomUUID();
    await accessPool.query(`INSERT INTO access.principal_agent_attribution
      (id, principal_id, agent_subject, action, valid_until)
      VALUES ($1,$2,$3,'work.create',now() + interval '2 hours')`, [attribution, principalId, subject]);
    await accessPool.query(`INSERT INTO access.principal_permission_grant
      (id, issuer_subject, principal_id, scope_id, action, valid_until)
      VALUES ($1,$2,$3,'work:create:root','work.create',now() + interval '2 hours')`,
    [directGrant, subject, principalId]);
    // S0: the principal's own grant plus a representation of an ungranted Agent.
    // Each mode needs its own complete path; the direct grant never completes the Agent path.
    expect((await check(subject, 'direct-principal')).status).toBe(200);
    expect((await check(subject)).status).toBe(403);
    const before = await (await owners.discover()).json() as {
      contexts: Array<{ actingSubject: string }>; directContexts: Array<{ actingSubject: string }> };
    expect(before.contexts).toEqual([]);
    expect(before.directContexts).toEqual([{ actingSubject: subject, displayName: null, handle: null, kind: null }]);
    const request = (authorityPath: 'represented-agent' | 'direct-principal'): AdmissionRequest => ({
      principal, actingSubject: subject, scope: 'work:create:root', action: 'work.create',
      authorityPath, idempotencyKey: randomUUID(), requestDigest: digest('IAM04') });
    const directAdmission = await access.register(request('direct-principal'));
    expect(await owners.savedProof(directAdmission.id)).toMatchObject({
      authority_path: 'direct-principal', direct_grant_id: directGrant, attribution_id: attribution,
      represented_grant_id: null, group_grant_id: null });
    await expect(access.register(request('represented-agent'))).rejects.toBeInstanceOf(AdmissionDenied);

    // One owner transaction removes the representation and the principal grant and
    // grants the Agent. Neither state has a complete represented path, and the new
    // Agent grant never completes the direct path, so selection must not combine them.
    const agentGrant = randomUUID();
    const writer = await accessPool.connect();
    let committed = false;
    try {
      await writer.query('BEGIN');
      await writer.query(`UPDATE access.representation SET active = false,
        generation = generation + 1 WHERE id = $1`, [representation]);
      await writer.query(`UPDATE access.principal_permission_grant SET active = false,
        generation = generation + 1 WHERE id = $1`, [directGrant]);
      await writer.query(`INSERT INTO access.permission_grant
        (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
        VALUES ($1,$2,$2,'work:create:root','work.create',now() + interval '2 hours')`,
      [agentGrant, subject]);
      const inFlight = Promise.all([check(subject, 'direct-principal'), check(subject),
        owners.discover(), Promise.allSettled([access.register(request('direct-principal')),
          access.register(request('represented-agent'))])]);
      // Selections are genuinely in flight: they wait on the moved authority rows.
      expect(await lockWaiters(accessPool, 3)).toBeGreaterThanOrEqual(2);
      await writer.query('COMMIT');
      committed = true;
      const [directCheck, representedCheck, discovery, registrations] = await inFlight;
      expect([403, 503]).toContain(directCheck.status);
      expect([403, 503]).toContain(representedCheck.status);
      expect([200, 503]).toContain(discovery.status);
      if (discovery.status === 200) {
        const listed = await discovery.json() as {
          contexts: Array<{ actingSubject: string }>; directContexts: Array<{ actingSubject: string }> };
        expect(listed.contexts).toEqual([]);
        expect(listed.directContexts).toEqual([]);
      }
      expect(registrations.every(deniedOrUnavailable)).toBe(true);
    } finally {
      if (!committed) await writer.query('ROLLBACK').catch(() => undefined);
      writer.release();
    }
    // S1: an Agent grant with no representation, an attribution with no principal grant.
    expect((await check(subject, 'direct-principal')).status).toBe(403);
    expect((await check(subject)).status).toBe(403);
    await expect(access.claim(directAdmission.id, directAdmission.requestDigest))
      .rejects.toBeInstanceOf(AdmissionDenied);
    expect((await accessPool.query<{ count: string }>(
      'SELECT count(*) AS count FROM access.admission WHERE acting_subject = $1', [subject]))
      .rows[0]!.count).toBe('1');

    // S2: a new representation completes only the Agent path.
    const renewed = await owners.represent(subject);
    expect((await check(subject)).status).toBe(200);
    expect((await check(subject, 'direct-principal')).status).toBe(403);
    await expect(access.register(request('direct-principal'))).rejects.toBeInstanceOf(AdmissionDenied);
    const representedAdmission = await access.register(request('represented-agent'));
    expect(await owners.savedProof(representedAdmission.id)).toMatchObject({
      authority_path: 'represented-agent', represented_representation_id: renewed,
      represented_grant_id: agentGrant, direct_grant_id: null, attribution_id: null });

    // Reverse move while the represented selection is in flight.
    const newDirectGrant = randomUUID();
    const reverse = await accessPool.connect();
    committed = false;
    try {
      await reverse.query('BEGIN');
      await reverse.query(`UPDATE access.permission_grant SET active = false,
        generation = generation + 1 WHERE id = $1`, [agentGrant]);
      await reverse.query(`INSERT INTO access.principal_permission_grant
        (id, issuer_subject, principal_id, scope_id, action, valid_until)
        VALUES ($1,$2,$3,'work:create:root','work.create',now() + interval '2 hours')`,
      [newDirectGrant, subject, principalId]);
      const inFlight = Promise.all([check(subject), check(subject, 'direct-principal'),
        Promise.allSettled([access.register(request('represented-agent'))]),
        Promise.allSettled([access.register(request('direct-principal'))])]);
      expect(await lockWaiters(accessPool, 2)).toBeGreaterThanOrEqual(1);
      await reverse.query('COMMIT');
      committed = true;
      const [representedCheck, directCheck, [represented], [direct]] = await inFlight;
      expect([403, 503]).toContain(representedCheck.status);
      // The direct result is either the whole old state or the whole new state.
      expect([200, 403, 503]).toContain(directCheck.status);
      expect(deniedOrUnavailable(represented!)).toBe(true);
      if (direct!.status === 'fulfilled') {
        expect(await owners.savedProof(direct!.value.id)).toMatchObject({
          direct_grant_id: newDirectGrant, represented_grant_id: null, group_grant_id: null });
      } else expect(deniedOrUnavailable(direct!)).toBe(true);
    } finally {
      if (!committed) await reverse.query('ROLLBACK').catch(() => undefined);
      reverse.release();
    }
    expect((await check(subject)).status).toBe(403);
    expect((await check(subject, 'direct-principal')).status).toBe(200);
    await expect(access.claim(representedAdmission.id, representedAdmission.requestDigest))
      .rejects.toBeInstanceOf(AdmissionDenied);
    const fresh = await access.register(request('direct-principal'));
    expect(await owners.savedProof(fresh.id)).toMatchObject({
      direct_grant_id: newDirectGrant, represented_grant_id: null });
    expect((await access.claim(fresh.id, fresh.requestDigest)).authorityPath).toBe('direct-principal');
  });
}, 120_000);

test('IAM36: child membership inherits the parent grant; parent membership never inherits the child grant', async () => {
  await withOwners('iam36', async owners => {
    const { accessPool, access, principal, main, token, check } = owners;
    const manager = agent(), parentMember = agent(), childMember = agent();
    await owners.addAgents(manager, parentMember, childMember);
    await owners.represent(manager, 'access.group.manage');
    await owners.represent(parentMember);
    await owners.represent(childMember);
    for (const action of ['access.group.manage', 'access.group.assign.work.create']) {
      await accessPool.query(`INSERT INTO access.permission_grant
        (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
        VALUES ($1,$2,$2,'work:create:root',$3,now() + interval '2 hours')`,
      [randomUUID(), manager, action]);
    }
    let generation = '0';
    const change = async (action: string, fields: Record<string, unknown>,
      expectedGroupGeneration = generation) => {
      const response = await main.handle(new Request('http://main.local/v1/access/group-changes', {
        method: 'POST', headers: { authorization: `Bearer ${token}`,
          'content-type': 'application/json', 'idempotency-key': `iam36-${randomUUID()}` },
        body: JSON.stringify({ profile: 'work-create-group-change-v1', issuerSubject: manager,
          expectedGroupGeneration, action, ...fields }) }));
      if (response.status === 200) {
        generation = (await response.json() as { groupGeneration: string }).groupGeneration;
      }
      return response.status;
    };
    const validUntil = () => new Date(Date.now() + 60 * 60_000).toISOString();
    generation = (await accessPool.query<{ group_generation: string }>(
      "SELECT group_generation FROM access.scope_gate WHERE id = 'work:create:root'")).rows[0]!.group_generation;
    const parent = randomUUID(), child = randomUUID();
    const parentGrant = randomUUID(), childGrant = randomUUID();
    expect(await change('create', { groupId: parent, parentId: null })).toBe(200);
    expect(await change('create', { groupId: child, parentId: parent })).toBe(200);
    expect(await change('add-member', { memberId: randomUUID(), groupId: parent,
      agentSubject: parentMember })).toBe(200);
    expect(await change('add-member', { memberId: randomUUID(), groupId: child,
      agentSubject: childMember })).toBe(200);
    expect(await change('grant', { grantId: childGrant, groupId: child, validUntil: validUntil() })).toBe(200);
    // Only the child has a grant: its member is eligible, the parent member is not.
    expect((await check(childMember)).status).toBe(200);
    expect((await check(parentMember)).status).toBe(403);
    expect(await change('grant', { grantId: parentGrant, groupId: parent, validUntil: validUntil() })).toBe(200);
    expect((await check(parentMember)).status).toBe(200);
    const listed = async () => ((await (await owners.discover()).json()) as {
      contexts: Array<{ actingSubject: string }> }).contexts.map(item => item.actingSubject);
    expect((await listed()).sort()).toEqual([childMember, parentMember].sort());
    const request = (actingSubject: string): AdmissionRequest => ({ principal, actingSubject,
      scope: 'work:create:root', action: 'work.create', idempotencyKey: randomUUID(),
      requestDigest: digest('IAM36') });
    const parentAdmission = await access.register(request(parentMember));
    expect(await owners.savedProof(parentAdmission.id)).toMatchObject({ group_grant_id: parentGrant });
    const childAdmission = await access.register(request(childMember));
    expect<(string | null)[]>([parentGrant, childGrant]).toContain((await owners.savedProof(childAdmission.id)).group_grant_id);

    // Different grants: removing the parent grant leaves the child's extra grant,
    // which never reaches the parent member.
    expect(await change('revoke-grant', { grantId: parentGrant, expectedObjectGeneration: '0' }, '0'))
      .toBe(409);
    expect(await change('revoke-grant', { grantId: parentGrant, expectedObjectGeneration: '0' })).toBe(200);
    expect((await check(parentMember)).status).toBe(403);
    expect((await check(childMember)).status).toBe(200);
    expect(await listed()).toEqual([childMember]);
    await expect(access.register(request(parentMember))).rejects.toBeInstanceOf(AdmissionDenied);
    await expect(access.claim(parentAdmission.id, parentAdmission.requestDigest))
      .rejects.toBeInstanceOf(AdmissionDenied);
    const childOnly = await access.register(request(childMember));
    expect(await owners.savedProof(childOnly.id)).toMatchObject({ group_grant_id: childGrant });
    expect((await access.claim(childOnly.id, childOnly.requestDigest)).state).toBe('claimed');

    // The child member receives a newly admitted parent grant after its own ends.
    const renewedParentGrant = randomUUID();
    expect(await change('grant', { grantId: renewedParentGrant, groupId: parent,
      validUntil: validUntil() })).toBe(200);
    expect(await change('revoke-grant', { grantId: childGrant, expectedObjectGeneration: '0' })).toBe(200);
    expect((await check(childMember)).status).toBe(200);
    expect((await check(parentMember)).status).toBe(200);
    const inherited = await access.register(request(childMember));
    expect(await owners.savedProof(inherited.id)).toMatchObject({ group_grant_id: renewedParentGrant });
    expect((await access.claim(inherited.id, inherited.requestDigest)).state).toBe('claimed');
    const parentAgain = await access.register(request(parentMember));
    expect(await owners.savedProof(parentAgain.id)).toMatchObject({ group_grant_id: renewedParentGrant });
    expect((await listed()).sort()).toEqual([childMember, parentMember].sort());
  });
}, 120_000);

test('IAM34: diamond group paths keep distinct bounded support when one edge is removed', async () => {
  await withOwners('iam34', async owners => {
    const { accessPool, access, groups, principal, check } = owners;
    const manager = agent(), subject = agent();
    await owners.addAgents(manager, subject);
    await owners.represent(manager, 'access.group.manage');
    await owners.represent(subject);
    for (const action of ['access.group.manage', 'access.group.assign.work.create']) {
      await accessPool.query(`INSERT INTO access.permission_grant
        (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
        VALUES ($1,$2,$2,'work:create:root',$3,now() + interval '2 hours')`,
      [randomUUID(), manager, action]);
    }
    let groupGeneration = (await accessPool.query<{ group_generation: string }>(
      "SELECT group_generation FROM access.scope_gate WHERE id = 'work:create:root'")).rows[0]!.group_generation;
    const mutation = () => ({ principal, issuerSubject: manager, expectedGroupGeneration: groupGeneration });
    const until = (ms: number) => new Date(Date.now() + ms);
    // A diamond: the Agent reaches root through a one-edge branch and through a
    // 32-edge branch at exactly the supported depth limit.
    const rootGroup = randomUUID(), shallow = randomUUID();
    groupGeneration = await groups.create(mutation(), rootGroup, null);
    groupGeneration = await groups.create(mutation(), shallow, rootGroup);
    let deep = rootGroup;
    for (let depth = 1; depth <= 32; depth++) {
      const next = randomUUID();
      groupGeneration = await groups.create(mutation(), next, deep);
      deep = next;
    }
    const [shallowMember, deepMember] = [randomUUID(), randomUUID()].sort() as [string, string];
    const rootGrant = randomUUID();
    groupGeneration = await groups.grant(mutation(), rootGrant, rootGroup, until(60 * 60_000));
    groupGeneration = await groups.addMember(mutation(), shallowMember, shallow, subject);

    // Complexity: a count-observing pool proves the selected check keeps a fixed
    // SQL call count when the second branch is added (work is 16 x 33 bounded rows).
    let calls = 0;
    const counted = { connect: async () => {
      const client = await accessPool.connect();
      return new Proxy(client, { get(target, property) {
        if (property === 'query') return (...args: unknown[]) => {
          calls += 1;
          return (target.query as (...values: unknown[]) => unknown).apply(target, args);
        };
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
    } } as unknown as Pool;
    const countedCheck = async () => {
      calls = 0;
      const result = await new AccessActingContexts(counted).check(principal, subject,
        await owners.authorityEpoch());
      expect(result.decision).toBe('eligible-now');
      return calls;
    };
    const singleBranchCalls = await countedCheck();
    expect(singleBranchCalls).toBeGreaterThan(0);
    groupGeneration = await groups.addMember(mutation(), deepMember, deep, subject);
    expect(await countedCheck()).toBe(singleBranchCalls);

    // Two paths to one grant are one authority: discovery lists the Agent once.
    expect((await check(subject)).status).toBe(200);
    const listed = async () => ((await (await owners.discover()).json()) as {
      contexts: Array<{ actingSubject: string }> }).contexts.filter(item => item.actingSubject === subject);
    expect(await listed()).toEqual([{ actingSubject: subject, displayName: null, handle: null, kind: null }]);
    const request = (): AdmissionRequest => ({ principal, actingSubject: subject,
      scope: 'work:create:root', action: 'work.create', idempotencyKey: randomUUID(),
      requestDigest: digest('IAM34') });
    const viaShallow = await access.register(request());
    expect(await owners.savedProof(viaShallow.id)).toMatchObject({
      group_member_id: shallowMember, group_grant_id: rootGrant });

    // Removing one supporting edge leaves the independent 32-edge support.
    groupGeneration = await groups.revokeMember(mutation(), shallowMember, '0');
    expect((await check(subject)).status).toBe(200);
    expect(await listed()).toEqual([{ actingSubject: subject, displayName: null, handle: null, kind: null }]);
    // The saved proof over the removed edge is not rescued by the other path.
    await expect(access.claim(viaShallow.id, viaShallow.requestDigest)).rejects.toBeInstanceOf(AdmissionDenied);
    const viaDeep = await access.register(request());
    expect(await owners.savedProof(viaDeep.id)).toMatchObject({
      group_member_id: deepMember, group_grant_id: rootGrant });
    expect((await access.claim(viaDeep.id, viaDeep.requestDigest)).state).toBe('claimed');

    // Different limits on the same surviving branch: a short-lived grant on the
    // deep group and the long-lived root grant are independent supports.
    const shortGrant = randomUUID();
    groupGeneration = await groups.grant(mutation(), shortGrant, deep, until(2_500));
    const viaShort = await access.register(request());
    expect(await owners.savedProof(viaShort.id)).toMatchObject({
      group_member_id: deepMember, group_grant_id: shortGrant });
    await Bun.sleep(2_600);
    expect((await check(subject)).status).toBe(200);
    await expect(access.claim(viaShort.id, viaShort.requestDigest)).rejects.toBeInstanceOf(AdmissionDenied);
    const afterExpiry = await access.register(request());
    expect(await owners.savedProof(afterExpiry.id)).toMatchObject({
      group_member_id: deepMember, group_grant_id: rootGrant });
    expect((await access.claim(afterExpiry.id, afterExpiry.requestDigest)).state).toBe('claimed');

    // Removing the last support removes the authority; nothing else retained it.
    groupGeneration = await groups.revokeGrant(mutation(), rootGrant, '0');
    expect((await check(subject)).status).toBe(403);
    expect(await listed()).toEqual([]);
    await expect(access.register(request())).rejects.toBeInstanceOf(AdmissionDenied);
  });
}, 120_000);
