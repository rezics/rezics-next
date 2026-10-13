import { afterAll, beforeAll, expect, setDefaultTimeout } from 'bun:test';
import { randomUUID } from 'node:crypto';
import creation from '../../../../../scripts/qa/cases/outcomes/realm/create-a-realm.ts';
import { outcomeTest } from '../../../support/outcome-test.ts';
import {
  personaSessions,
  type PersonaName,
  type PersonaSession,
  type PersonaSessions,
} from '../../../support/personas.ts';

setDefaultTimeout(60_000);
let sessions: PersonaSessions;
let founder: { person: PersonaSession; realm: string };
let handleOwner: { person: PersonaSession; realm: string };
let quotaPerson: PersonaSession;
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
  await sessions?.close();
});

outcomeTest(creation, 'visitor', async () => {
  const input = command(sessions.owner, 'public');
  const created = await answer<{ space: string; realm: string }>(
    sessions.owner.main('POST', '/v1/spaces', input),
    201,
  );
  expect(
    await answer(
      sessions.visitor.main('GET', `/v1/addresses/resolve?scope=space&key=${input.handle}`),
    ),
  ).toMatchObject({ holder: created.space, capabilities: { realm: created.realm } });
  await answer(sessions.visitor.main('POST', '/v1/spaces', command(sessions.visitor)), 401);
  const hidden = await answer(sessions.visitor.main('GET', root(sessions.realm)), 404);
  expect(JSON.stringify(hidden)).not.toContain(sessions.realm);
});

async function found(name: Exclude<PersonaName, 'visitor'>,
  person = sessions[name], existingRealm = sessions.realm) {
  const input = command(person),
    key = randomUUID();
  const created = await answer<CreatedRealm>(
    person.main('POST', '/v1/spaces', input, key),
    201,
  );
  expect(created.owner).toBe(person.actingSubject);
  expect(created.replayed).toBe(false);
  expect(await answer(person.main('POST', '/v1/spaces', input, key))).toMatchObject({
    space: created.space,
    realm: created.realm,
    owner: person.actingSubject,
    replayed: true,
  });
  await answer(
    person.main('POST', '/v1/spaces', { ...input, name: 'Changed creation intent' }, key),
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
    person.main('GET', `${root(created.realm)}/settings?${acting(person)}`),
  );
  expect(settings.settings).toEqual(input.initialSettings);
  expect(
    await answer(person.main('GET', `${root(created.realm)}?${acting(person)}`)),
  ).toMatchObject({ id: created.realm });
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
  const receipt = await answer<CreatedRealm>(person.main('POST', '/v1/spaces', first, key), 201);
  const zone = await answer<{ space: string; owner: string }>(person.main('POST', '/v1/spaces', {
    profile: 'space-zone-v1', name: 'Original fixture reading site', language: 'en',
    capabilities: ['zone'], actingSubject: person.actingSubject,
  }), 201);
  const third = await answer<CreatedRealm>(person.main('POST', '/v1/spaces', command(person)), 201);
  expect(new Set([receipt.space, zone.space, third.space]).size).toBe(3);
  for (const created of [receipt, zone, third]) expect(created.owner).toBe(person.actingSubject);
  expect(await answer(person.main('POST', '/v1/spaces', command(person)), 403))
    .toMatchObject({ status: 403, code: 'authority_denied' });
  expect(await answer(person.main('POST', '/v1/spaces', first, key)))
    .toEqual({ ...receipt, replayed: true });
}
outcomeTest(creation, 'stranger', () => found('stranger'));
outcomeTest(creation, 'member', () => found('member'));
outcomeTest(creation, 'owner', async () => {
  await found('owner', founder.person, founder.realm);
  await concurrentHandle();
  await exhaustedAccountRecovers();
});
outcomeTest(creation, 'moderator', () => found('moderator'));
outcomeTest(creation, 'operator', () => found('operator'));
