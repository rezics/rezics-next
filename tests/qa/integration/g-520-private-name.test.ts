import { signupPolicyFixture } from '../../../scripts/dev/signup-policy-fixture.ts';
import { signIn } from '../../../scripts/lib/oauth-client.ts';
import { expect, test } from 'bun:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { cloneQaOwnerDatabases } from '../support/databases.ts';
import { agentProvisionHarness } from './agent-provision-support.ts';
import { startMediaStack } from './media-support.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { AccessAdmissionRegistry } from '../../../services/main/src/modules/access/admission.ts';
import { AccessActingContexts } from '../../../services/main/src/modules/access/contexts.ts';
import { AccessSessionAgents } from '../../../services/main/src/modules/access/session-agent.ts';
import { AccessRealmRoster } from '../../../services/main/src/modules/access/roster.ts';
import { AgentProvisioning } from '../../../services/main/src/modules/agent/provision.ts';
import { AgentVanityHandles } from '../../../services/main/src/modules/agent/vanity.ts';
import { ProfilesAccess } from '../../../services/main/src/modules/profiles/access.ts';
import { OnboardingPersons } from '../../../services/main/src/modules/onboarding/persons.ts';
import { PersonPreferencesStore } from '../../../services/main/src/modules/preferences/store.ts';
import { type PersonOnboardingResult } from '../../../services/main/src/modules/onboarding/ensure.ts';
import { GRAPHS, RV, iri, lit } from '../../../services/main/src/modules/work/activate.ts';

const short = (id: string) => id.slice(-36);
async function json<T>(response: Response, status = 200): Promise<T> {
  const body = await response.text();
  expect(response.status, body).toBe(status);
  return JSON.parse(body) as T;
}

