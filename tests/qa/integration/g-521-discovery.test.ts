import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { createMainApp } from '../../../services/main/src/app.ts';
import { AccessAdmissionRegistry, AdmissionDenied } from '../../../services/main/src/modules/access/admission.ts';
import { AccessActingContexts, type AgentDiscovery } from '../../../services/main/src/modules/access/contexts.ts';
import { AccessSessionAgents } from '../../../services/main/src/modules/access/session-agent.ts';
import { AccessTopology } from '../../../services/main/src/modules/access/topology.ts';
import { AgentProvisioning } from '../../../services/main/src/modules/agent/provision.ts';
import { AgentPublicProfiles } from '../../../services/main/src/modules/agent/profile.ts';
import { agentProvisionHarness } from './agent-provision-support.ts';

async function json<T>(response: Response, status = 200): Promise<T> {
  const body = await response.text();
  expect(response.status, body).toBe(status);
  return JSON.parse(body) as T;
}

test('G-521/IAM01: identity discovery and session/main choices are independent of every task gate and grant', async () => {
  const h = await agentProvisionHarness();
  try {
    const contexts = new AccessActingContexts(h.accessPool, h.env);
    const access = new AccessAdmissionRegistry(h.accessPool);
    const app = createMainApp(h.fuseki, { environment: h.env, account: h.verifier, access,
      actingContexts: contexts, sessionAgents: new AccessSessionAgents(h.accessPool, contexts),
      agentProvisioning: new AgentProvisioning(h.accessPool, h.env),
      agentProfiles: new AgentPublicProfiles(h.accessPool, h.env,
        { avatarDelivery: async () => { throw new Error('No avatar in this fixture'); } }) });
    // A third-party identity token alone must not enumerate or choose Agents.
    // The acting-identity token has agent:create but no publishing scope.
    const verifier = randomBytes(32).toString('base64url');
    const authorize = new URL(`${h.base}/api/auth/oauth2/authorize`);
    for (const [key, value] of Object.entries({ response_type: 'code', client_id: h.client.client_id,
      redirect_uri: h.redirectUri, scope: 'openid', state: randomUUID(),
      resource: Bun.env.ACCOUNT_MAIN_RESOURCE!,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' })) {
      authorize.searchParams.set(key, value);
    }
    const authorized = await fetch(authorize, { headers: { cookie: h.user.cookie }, redirect: 'manual' });
    expect(authorized.status).toBe(302);
    const code = new URL(authorized.headers.get('location')!).searchParams.get('code')!;
    const exchange = await fetch(`${h.base}/api/auth/oauth2/token`, { method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', client_id: h.client.client_id,
        code, redirect_uri: h.redirectUri, code_verifier: verifier, resource: Bun.env.ACCOUNT_MAIN_RESOURCE! }) });
    const openidOnlyToken = (await json<{ access_token: string }>(exchange)).access_token;
    const identityToken = h.token;
    const sessionKey = randomUUID();
    const call = (method: string, path: string, body?: object, token = identityToken,
      key = randomUUID(), language?: string) => app.handle(new Request(`http://main.local${path}`, {
      method, headers: { authorization: `Bearer ${token}`, 'x-session-key': sessionKey,
        ...(language ? { 'accept-language': language } : {}),
        ...(body ? { 'content-type': 'application/json', 'idempotency-key': key } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) }));
    for (const [method, path] of [
      ['GET', '/v1/me/agents'], ['GET', '/v1/me/session-agent'], ['PUT', '/v1/me/session-agent'],
      ['GET', '/v1/me/main-agent-preference'], ['PUT', '/v1/me/main-agent-preference'],
    ]) {
      const denied = await call(method!, path!, method === 'PUT'
        ? { actingSubject: null, expectedRevision: null } : undefined, openidOnlyToken);
      expect(await json(denied, 403)).toMatchObject({ code: 'insufficient_scope' });
    }
    expect(await json(await call('GET', '/v1/me/agents'))).toMatchObject({ items: [], complete: true });
    const org = await json<{ agent: string }>(await call('POST', '/v1/agents', {
      profile: 'agent-provision-v1', kind: 'organization', displayName: 'North Star' }, h.token), 201);
    expect(await json(await call('GET', '/v1/me/session-agent'))).toMatchObject({ initialActingSubject: org.agent });
    const principalId = (await h.accessPool.query<{ id: string }>(`SELECT id FROM access.principal
      WHERE account_issuer = $1 AND account_subject = $2`, [`${h.base}/api/auth`, h.user.id])).rows[0]!.id;
    const principal = { issuer: `${h.base}/api/auth`, subject: h.user.id };
    const head = (await h.fuseki.query(`SELECT ?head WHERE { GRAPH <urn:rezics:graph:current> {
      <${org.agent}> <https://rezics.com/vocab/head> ?head } }`)).results!.bindings![0]!.head!.value;
    await json(await call('PUT', `/v1/agents/${org.agent.slice(-36)}/profile`, {
      profile: 'agent-public-profile-v2', expectedHead: head, displayName: 'North Star',
      avatarSelection: null, bio: null, localizedName: { original: 'en',
        labels: { en: 'North Star', 'zh-Hans': '北辰', ar: 'نجم الشمال' } } }, h.token), 201);
    const agent = async () => {
      const id = `https://rezics.com/id/${randomUUID()}`;
      await h.accessPool.query("INSERT INTO access.authority_subject (id, kind) VALUES ($1, 'agent')", [id]);
      return id;
    };
    const mandate = async (subject: string, action: string, maxPathEdges = 0) => {
      const id = randomUUID();
      await h.accessPool.query(`INSERT INTO access.representation
        (id, principal_id, subject_id, action, max_path_edges, valid_until)
        VALUES ($1,$2,$3,$4,$5,CASE WHEN $4 = 'agent.control' THEN 'infinity'::timestamptz
          ELSE now() + interval '1 hour' END)`,
      [id, principalId, subject, action, maxPathEdges]);
      return id;
    };
    const grant = async (subject: string, action: string) => {
      const id = randomUUID();
      await h.accessPool.query(`INSERT INTO access.permission_grant
        (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
        VALUES ($1,$2,$2,'work:create:root',$3,now() + interval '1 hour')`, [id, subject, action]);
      return id;
    };
    const grantedOnly = await agent();
    await grant(grantedOnly, 'work.create');
    const expired = await agent();
    const expiredMandate = await mandate(expired, 'realm.members.manage');
    await h.accessPool.query("UPDATE access.representation SET valid_until = now() - interval '1 minute', generation = generation + 1 WHERE id = $1", [expiredMandate]);
    const inactive = await agent();
    await mandate(inactive, 'realm.members.manage');
    await h.accessPool.query('UPDATE access.authority_subject SET active = false, generation = generation + 1 WHERE id = $1', [inactive]);
    const realmPerson = await agent();
    await mandate(realmPerson, 'realm.members.manage');
    const represented = await agent();
    const representationId = await mandate(represented, 'work.create');
    const publisher = await agent();
    await mandate(publisher, 'work.create');
    await grant(publisher, 'work.create');
    const attributed = await agent();
    await h.accessPool.query(`INSERT INTO access.principal_agent_attribution
      (id, principal_id, agent_subject, action, valid_until)
      VALUES ($1,$2,$3,'work.create',now() + interval '1 hour')`,
    [randomUUID(), principalId, attributed]);
    const check = (actingSubject: string) => call('POST', '/v1/me/acting-context-checks', {
      profile: 'work-create-acting-context-check-v1', task: 'work.create', actingSubject,
      expectedAuthorityEpoch: '0' }, h.wrongScopeToken);
    const work = (actingSubject: string) => call('POST', '/v1/works', {
      profile: 'metadata-only-v1', title: 'G-521 denied work', language: 'en', actingSubject }, h.wrongScopeToken);
    let sessionRevision: string | null = null;
    let mainRevision: string | null = null;
    const choose = async (actingSubject: string) => {
      const key = randomUUID();
      const request = { actingSubject, expectedRevision: sessionRevision };
      const chosen = await json<{ revision: string }>(await call('PUT', '/v1/me/session-agent', request, identityToken, key));
      expect(await json(await call('PUT', '/v1/me/session-agent', request, identityToken, key)))
        .toMatchObject({ revision: chosen.revision, replayed: true });
      sessionRevision = chosen.revision;
      mainRevision = (await json<{ revision: string }>(await call('PUT', '/v1/me/main-agent-preference', {
        actingSubject, expectedRevision: mainRevision }))).revision;
      expect(await json(await call('GET', '/v1/me/session-agent'))).toMatchObject({
        sessionAgent: { actingSubject, eligible: true }, mainAgent: { actingSubject, eligible: true } });
      expect(await json(await call('GET', '/v1/me/main-agent-preference'))).toMatchObject({
        mainAgent: { actingSubject, eligible: true } });
    };
    // Every row must survive the same single read: filtering by any one task
    // loses at least the control-only Organization or the Realm-only Person.
    const matrix = [org.agent, realmPerson, represented, publisher, attributed];
    const read = await json<AgentDiscovery>(await call('GET', '/v1/me/agents', undefined, identityToken,
      randomUUID(), 'ar;q=1, en;q=0.5'));
    expect(read.complete).toBe(true);
    expect(read.items.map(item => item.actingSubject)).toEqual([...matrix].sort());
    expect(read.items.find(item => item.actingSubject === org.agent)).toMatchObject({ kind: 'organization',
      displayName: { value: 'نجم الشمال', language: 'ar', direction: 'rtl' } });
    expect((await json<AgentDiscovery>(await call('GET', '/v1/me/agents?languages=zh-CN',
      undefined, identityToken, randomUUID(), 'ar'))).items.find(item => item.actingSubject === org.agent))
      .toMatchObject({ displayName: { value: '北辰', language: 'zh-Hans', direction: 'ltr' } });
    expect((await json<AgentDiscovery>(await call('GET', '/v1/me/agents?languages=de')))
      .items.find(item => item.actingSubject === org.agent))
      .toMatchObject({ displayName: { value: 'North Star', language: 'en', direction: 'ltr' } });
    for (const deniedIdentity of [grantedOnly, expired, inactive]) {
      expect(read.items.map(item => item.actingSubject)).not.toContain(deniedIdentity);
      expect((await call('PUT', '/v1/me/session-agent', { actingSubject: deniedIdentity,
        expectedRevision: null })).status).toBe(403);
    }
    for (const privateId of [principalId, h.user.id]) expect(JSON.stringify(read)).not.toContain(privateId);
    expect((await app.handle(new Request('http://main.local/v1/me/agents'))).status).toBe(401);
    expect((await call('GET', '/v1/me/agents?task=work.create')).status).toBe(400);
    expect((await call('GET', '/v1/me/acting-contexts?task=work.create')).status).toBe(401);
    const taskRead = await json<{ contexts: { actingSubject: string }[] }>(
      await call('GET', '/v1/me/acting-contexts?task=work.create', undefined, h.wrongScopeToken));
    expect(taskRead.contexts.map(item => item.actingSubject)).toEqual([publisher]);
    for (const subject of matrix.filter(subject => subject !== publisher)) {
      await choose(subject);
      expect((await check(subject)).status).toBe(403);
      expect((await work(subject)).status).toBe(403);
    }
    // IAM01 pending subcase: a saved selection cannot rewrite admitted work.
    await choose(publisher);
    const digest = createHash('sha256').update('G-521 immutable admission').digest('hex');
    const admitted = await access.register({ principal, actingSubject: publisher,
      scope: 'work:create:root', action: 'work.create', idempotencyKey: randomUUID(), requestDigest: digest });
    await choose(org.agent);
    expect((await access.claim(admitted.id, digest)).actingSubject).toBe(publisher);
    expect((await h.accessPool.query<{ acting_subject: string }>(
      'SELECT acting_subject FROM access.admission WHERE id = $1', [admitted.id])).rows[0]!.acting_subject).toBe(publisher);

    await h.accessPool.query("UPDATE access.scope_gate SET open = false, dispatch_open = false WHERE id = 'work:create:root'");
    const closedRead = await json<AgentDiscovery>(await call('GET', '/v1/me/agents'));
    expect(closedRead.items.map(item => item.actingSubject)).toEqual([...matrix].sort());
    for (const subject of matrix) {
      await choose(subject);
      expect((await check(subject)).status).toBe(403);
      expect((await work(subject)).status).toBe(403);
    }
    await h.accessPool.query("UPDATE access.scope_gate SET open = true, dispatch_open = true WHERE id = 'work:create:root'");
    // The provision remains terminal/active after the creator loses control.
    // It must never keep that creator in discovery or saved-choice eligibility.
    await choose(org.agent);
    const provision = (await h.accessPool.query<{ representation_id: string; state: string }>(
      'SELECT representation_id, state FROM access.agent_provision WHERE agent_id = $1 AND principal_id = $2',
      [org.agent, principalId])).rows[0]!;
    expect(provision.state).toBe('active');
    await h.accessPool.query('UPDATE access.representation SET active = false, generation = generation + 1 WHERE id = $1',
      [provision.representation_id]);
    expect((await h.accessPool.query<{ state: string }>(
      'SELECT state FROM access.agent_provision WHERE agent_id = $1', [org.agent])).rows[0]!.state).toBe('active');
    expect((await json<AgentDiscovery>(await call('GET', '/v1/me/agents')))
      .items.map(item => item.actingSubject)).not.toContain(org.agent);
    expect(await json(await call('GET', '/v1/me/session-agent'))).toMatchObject({
      sessionAgent: { actingSubject: org.agent, eligible: false }, mainAgent: { actingSubject: org.agent, eligible: false } });
    expect(await json(await call('GET', '/v1/me/main-agent-preference'))).toMatchObject({
      mainAgent: { actingSubject: org.agent, eligible: false } });
    expect((await call('PUT', '/v1/me/session-agent', { actingSubject: org.agent,
      expectedRevision: sessionRevision })).status).toBe(403);
    expect((await call('PUT', '/v1/me/main-agent-preference', { actingSubject: org.agent,
      expectedRevision: mainRevision })).status).toBe(403);
    expect((await work(org.agent)).status).toBe(403);

    await choose(represented);
    await h.accessPool.query('UPDATE access.representation SET active = false, generation = generation + 1 WHERE id = $1',
      [representationId]);
    const revoked = await json<AgentDiscovery>(await call('GET', '/v1/me/agents'));
    expect(revoked.items.map(item => item.actingSubject)).not.toContain(represented);
    expect(await json(await call('GET', '/v1/me/session-agent'))).toMatchObject({
      sessionAgent: { actingSubject: represented, eligible: false }, mainAgent: { actingSubject: represented, eligible: false } });
    expect((await call('PUT', '/v1/me/session-agent', { actingSubject: represented,
      expectedRevision: sessionRevision })).status).toBe(403);
    expect((await call('PUT', '/v1/me/main-agent-preference', { actingSubject: represented,
      expectedRevision: mainRevision })).status).toBe(403);
    expect((await work(represented)).status).toBe(403);
    await expect(access.register({ principal, actingSubject: represented,
      scope: 'work:create:root', action: 'work.create', idempotencyKey: randomUUID(), requestDigest: digest }))
      .rejects.toBeInstanceOf(AdmissionDenied);

    // Composed discovery uses the topology owner's admission path evaluator.
    const origin = await agent();
    const target = await agent();
    await mandate(origin, 'realm.members.manage', 1);
    await mandate(target, 'access.representation.manage');
    const ceiling = await grant(target, 'access.representation.assign.realm.members.manage');
    const topology = new AccessTopology(h.accessPool);
    const topologyEpoch = async () => (await h.accessPool.query<{ authority_epoch: string }>(
      "SELECT authority_epoch FROM access.scope_gate WHERE id = 'access:representation-topology'" )).rows[0]!.authority_epoch;
    const edgeId = randomUUID();
    await topology.changeEdge(principal, { idempotencyKey: randomUUID(), requestDigest: digest }, {
      action: 'create', edgeId, representativeSubject: origin, representedSubject: target,
      edgeAction: 'realm.members.manage', maxPathEdges: 1, validUntil: new Date(Date.now() + 30 * 60_000),
      expectedTopologyEpoch: await topologyEpoch() });
    // Remove the target's management mandate: only P -> origin -> target remains.
    await h.accessPool.query(`UPDATE access.representation SET active = false, generation = generation + 1
      WHERE subject_id = $1 AND action = 'access.representation.manage'`, [target]);
    expect((await json<AgentDiscovery>(await call('GET', '/v1/me/agents')))
      .items.map(item => item.actingSubject)).toContain(target);
    await choose(target);
    await h.accessPool.query('UPDATE access.permission_grant SET active = false, generation = generation + 1 WHERE id = $1', [ceiling]);
    expect((await json<AgentDiscovery>(await call('GET', '/v1/me/agents')))
      .items.map(item => item.actingSubject)).not.toContain(target);
    expect(await json(await call('GET', '/v1/me/session-agent'))).toMatchObject({
      sessionAgent: { actingSubject: target, eligible: false } });
    expect((await check(target)).status).toBe(403);

    await h.accessPool.query('UPDATE access.recovery_fence SET open = false WHERE id = true');
    try {
      for (const path of ['/v1/me/agents', '/v1/me/session-agent', '/v1/me/main-agent-preference']) {
        expect((await call('GET', path)).status).toBe(503);
      }
      expect((await call('PUT', '/v1/me/session-agent', { actingSubject: null,
        expectedRevision: sessionRevision })).status).toBe(503);
      expect((await call('PUT', '/v1/me/main-agent-preference', { actingSubject: null,
        expectedRevision: mainRevision })).status).toBe(503);
    } finally { await h.accessPool.query('UPDATE access.recovery_fence SET open = true WHERE id = true'); }

    // Fixed query budget across direct identity growth; one extra distinct
    // Agent beyond bounds is unavailable on discovery and both saved reads.
    let discoveryQueries = 0;
    const countedPool = { connect: async () => {
      const client = await h.accessPool.connect();
      return new Proxy(client, { get(target, property) {
        if (property === 'query') return (...args: unknown[]) => {
          discoveryQueries += 1;
          return (target.query as (...values: unknown[]) => unknown).apply(target, args);
        };
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
    } } as unknown as Pool;
    const counted = new AccessActingContexts(countedPool);
    const live = await counted.discoverAgents(principal);
    const smallQueries = discoveryQueries;
    expect(smallQueries).toBeLessThanOrEqual(12);
    const extras = Array.from({ length: 50 - live.items.length }, () => `https://rezics.com/id/${randomUUID()}`);
    await h.accessPool.query(`INSERT INTO access.authority_subject (id, kind)
      SELECT id, 'agent' FROM unnest($1::text[]) AS id`, [extras]);
    await h.accessPool.query(`INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until)
      SELECT gen_random_uuid(), $2, id, 'realm.members.manage', now() + interval '1 hour'
      FROM unnest($1::text[]) AS id`, [extras, principalId]);
    expect((await json<AgentDiscovery>(await call('GET', '/v1/me/agents'))).items).toHaveLength(50);
    discoveryQueries = 0;
    expect((await counted.discoverAgents(principal)).items).toHaveLength(50);
    expect(discoveryQueries).toBe(smallQueries);
    const overflow = await agent();
    await mandate(overflow, 'agent.control');
    for (const path of ['/v1/me/agents', '/v1/me/session-agent', '/v1/me/main-agent-preference']) {
      expect((await call('GET', path)).status).toBe(503);
    }
  } finally { await h.close(); }
}, 120_000);
