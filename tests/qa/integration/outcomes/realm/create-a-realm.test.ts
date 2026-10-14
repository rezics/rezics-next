import { afterAll, beforeAll, expect, setDefaultTimeout } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { browserMainApi } from '../../../../../apps/web/features/api/browser.ts';
import { createCommunityWithReadback, initialCommunitySettings, stepAfterCreation,
  founderRealmReads, profilePublicationOpensRealm } from '../../../../../apps/web/features/communities/create-form.tsx';
import { communityNames } from '../../../../../apps/web/features/communities/name-fields.ts';
import { discoveryApi } from '../../../../../apps/web/features/discover/api.ts';
import { loadRealmView } from '../../../../../apps/web/features/realm/realm-page.tsx';
import { realmDiscussionReads } from '../../../../../apps/web/features/realm/discussion-read.ts';
import creation from '../../../../../scripts/qa/cases/outcomes/realm/create-a-realm.ts';
import { OutcomeRecorder, outcomeTest } from '../../../support/outcome-test.ts';
import { recordedMainClient } from '../../../support/recorded-main-client.ts';
import {
  personaSessions,
  type PersonaName,
  type PersonaSession,
  type PersonaSessions,
} from '../../../support/personas.ts';

setDefaultTimeout(185_000);
const fileWall = setTimeout(() => { throw new Error('Realm creation file exceeded 480 s'); }, 480_000);
let sessions: PersonaSessions;
let founder: { person: PersonaSession; realm: string };
let handleOwner: { person: PersonaSession; realm: string };
let quotaPerson: PersonaSession;
const recording = new OutcomeRecorder(creation);
type CreatedRealm = { space: string; realm: string; owner: string; replayed: boolean };
const root = (id: string) => `/v1/realms/${id.slice(-36)}`;
const acting = (person: PersonaSession) =>
  `actingSubject=${encodeURIComponent(person.actingSubject ?? sessions.owner.actingSubject!)}`;
async function answer<T>(request: Promise<Response>, status = 200): Promise<T> {
  const response = await request;
  const raw = await response.text();
  expect(response.status, `${response.status}: ${raw}`).toBe(status);
  return JSON.parse(raw) as T;
}
function command(person: PersonaSession, visibility: 'public' | 'private' = 'private') {
  return {
    profile: 'space-realm-v2',
    name: 'Original fixture reading circle',
    language: 'en',
    handle: `circle-${randomUUID().slice(0, 12)}`,
    capabilities: ['realm'],
    actingSubject: person.actingSubject ?? sessions.owner.actingSubject,
    initialSettings: {
      visibility,
      reviewRequired: false,
      reviewMode: 'open',
      whoMaySubmit: 'members',
      selfJoin: false,
      rules: [],
    },
  };
}
async function establishedOwner() {
  const person = (await personaSessions('private')).stranger;
  const input = command(person);
  const created = await answer<CreatedRealm>(person.main('POST', '/v1/spaces', input), 201);
  expect(created).toMatchObject({ owner: person.actingSubject, replayed: false });
  expect(await answer(person.main('GET', `${root(created.realm)}?${acting(person)}`)))
    .toMatchObject({ id: created.realm });
  const prior = await answer<{ settings: unknown }>(
    person.main('GET', `${root(created.realm)}/settings?${acting(person)}`),
  );
  expect(prior.settings).toEqual(input.initialSettings);
  return { person, realm: created.realm };
}
beforeAll(async () => {
  sessions = await personaSessions('private');
  await recording.prepare();
  // Each fixture's stranger is a fresh account with no Spaces. Ownership is
  // established through HTTP before it is used as an owner in either scenario.
  founder = await establishedOwner();
  handleOwner = await establishedOwner();
  quotaPerson = (await personaSessions('private')).stranger;
  const principals = [sessions.owner, founder.person, handleOwner.person, quotaPerson]
    .map(person => person.accountId);
  expect(principals.every(id => id !== null)).toBe(true);
  expect(new Set(principals).size).toBe(4);
}, 180_000);
afterAll(async () => {
  try { await recording.publish(); }
  finally { clearTimeout(fileWall); await sessions?.close(); }
});