test('G-520: private Account names never provision or appear in public Person, handle, credits search, roster or Jena', async () => {
  const databases = await cloneQaOwnerDatabases(Bun.env.REZICS_QA_RUN_ID!, ['account', 'access'], 'owner');
  const original = [Bun.env.ACCOUNT_DATABASE_URL, Bun.env.ACCESS_DATABASE_URL];
  let h: Awaited<ReturnType<typeof agentProvisionHarness>> | undefined;
  let storage: Awaited<ReturnType<typeof startMediaStack>> | undefined;
  try {
    Bun.env.ACCOUNT_DATABASE_URL = databases.urls.account;
    Bun.env.ACCESS_DATABASE_URL = databases.urls.access;
    h = await agentProvisionHarness(['agent:create', 'work:create', 'work:edit', 'space:create']);
    [Bun.env.ACCOUNT_DATABASE_URL, Bun.env.ACCESS_DATABASE_URL] = original;
    storage = await startMediaStack('g-520');
    const marker = `PRIVATE-MARKER-${randomUUID()}`;
    // The shard's demo author also uses 林梅; the positive search control must
    // identify this Person independently of every earlier fixture.
    const publicName = `林梅 ${randomUUID()}`;
    const email = `${randomUUID()}@example.test`;
    const password = randomBytes(24).toString('base64url');
    const signedUp = await json<{ user: { id: string; name: string } }>(await h.accountApp.handle(
      new Request(`${h.base}/api/auth/sign-up/email`, { method: 'POST',
        headers: { 'content-type': 'application/json', origin: h.base },
        body: JSON.stringify({ ...signupPolicyFixture, name: marker, email, password }) })));
    expect(signedUp.user.name).toBe(marker);
    // Membership eligibility is a separate Account assertion, not a public name.
    await h.accountPool.query('UPDATE "user" SET "emailVerified" = true WHERE id = $1', [signedUp.user.id]);
    const signedIn = await fetch(`${h.base}/api/auth/sign-in/email`, { method: 'POST',
      headers: { 'content-type': 'application/json', origin: h.base },
      body: JSON.stringify({ email, password }) });
    expect(signedIn.status).toBe(200);
    const scope = 'openid agent:create work:create work:edit space:create';
    const accessToken = (await signIn({
      account: h.base, clientId: h.client.client_id, redirectUri: h.redirectUri, scope,
      resource: Bun.env.ACCOUNT_MAIN_RESOURCE!,
    }, signedIn.headers.get('set-cookie')!)).accessToken;
    const introspected = await json<Record<string, unknown>>(await fetch(`${h.base}/api/auth/oauth2/introspect`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: accessToken, client_id: h.verifierClient.client_id,
        client_secret: h.verifierClient.client_secret! }) }));
    expect(introspected.active).toBe(true);
    expect(JSON.stringify(introspected)).not.toContain(marker);
    expect(introspected).not.toHaveProperty('rezics_account_name');

    const env = storage.env;
    const access = new AccessAdmissionRegistry(h.accessPool);
    access.configureBaseline(h.fuseki);
    const contexts = new AccessActingContexts(h.accessPool, env);
    const sessions = new AccessSessionAgents(h.accessPool, contexts);
    let nameReads = 0;
    const namePool = new Proxy(h.accessPool, { get(target, property) {
      if (property === 'query') return (...args: unknown[]) => {
        nameReads++;
        return Reflect.apply(target.query, target, args);
      };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const app = createMainApp(h.fuseki, { environment: env, access, account: h.verifier,
      content: storage.content, contentAuthoring: storage.content,
      agentProvisioning: new AgentProvisioning(h.accessPool, env),
      onboardingPersons: new OnboardingPersons(namePool), sessionAgents: sessions,
      agentHandles: new AgentVanityHandles(h.accessPool), profiles: new ProfilesAccess(h.accessPool),
      personPreferences: new PersonPreferencesStore(h.accessPool),
      realmRoster: new AccessRealmRoster(h.accessPool, env) });
    const sessionKey = randomUUID();
    const call = (method: string, path: string, body?: unknown, authenticated = true,
      session = sessionKey) => app.handle(new Request(`http://main.test${path}`, { method,
      headers: { ...(authenticated ? { authorization: `Bearer ${accessToken}` } : {}),
        'x-session-key': session, 'idempotency-key': randomUUID(), 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
    const principal = await h.verifier.verify(new Request('http://main.test', {
      headers: { authorization: `Bearer ${accessToken}` } }), ['agent:create', 'work:create']);
    expect(principal.emailVerified).toBe(true);
    expect(principal).not.toHaveProperty('accountDisplayName');
    const graphPosition = () => h!.fuseki.query(`SELECT ?n WHERE {
      GRAPH ${iri(GRAPHS.control)} { ?dataset <${RV}sequence> ?n } }`);
    const beforeGraph = await graphPosition();
    const beforeSubjects = (await h.accessPool.query('SELECT count(*)::int AS n FROM access.authority_subject')).rows[0];
    const unnamed = { profile: 'person-onboarding-v1' };
    for (let attempt = 0; attempt < 2; attempt++) {
      const missing = await call('POST', '/v1/me/onboarding', unnamed);
      expect(missing.headers.get('cache-control')).toBe('no-store');
      expect(await json(missing, 409)).toMatchObject({ code: 'public_name_required', status: 409 });
    }
    expect(nameReads).toBe(2); // One read per refusal, no provision-name probe or write.
    for (const displayName of ['', 'x'.repeat(201), '\u0000private', null]) {
      expect((await call('POST', '/v1/me/onboarding', { ...unnamed, displayName })).status).toBe(400);
    }
    expect((await call('POST', '/v1/me/onboarding', { ...unnamed, displayName: publicName }, false)).status).toBe(401);
    expect(await access.activePrincipalId(principal)).toBeNull();
    expect((await h.accessPool.query(`SELECT count(*)::int AS n FROM access.agent_provision a
      JOIN access.principal p ON p.id = a.principal_id
      WHERE p.account_issuer = $1 AND p.account_subject = $2`, [principal.issuer, principal.subject])).rows[0]?.n).toBe(0);
    expect((await sessions.readSession(principal, sessionKey)).sessionAgent.actingSubject).toBeNull();
    expect((await h.accessPool.query('SELECT count(*)::int AS n FROM access.authority_subject')).rows[0]).toEqual(beforeSubjects);
    expect(await graphPosition()).toEqual(beforeGraph);

    const first = await json<PersonOnboardingResult>(await call('POST', '/v1/me/onboarding',
      { ...unnamed, displayName: publicName }), 201);
    const agent = first.agent;
    expect(first).toMatchObject({ state: 'active', sessionAgent: agent, suggestedHandle: 'reader', replayed: false });
    expect(nameReads).toBe(4); // Successful onboarding has two indexed name reads.
    const replays = await Promise.all([call('POST', '/v1/me/onboarding', unnamed),
      call('POST', '/v1/me/onboarding', { ...unnamed, displayName: 'Different public name' }),
      call('POST', '/v1/me/onboarding', { ...unnamed, displayName: 'Another name' }, true, randomUUID())]);
    for (const replay of replays) expect(await json(replay)).toMatchObject({
      agent, replayed: true, sessionAgent: agent, suggestedHandle: 'reader' });
    expect(nameReads).toBe(10);
    const principalId = await access.activePrincipalId(principal);
    expect((await h.accessPool.query(`SELECT display_name FROM access.agent_provision
      WHERE principal_id = $1 AND agent_kind = 'person'`, [principalId])).rows).toEqual([{ display_name: publicName }]);

    const noMarker = async <T>(response: Response): Promise<T> => {
      const value = await json<T>(response);
      expect(JSON.stringify(value)).not.toContain(marker);
      return value;
    };
    for (const path of [`/v1/agents/${short(agent)}`, `/v1/handles/agent-${short(agent)}`]) {
      expect(await noMarker(await call('GET', path, undefined, false))).toMatchObject({ id: agent, displayName: publicName });
    }
    // Real public reads must have a positive public-name control, not empty fixtures.
    const work = await storage.publicWork(agent, ['en'], 'A public book');
    const workHead = (await h.fuseki.query(`SELECT ?head WHERE {
      GRAPH ${iri(GRAPHS.current)} { ${iri(work.work)} <${RV}head> ?head } }`)).results?.bindings[0]?.head?.value;
    await h.accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING', [`work:edit:${work.work}`]);
    await h.accessPool.query(`INSERT INTO access.representation (id,principal_id,subject_id,action,valid_until)
      VALUES ($1,$2,$3,'work.edit','infinity')`, [randomUUID(), principalId, agent]);
    await h.accessPool.query(`INSERT INTO access.permission_grant
      (id,issuer_subject,recipient_subject,scope_id,action,valid_until)
      VALUES ($1,$2,$2,$3,'work.edit','infinity')`, [randomUUID(), agent, `work:edit:${work.work}`]);
    await json(await call('POST', `/v1/works/${short(work.work)}/agent-credits`, {
      profile: 'native-agent-credit-v1', credit: `https://rezics.com/id/${randomUUID()}`, agent,
      role: 'author', expectedWorkHead: workHead, actingSubject: agent }), 201);
    expect(await noMarker(await call('GET', `/v1/works/${short(work.work)}/agent-credits`, undefined, false)))
      .toMatchObject({ items: [{ agent, displayName: publicName }] });
    const search = (phrase: string) => call('POST', '/v1/queries', {
      profile: 'public-main-phrase-v1', phrase, language: null }, false);
    expect(await noMarker(await search(publicName))).toMatchObject({ total: 1,
      results: [{ work: work.work, matchedField: 'credit', matchedText: publicName }] });
    expect(await noMarker(await search(marker))).toMatchObject({ results: [], total: 0 });

    const realm = await json<{ realm: string }>(await call('POST', '/v1/spaces', {
      profile: 'space-realm-v1', name: 'Public reading circle', capabilities: ['realm'], actingSubject: agent }), 201);
    // Seed only the unrelated membership fixture; the public roster uses its real owner.
    const membership = randomUUID();
    await h.accessPool.query(`INSERT INTO access.authority_subject (id,kind)
      VALUES ($1,'institution') ON CONFLICT DO NOTHING`, [realm.realm]);
    await h.accessPool.query(`INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING`, [`governance:realm:${realm.realm}`]);
    await h.accessPool.query(`INSERT INTO access.membership_policy (kind,owner_subject,revision,terms_revision)
      VALUES ('realm',$1,0,'realm-membership-v1') ON CONFLICT DO NOTHING`, [realm.realm]);
    await h.accessPool.query(`INSERT INTO access.membership
      (id,kind,owner_subject,member_subject,state,generation,policy_revision,terms_revision,consent_reference)
      VALUES ($1,'realm',$2,$3,'joined',1,0,'realm-membership-v1','g-520-fixture')`, [membership, realm.realm, agent]);
    await h.accessPool.query(`INSERT INTO access.realm_roster_listing
      (membership_id,membership_generation,realm,member,listed) VALUES ($1,1,$2,$3,true)`, [membership, realm.realm, agent]);
    expect(await noMarker(await call('GET', `/v1/realms/${short(realm.realm)}/roster`, undefined, false)))
      .toMatchObject({ items: [{ agent, displayName: publicName }] });
    expect((await h.fuseki.query(`ASK {
      { ?s ?p ?o . FILTER(CONTAINS(STR(?s), ${lit(marker)}) || CONTAINS(STR(?p), ${lit(marker)}) || CONTAINS(STR(?o), ${lit(marker)})) }
      UNION { GRAPH ?g { ?s ?p ?o } FILTER(CONTAINS(STR(?g), ${lit(marker)}) || CONTAINS(STR(?s), ${lit(marker)})
        || CONTAINS(STR(?p), ${lit(marker)}) || CONTAINS(STR(?o), ${lit(marker)})) }
    }`)).boolean).toBe(false);
  } finally {
    [Bun.env.ACCOUNT_DATABASE_URL, Bun.env.ACCESS_DATABASE_URL] = original;
    await storage?.stop();
    await h?.close();
    await databases.close();
  }
});
