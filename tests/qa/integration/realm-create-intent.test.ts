import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startMediaStack } from './media-support.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { AccessRealmManagement } from '../../../services/main/src/modules/access/realm-management.ts';
import { AccountAssertionDenied } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { RealmAdminUnavailable } from '../../../services/main/src/modules/realm-admin/contract.ts';
import { GRAPHS, iri } from '../../../services/main/src/modules/work/activate.ts';
import { readRealmPolicy } from '../../../services/main/src/modules/space/policy.ts';
import { RealmSubmissionStore } from '../../../services/main/src/modules/realm-submission/store.ts';
import { provisionFixtureAuthor } from '../fixtures/authored-work.ts';
import { withRealmPermit } from '../../../services/main/src/modules/access/realm-management-policy.ts';
import { spaceCreationReceiptIri } from '../../../services/main/src/modules/space/create.ts';

test('Private creation never exposes a public shell through failures, concurrent retries or lost responses', async () => {
  const s = await startMediaStack('realm-create-intent');
  const creator = await s.member('founder');
  const outsider = await s.member('outsider');
  await creator.grant('space:create:root', 'space.create');
  await creator.grant(`agent:control:${creator.actor}`, 'agent.control');
  const admin = new AccessRealmManagement(s.accessPool);
  const app = createMainApp(s.fuseki, { environment: s.env, access: s.access, realmAdmin: admin,
    account: { verify: async request => {
      const token = request.headers.get('authorization')?.replace('Bearer ', '');
      const member = [creator, outsider].find(candidate => candidate.token === token);
      if (!member) throw new AccountAssertionDenied('Bearer required');
      return member.principal;
    } } });
  const call = (method: string, path: string, body?: unknown, key = randomUUID(), token: string | null = creator.token) =>
    app.handle(new Request(`http://main.test${path}`, { method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}),
        'content-type': 'application/json', 'idempotency-key': key },
      body: body === undefined ? undefined : JSON.stringify(body) }));
  const rules = [{ id: 'respect', governanceRule: null,
    title: { original: 'ja', labels: { ja: '尊重', en: 'Respect' } },
    body: { original: 'ja', labels: { ja: '読者を尊重する。', en: 'Respect readers.\nDiscuss books.' } } }];
  const settings = { visibility: 'private', reviewRequired: true, reviewMode: 'mandatory',
    whoMaySubmit: 'closed', selfJoin: false, rules } as const;
  let stage = '';
  let used = false;
  const fail = (at: string) => {
    if (stage === at && !used) { used = true; throw new RealmAdminUnavailable(`Injected ${at} failure`); }
  };
  const register = s.access.register.bind(s.access);
  s.access.register = async (...args) => { const result = await register(...args); fail('registered'); return result; };
  const claim = s.access.claim.bind(s.access);
  s.access.claim = async (...args) => { const result = await claim(...args); fail('claimed'); return result; };
  const alias = s.env.addresses!.write.bind(s.env.addresses!);
  s.env.addresses!.write = async (...args) => { const result = await alias(...args); fail('alias'); return result; };
  const acknowledge = s.access.recordGraphOutcome.bind(s.access);
  s.access.recordGraphOutcome = async (...args) => { const result = await acknowledge(...args); fail('acknowledged'); return result; };
  const initialize = admin.initializeCreated.bind(admin);
  admin.initializeCreated = async (...args) => {
    fail('initialization-before');
    const result = await initialize(...args);
    fail('initialization-after');
    return result;
  };
  const graphCommand = s.fuseki.commandWithReceipt.bind(s.fuseki);
  const realms = async (name: string) => (await s.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
    PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
    SELECT ?space ?realm ?disclosure ?revision WHERE { GRAPH ${iri(GRAPHS.current)} {
      ?space a rv:Space ; rdfs:label ${JSON.stringify(name)}@ja ; rv:realmCapability ?realm ; rv:disclosure ?disclosure .
      ?realm rv:head ?revision . } } LIMIT 2`, 4096)).results?.bindings ?? [];
  const invisible = async (space: string, realm: string) => {
    for (const token of [null, outsider.token]) {
      const query = token ? `?actingSubject=${encodeURIComponent(outsider.actor)}` : '';
      expect((await call('GET', `/v1/spaces/${space.slice(-36)}`, undefined, randomUUID(), token)).status).toBe(404);
      for (const suffix of ['', '/works', '/decisions']) {
        const response = await call('GET', `/v1/realms/${realm.slice(-36)}${suffix}${query}`, undefined, randomUUID(), token);
        expect(response.status, await response.clone().text()).toBe(404);
      }
    }
  };
  let currentName = '';
  let graphFailure = '';
  s.fuseki.commandWithReceipt = async envelope => {
    if (!envelope.update.includes('rv:SpaceCreatedEvent')) return graphCommand(envelope);
    fail('graph-before');
    const result = await graphCommand(envelope).catch((error: unknown) => {
      graphFailure = error instanceof Error ? error.message : String(error);
      throw error;
    });
    if (result.status !== 'committed') { graphFailure = JSON.stringify(result); return result; }
    const row = (await realms(currentName))[0]!;
    expect(row.disclosure?.value).toBe('https://rezics.com/vocab/Private');
    // Probe between graph commit and the first Access initialization attempt.
    await invisible(row.space!.value, row.realm!.value);
    fail('graph-after');
    return result;
  };
  try {
    for (const fault of ['registered', 'claimed', 'alias', 'graph-before', 'graph-after',
      'acknowledged', 'initialization-before', 'initialization-after', 'response-lost']) {
      stage = fault;
      used = false;
      currentName = `Private ${fault} ${randomUUID()}`;
      const key = randomUUID();
      const body = { profile: 'space-realm-v2', name: currentName, language: 'ja',
        handle: `club-${randomUUID().slice(0, 8)}`, capabilities: ['realm'], actingSubject: creator.actor,
        initialSettings: settings };
      const first = await call('POST', '/v1/spaces', body, key);
      expect([201, 202, 503]).toContain(first.status);
      if (fault !== 'response-lost') expect(used).toBe(true);
      const intermediate = await realms(currentName);
      expect(intermediate.length).toBeLessThanOrEqual(1);
      if (intermediate[0]) await invisible(intermediate[0].space!.value, intermediate[0].realm!.value);
      stage = '';
      const retries = await Promise.all([call('POST', '/v1/spaces', body, key), call('POST', '/v1/spaces', body, key)]);
      const observed = (await realms(currentName))[0];
      const graphPolicy = observed ? await readRealmPolicy(s.env, observed.realm!.value) : null;
      const permitRevision = observed ? await withRealmPermit(s.accessPool, creator.principal, creator.actor,
        observed.realm!.value, 'submission', async permit => permit.revision) : null;
      const revisions = JSON.stringify({ fault, realm: observed?.realm?.value,
        graphPolicyRevision: graphPolicy?.revision, permitRevision });
      for (const response of retries) expect(response.status, `${await response.clone().text()} ${graphFailure} ${revisions}`).toBe(200);
      const created = await retries[0]!.json() as { space: string; realm: string; realmRevision: string; replayed: boolean };
      expect(await retries[1]!.json()).toEqual(created);
      expect(created.replayed).toBe(true);
      expect(await realms(currentName)).toHaveLength(1);
      await invisible(created.space, created.realm);
      expect(await readRealmPolicy(s.env, created.realm)).toMatchObject({ visibility: 'private', reviewMode: 'mandatory', admission: 'invitation' });
      const initialPolicyRevision = spaceCreationReceiptIri(created.space.slice(-36));
      expect((await readRealmPolicy(s.env, created.realm))?.revision).toBe(initialPolicyRevision);
      const creationReceipt = spaceCreationReceiptIri(created.space.slice(-36));
      expect((await s.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/> ASK {
        GRAPH ${iri(GRAPHS.current)} { ${iri(created.realm)} rv:realmPolicyHead ${iri(creationReceipt)} }
        GRAPH ${iri(GRAPHS.receipts)} { ${iri(creationReceipt)} a rv:OperationReceipt ; rv:realm ${iri(created.realm)} }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(initialPolicyRevision)} ?p ?o } }
      }`, 1024)).boolean).toBe(true);
      const view = await call('GET', `/v1/realms/${created.realm.slice(-36)}/settings?actingSubject=${encodeURIComponent(creator.actor)}`);
      expect(view.status, await view.clone().text()).toBe(200);
      expect(await view.json()).toMatchObject({ generation: '1', settings, ruleBasis: { revision: '1' } });
      const anchors = (await s.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/> SELECT ?manifest WHERE {
        GRAPH ${iri(GRAPHS.revisions)} { ${iri(created.realmRevision)} rv:manifest ?manifest } } LIMIT 1`, 1024)).results!.bindings;
      const manifest = JSON.parse(readFileSync(join(s.env.objectDirectory, anchors[0]!.manifest!.value.slice('urn:rezics:sha256:'.length)), 'utf8')) as { payload: string };
      const payload = JSON.parse(readFileSync(join(s.env.objectDirectory, manifest.payload.slice(7)), 'utf8')) as { state: unknown };
      expect(payload.state).toMatchObject({ initialSettings: settings, initialPolicyRevision });
      expect((await call('POST', '/v1/spaces', { ...body, initialSettings: { ...settings, selfJoin: true } }, key)).status).toBe(409);
      const grants = (await s.accessPool.query(`SELECT count(*)::int AS count FROM access.permission_grant
        WHERE scope_id = $1 AND recipient_subject = $2 AND action = 'realm.owner'`,
      [`governance:realm:${created.realm}`, creator.actor])).rows[0]!.count;
      expect(grants).toBe(1);
      await s.accessPool.query(`UPDATE access.permission_grant SET active = false
        WHERE scope_id = $1 AND recipient_subject = $2 AND action = 'realm.owner'`,
      [`governance:realm:${created.realm}`, creator.actor]);
      expect((await call('POST', '/v1/spaces', body, key)).status).toBe(200);
      expect((await s.accessPool.query(`SELECT count(*)::int AS count FROM access.permission_grant
        WHERE scope_id = $1 AND recipient_subject = $2 AND action = 'realm.owner' AND active`,
      [`governance:realm:${created.realm}`, creator.actor])).rows[0]!.count).toBe(0);
    }
    const invalid = await call('POST', '/v1/spaces', { profile: 'space-realm-v2', name: 'Invalid initial rules',
      capabilities: ['realm'], actingSubject: creator.actor, initialSettings: { ...settings, rules: [...rules, ...rules] } });
    expect(invalid.status).toBe(400);
    const publicResponse = await call('POST', '/v1/spaces', { profile: 'space-realm-v1', name: 'Legacy public',
      capabilities: ['realm'], actingSubject: creator.actor });
    expect(publicResponse.status, await publicResponse.clone().text()).toBe(201);
    const publicRealm = await publicResponse.json() as { space: string; realm: string };
    expect((await call('GET', `/v1/spaces/${publicRealm.space.slice(-36)}`, undefined, randomUUID(), null)).status).toBe(200);
    expect(await readRealmPolicy(s.env, publicRealm.realm)).toMatchObject({ visibility: 'public', reviewMode: 'mandatory', admission: 'invitation' });
  } finally { await s.stop(); }
}, 180_000);

test('Initial review policy accepts trusted member submissions in open mode and keeps mandatory review pending', async () => {
  const s = await startMediaStack('realm-create-open-review');
  try {
    const creator = await s.member('founder');
    await creator.grant('space:create:root', 'space.create');
    await creator.grant(`agent:control:${creator.actor}`, 'agent.control');
    const app = createMainApp(s.fuseki, { environment: s.env, access: s.access,
      realmAdmin: new AccessRealmManagement(s.accessPool),
      realmSubmissions: new RealmSubmissionStore(s.accessPool, s.access, s.env),
      account: { verify: async request => {
        if (request.headers.get('authorization') !== `Bearer ${creator.token}`) throw new AccountAssertionDenied('Bearer required');
        return creator.principal;
      } } });
    const post = (path: string, body: unknown) => app.handle(new Request(`http://main.test${path}`, {
      method: 'POST', headers: { authorization: `Bearer ${creator.token}`,
        'content-type': 'application/json', 'idempotency-key': randomUUID() }, body: JSON.stringify(body) }));
    await creator.grant('work:create:root', 'work.create');
    await provisionFixtureAuthor(s.env, creator.actor);
    const createdWork = await post('/v1/works', { profile: 'metadata-only-v1', authoring: 'own-work',
      title: 'A book to admit', language: 'en', actingSubject: creator.actor });
    expect(createdWork.status, await createdWork.clone().text()).toBe(201);
    const work = await createdWork.json() as { work: string; mainVersion: string; workRevision: string };
    for (const reviewMode of ['open', 'trusted-members', 'mandatory'] as const) {
      const response = await post('/v1/spaces', { profile: 'space-realm-v2', name: `${reviewMode} review from creation`,
        capabilities: ['realm'], actingSubject: creator.actor,
        initialSettings: { visibility: 'public', reviewRequired: reviewMode === 'mandatory', reviewMode,
          whoMaySubmit: 'members', selfJoin: true, rules: [] } });
      expect(response.status, await response.clone().text()).toBe(201);
      const { realm } = await response.json() as { realm: string };
      const policy = await readRealmPolicy(s.env, realm);
      expect(policy).toMatchObject({ visibility: 'public', reviewMode, admission: 'open' });
      const permit = await withRealmPermit(s.accessPool, creator.principal, creator.actor, realm, 'submission',
        async current => current);
      const revisions = JSON.stringify({ realm, reviewMode, member: permit.member,
        permitRevision: permit.revision, graphPolicyRevision: policy?.revision, permitReviewMode: permit.reviewMode });
      expect(permit.member, revisions).toBe(true);
      expect(permit.revision, revisions).toBe(policy!.revision);
      expect(permit.revision, revisions).not.toBeNull();
      await creator.grant(`submission:submit:${realm}`, 'submission.submit');
      const submitted = await post(`/v1/realms/${realm.slice(-36)}/submissions`, { kind: 'work', actingSubject: creator.actor,
        work: work.work, mainVersion: work.mainVersion, workRevision: work.workRevision });
      expect(submitted.status, await submitted.clone().text()).toBe(201);
      expect(await submitted.json(), revisions).toMatchObject({ submission: { state: reviewMode === 'mandatory' ? 'pending' : 'accepted' } });
    }
  } finally { await s.stop(); }
}, 120_000);