outcomeTest(creation, 'visitor', () => qualify('visitor', async () => {
  const sample = proofRequests(sessions.visitor);
  const input = command(sessions.owner, 'public');
  const created = await answer<{ space: string; realm: string }>(
    sessions.owner.main('POST', '/v1/spaces', input),
    201,
  );
  expect(
    await answer(
      sample('public-created-address', 'GET', `/v1/addresses/resolve?scope=space&key=${input.handle}`),
    ),
  ).toMatchObject({ holder: created.space, capabilities: { realm: created.realm } });
  await answer(sample('creation-sign-in-required', 'POST', '/v1/spaces', command(sessions.visitor)), 401);
  const hidden = await answer(sample('private-realm-hidden', 'GET', root(sessions.realm)), 404);
  expect(JSON.stringify(hidden)).not.toContain(sessions.realm);
}), recording);

async function found(name: Exclude<PersonaName, 'visitor'>,
  person = sessions[name], existingRealm = sessions.realm) {
  const sample = proofRequests(person);
  if (name === 'stranger') {
    for (const [label, path] of [
      ['session-agent', '/v1/me/session-agent'],
      ['agent-choices', '/v1/me/agents?languages=en'],
      ['acting-contexts', '/v1/me/acting-contexts?task=work.create'],
      ['acting-agent-profile', `/v1/agents/${person.actingSubject!.slice(-36)}?${acting(person)}`],
    ] as const) await (await sample(label, 'GET', path)).body?.cancel();
    await answer(sample('managed-realms-empty', 'GET', `/v1/me/managed-realms?${acting(person)}`));
    await answer(sample('reading-preferences', 'GET', `/v1/me/person-preferences?${acting(person)}`));
    await answer(sample('topic-choices', 'GET', '/v1/discovery/concepts?limit=20&q='));
    await answer(sample('topic-search-empty', 'GET', `/v1/discovery/concepts?limit=20&q=nomatch${randomUUID().replaceAll('-', '')}`));
  }
  const input = command(person),
    key = randomUUID();
  const created = await answer<CreatedRealm>(
    sample('creation-receipt', 'POST', '/v1/spaces', input, key),
    201,
  );
  expect(created.owner).toBe(person.actingSubject);
  expect(created.replayed).toBe(false);
  expect(await answer(sample('creation-replayed', 'POST', '/v1/spaces', input, key))).toMatchObject({
    space: created.space,
    realm: created.realm,
    owner: person.actingSubject,
    replayed: true,
  });
  await answer(
    sample('creation-intent-conflict', 'POST', '/v1/spaces', { ...input, name: 'Changed creation intent' }, key),
    409,
  );
  await answer(person.main('POST', '/v1/spaces', input), 409);
  await answer(
    person.main('POST', '/v1/spaces', {
      ...command(person),
      actingSubject:
        sessions.stranger.actingSubject === person.actingSubject
          ? sessions.owner.actingSubject
          : sessions.stranger.actingSubject,
    }),
    403,
  );
  const enrolled = await answer<{ receiptId: string }>(
    person.main('POST', `${root(created.realm)}/management`, {
      actingSubject: person.actingSubject,
    }),
  );
  expect(
    await answer(
      person.main('POST', `${root(created.realm)}/management`, {
        actingSubject: person.actingSubject,
      }),
    ),
  ).toMatchObject({ receiptId: enrolled.receiptId, replayed: true });
  const settings = await answer<{ settings: unknown }>(
    sample('initial-realm-settings', 'GET', `${root(created.realm)}/settings?${acting(person)}`),
  );
  expect(settings.settings).toEqual(input.initialSettings);
  expect(
    await answer(sample('created-realm-header', 'GET', `${root(created.realm)}?${acting(person)}`)),
  ).toMatchObject({ id: created.realm });
  await answer(sample('founder-address', 'GET', `/v1/addresses/resolve?scope=space&key=${input.handle}&${acting(person)}`));
  await answer(sample('founder-managed-realms', 'GET', `/v1/me/managed-realms?${acting(person)}`));
  await answer(sessions.visitor.main('GET', root(created.realm)), 404);
  await answer(
    sessions.operator.main('GET', `${root(created.realm)}?${acting(sessions.operator)}`),
    name === 'operator' ? 200 : 404,
  );
  await answer(
    person.main('GET', `${root(existingRealm)}/settings?${acting(person)}`),
    name === 'owner' ? 200 : 403,
  );
  await answer(
    person.main('GET', `${root(existingRealm)}?${acting(person)}`),
    ['owner', 'member', 'moderator'].includes(name) ? 200 : 404,
  );
  await answer(
    person.main('POST', '/v1/spaces', {
      ...command(person),
      topics: [`https://rezics.com/id/${randomUUID()}`],
    }),
    400,
  );
  if (name === 'owner') {
    await answer(person.main('GET', `${root(sessions.realm)}/settings?${acting(person)}`), 403);
    await answer(person.main('GET', `${root(sessions.realm)}?${acting(person)}`), 404);
  }
}
async function concurrentHandle() {
  // This account owns one Realm and has two free slots for simultaneous
  // admissions. Both must reach alias claiming rather than quota refusal.
  const person = handleOwner.person, shared = command(person, 'public');
  const responses = await Promise.all([
    person.main('POST', '/v1/spaces', shared, randomUUID()),
    person.main('POST', '/v1/spaces', shared, randomUUID()),
  ]);
  expect(responses.map(response => response.status).sort()).toEqual([201, 409]);
  const winner = await answer<CreatedRealm>(
    Promise.resolve(responses.find(response => response.status === 201)!), 201,
  );
  await answer(Promise.resolve(responses.find(response => response.status === 409)!), 409);
  expect(winner).toMatchObject({ owner: person.actingSubject, replayed: false });
  expect(await answer(sessions.visitor.main('GET',
    `/v1/addresses/resolve?scope=space&key=${shared.handle}`)))
    .toMatchObject({ holder: winner.space, capabilities: { realm: winner.realm } });
  expect(await answer(person.main('GET', `${root(handleOwner.realm)}?${acting(person)}`)))
    .toMatchObject({ id: handleOwner.realm });
}
async function exhaustedAccountRecovers() {
  const person = quotaPerson, first = command(person), key = randomUUID();
  const sample = proofRequests(person);
  const receipt = await answer<CreatedRealm>(person.main('POST', '/v1/spaces', first, key), 201);
  const zone = await answer<{ space: string; owner: string }>(person.main('POST', '/v1/spaces', {
    profile: 'space-zone-v1', name: 'Original fixture reading site', language: 'en',
    capabilities: ['zone'], actingSubject: person.actingSubject,
  }), 201);
  const third = await answer<CreatedRealm>(person.main('POST', '/v1/spaces', command(person)), 201);
  expect(new Set([receipt.space, zone.space, third.space]).size).toBe(3);
  for (const created of [receipt, zone, third]) expect(created.owner).toBe(person.actingSubject);
  expect(await answer(sample('creation-quota-denied', 'POST', '/v1/spaces', command(person)), 403))
    .toMatchObject({ status: 403, code: 'authority_denied' });
  expect(await answer(person.main('POST', '/v1/spaces', first, key)))
    .toEqual({ ...receipt, replayed: true });
}
outcomeTest(creation, 'stranger', () => qualify('stranger', () => found('stranger')), recording);
outcomeTest(creation, 'member', () => qualify('member', () => found('member')), recording);
outcomeTest(creation, 'owner', () => qualify('owner', async () => {
  await found('owner', founder.person, founder.realm);
  await concurrentHandle();
  await exhaustedAccountRecovers();
}), recording);
outcomeTest(creation, 'moderator', () => qualify('moderator', () => found('moderator')), recording);
outcomeTest(creation, 'operator', () => qualify('operator', () => found('operator')), recording);

