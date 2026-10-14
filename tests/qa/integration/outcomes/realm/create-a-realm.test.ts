import { afterAll, beforeAll, expect, setDefaultTimeout } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { browserMainApi } from '../../../../../apps/web/features/api/browser.ts';
import { createCommunityWithReadback, initialCommunitySettings, stepAfterCreation,
  founderRealmReads } from '../../../../../apps/web/features/communities/create-form.tsx';
import { communityNames } from '../../../../../apps/web/features/communities/name-fields.ts';
import { discoveryApi } from '../../../../../apps/web/features/discover/api.ts';
import { realmFrameReads } from '../../../../../apps/web/features/realm/zone-presentation-read.ts';
import { readMembership } from '../../../../../apps/web/features/realm/membership-state.ts';
import { operationOpen, parsePlatformAccess } from '../../../../../apps/web/features/api/platform-access.ts';
import creation from '../../../../../scripts/qa/cases/outcomes/realm/create-a-realm.ts';
import { OutcomeRecorder, outcomeTest } from '../../../support/outcome-test.ts';
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
  // /r/new offers sign-in before any Main read for the signed-out visitor.
  if (name === 'visitor') return;
  const person = name === 'owner' ? founder.person : sessions[name];
  function client(caller: PersonaSession) {
    const sample = recording.session(name, caller);
    return browserMainApi('https://record.invalid', { fetcher: (async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const path = url.pathname.replace(/^\/api\/main/, '') + url.search;
      const method = init?.method ?? 'GET';
      const label = labels.getStore();
      if (!label) throw new Error(`Unlabelled production request: ${method} ${path}`);
      const key = new Headers(init?.headers).get('idempotency-key') ?? undefined;
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined;
      return sample(typeof label === 'string' ? label : label(method, path), method, path, body, key,
        { headers: Object.fromEntries(new Headers(init?.headers).entries()), settle: false });
    }) as typeof fetch });
  }
  const main = client(person), publicMain = client(sessions.visitor);
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
    initialSettings: initialCommunitySettings('public', []) };
  const response = await named('creation-receipt', () => createCommunityWithReadback(input, `${operation}:create`,
    (body, key) => main.v1.spaces.post(body, { headers: { 'idempotency-key': key } })));
  const step = await named((_method, path) => path.startsWith('/v1/addresses/') ? 'founder-address' : 'founder-managed-realms',
    () => stepAfterCreation(response, handle, actingSubject, founderRealmReads(main)));
  if (step.step !== 'write') return;
  const realm = step.realm.slice(-36);
  const publication = { ...communityNames('en', input.name, 'An original fixture reading circle.', [])!,
    iconSelection: null, bannerSelection: null, replyPolicy: 'members-direct' as const,
    count: { kind: 'exact' as const, value: null }, moderators: [] };
  const saved = await named('published-profile', () => main.v1.realms({ realm }).profile.put({
    profile: 'realm-public-profile-v2', expectedHead: null, actingSubject, publication,
  }, { headers: { 'idempotency-key': `${operation}:profile` } }));
  if (!saved.data) return;
  const frame = realmFrameReads({ main: publicMain, personal: main, actingSubject });
  const resolved = await named((_method, path) => path.startsWith('/v1/addresses/') ? 'landing-address' : 'created-realm-header',
    () => frame.resolveRealm(realm, 'en'));
  if (resolved.kind !== 'realm') return;
  await named('landing-zone', () => frame.readRealmZone(realm));
  await Promise.all([
    named((_method, path) => path.startsWith('/v1/follows/') ? 'landing-follow' : 'landing-joining',
      () => readMembership(main, step.realm, actingSubject)),
    named('landing-platform-access', async () => {
      const access = await main.v1.me['platform-access'].get();
      if (operationOpen('getV1RealmsByRealmMember-ban', parsePlatformAccess(access.data))) {
        await named('landing-member-ban', () => main.v1.realms({ realm })['member-ban'].get({ query: { actingSubject } }));
      }
    }),
  ]);
  await named('landing-threads', () => main.v1.realms({ realm }).threads.get({ query: { sort: 'best', actingSubject } }));
  // The established founder now owns three Spaces. Another form submission stops at the refusal.
  if (name === 'owner') {
    await named('creation-quota-denied', () => createCommunityWithReadback({ ...input,
      handle: `circle-${randomUUID().slice(0, 12)}` }, `${randomUUID()}:create`,
    (body, key) => main.v1.spaces.post(body, { headers: { 'idempotency-key': key } })));
  }
}