function proofRequests(person: PersonaSession) {
  return (_label: string, ...args: Parameters<PersonaSession['main']>) => person.main(...args);
}

async function within(part: string, milliseconds: number, run: () => Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([run(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${part} exceeded ${milliseconds} ms`)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

async function qualify(name: PersonaName, proof: () => Promise<void>) {
  const started = Date.now();
  let proofMs = 0, visitStarted = 0;
  try {
    // The original API proof owns 60 s; recording the production visit owns another 120 s.
    await within('API proof', 60_000, proof);
    proofMs = Date.now() - started;
    visitStarted = Date.now();
    await within('production visit', 120_000, () => visit(name));
  } finally {
    console.info(`[persona-timing] ${name} proofMs=${proofMs || Date.now() - started} visitMs=${visitStarted ? Date.now() - visitStarted : 0}`);
  }
}

const labels = new AsyncLocalStorage<string | ((method: string, path: string) => string)>();
const named = <T,>(label: string | ((method: string, path: string) => string), run: () => Promise<T>) =>
  labels.run(label, run);

async function visit(name: PersonaName) {
  // A submission whose session ended still receives Main’s sign-in refusal.
  if (name === 'visitor') {
    const input = { ...command(sessions.visitor), profile: 'space-realm-v2' as const,
      capabilities: ['realm' as const], actingSubject: sessions.owner.actingSubject!,
      topics: [], initialSettings: initialCommunitySettings('private', []) };
    const refused = await recordedMainClient(recording, name, sessions.visitor, 'form-creation')
      .v1.spaces.post(input, { headers: { 'idempotency-key': randomUUID() } });
    expect(refused.response.status).toBe(401);
    return;
  }
  const person = name === 'owner' ? founder.person : sessions[name];
  const recorded = recording.session(name, person);
  const anonymous = recording.session(name, sessions.visitor);
  const send = async (path: string, personal: boolean, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const label = labels.getStore();
    if (!label) throw new Error(`Unlabelled production request: ${method} ${path}`);
    const headers = new Headers(init?.headers);
    const key = headers.get('idempotency-key') ?? undefined;
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined;
    for (const name of ['authorization', 'cookie', 'x-session-key']) headers.delete(name);
    return (personal ? recorded : anonymous)(typeof label === 'string' ? label : label(method, path),
      method, path, body, key, { headers: Object.fromEntries(headers.entries()), settle: false });
  };
  function client(caller: PersonaSession) {
    return browserMainApi('https://record.invalid', { fetcher: (async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const path = url.pathname.replace(/^\/api\/main/, '') + url.search;
      return send(path, caller === person, init);
    }) as typeof fetch });
  }
  const main = client(person);
  const [state] = await Promise.all([
    named('session-agent', () => main.v1.me['session-agent'].get()),
    named('agent-choices', () => main.v1.me.agents.get({ query: { languages: 'en' } })),
    named('acting-contexts', () => main.v1.me['acting-contexts'].get({ query: { task: 'work.create' } })),
  ]);
  const actingSubject = state.data?.sessionAgent.eligible ? state.data.sessionAgent.actingSubject : null;
  if (!actingSubject) return;
  await named('acting-agent-profile', () => main.v1.agents({ id: actingSubject.slice(-36) }).get({ query: { actingSubject } }));
  await Promise.all([
    named('reading-preferences', () => main.v1.me['person-preferences'].get({ query: { actingSubject } })),
    named('topic-choices', () => discoveryApi(main, 'en').concepts({ q: '' })),
  ]);
  const operation = randomUUID();
  const handle = `circle-${randomUUID().slice(0, 12)}`;
  const input = { profile: 'space-realm-v2' as const, language: 'en',
    name: 'Original fixture reading circle', handle, topics: [], capabilities: ['realm' as const], actingSubject,
    initialSettings: initialCommunitySettings('private', []) };
  const response = await named('creation-receipt', () => createCommunityWithReadback(input, `${operation}:create`,
    (body, key) => main.v1.spaces.post(body, { headers: { 'idempotency-key': key } })));
  // Keep the existing receipt's label and request. The form's exact private
  // intent is sampled again with its original key, producing a real replay.
  const replay = await named('form-creation', () => createCommunityWithReadback(input, `${operation}:create`,
    (body, key) => main.v1.spaces.post(body, { headers: { 'idempotency-key': key } })));
  expect(replay.response.status).toBe(200);
  expect(replay.data).toMatchObject({ replayed: true });
  const step = await named((_method, path) => path.startsWith('/v1/addresses/') ? 'founder-address' : 'founder-managed-realms',
    () => stepAfterCreation(response, handle, actingSubject, founderRealmReads(main)));
  await named('moderated-realm', () => main.v1.me['managed-realms'].get({ query: { actingSubject } }));
  if (step.step !== 'write') return;
  const realm = step.realm.slice(-36);
  const publication = { ...communityNames('en', input.name, 'Original description by the founding fixture Person.', [])!,
    iconSelection: null, bannerSelection: null, replyPolicy: 'moderated' as const,
    count: { kind: 'exact' as const, value: null }, moderators: [] };
  const saved = await named('private-profile-unavailable', () => main.v1.realms({ realm }).profile.put({
    profile: 'realm-public-profile-v2', expectedHead: null, actingSubject, publication,
  }, { headers: { 'idempotency-key': `${operation}:profile` } }));
  const problem = saved.error?.value;
  const code = problem && typeof problem === 'object' && 'code' in problem && typeof problem.code === 'string'
    ? problem.code : null;
  if (!saved.data && !profilePublicationOpensRealm(code, 'private')) return;
  // Request-local reads share one answer, as the page's React caches do.
  const held = new Map<string, Promise<Response>>();
  const landingRead = async (path: string, personal = false, init?: RequestInit) => {
    const identity = JSON.stringify([personal, init?.method ?? 'GET', path]);
    let pending = held.get(identity);
    if (!pending) { pending = send(path, personal, init); held.set(identity, pending); }
    return (await pending).clone();
  };
  const landingFetch: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const personal = init?.credentials === 'same-origin' || new Headers(init?.headers).has('authorization');
    return landingRead(url.pathname.replace(/^\/api\/main/, '') + url.search, personal, init);
  };
  const landingLabels = (_method: string, path: string) => {
    const pathname = new URL(path, 'https://record.invalid').pathname;
    if (pathname === '/v1/addresses/resolve') return 'landing-address';
    if (pathname === '/v1/me/session-agent') return 'landing-session-agent';
    if (pathname === '/v1/me/person-preferences') return 'landing-preferences';
    if (pathname === '/v1/me/platform-access') return 'landing-platform-access';
    if (pathname.startsWith('/v1/follows/')) return 'landing-follow';
    if (pathname.endsWith('/zone')) return 'landing-zone';
    if (pathname.endsWith('/joining')) return 'landing-joining';
    if (pathname.endsWith('/member-ban')) return 'landing-member-ban';
    if (pathname.endsWith('/join-page')) return 'landing-join-page';
    if (pathname.endsWith('/presentation')) return 'landing-presentation';
    return path.includes('actingSubject=') ? 'created-realm-header' : 'landing-public-header';
  };
  const view = await named(landingLabels, () => loadRealmView(realm, 'en', {}, 'community', {
    fetch: landingFetch, read: landingRead, personal: main, origin: 'https://record.invalid',
    signedIn: true, token: 'persona-transport', languages: 'en',
  }));
  if (view.kind !== 'view') return;
  const discussions = realmDiscussionReads(main, realm, actingSubject);
  await Promise.all([
    named('landing-threads', () => discussions.threads({ sort: 'best', window: 'week' })),
    named((_method, path) => path.startsWith('/v1/classification-vocabulary') ? 'landing-boards' : 'landing-boards-context',
      () => discussions.boards()),
  ]);
  // The established founder now owns three Spaces. Another form submission stops at the refusal.
  if (name === 'owner') {
    await named('creation-quota-denied', () => createCommunityWithReadback({ ...input,
      handle: `circle-${randomUUID().slice(0, 12)}` }, `${randomUUID()}:create`,
    (body, key) => main.v1.spaces.post(body, { headers: { 'idempotency-key': key } })));
  }
}
