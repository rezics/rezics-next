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
beforeAll(async () => {
  sessions = await personaSessions('private');
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

async function found(name: Exclude<PersonaName, 'visitor'>) {
  const person = sessions[name],
    input = command(person),
    key = randomUUID();
  const created = await answer<{ space: string; realm: string; owner: string; replayed: boolean }>(
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
  expect(
    await answer(person.main('GET', `${root(created.realm)}/settings?${acting(person)}`)),
  ).toMatchObject({ settings: input.initialSettings });
  expect(
    await answer(person.main('GET', `${root(created.realm)}?${acting(person)}`)),
  ).toMatchObject({ id: created.realm });
  await answer(sessions.visitor.main('GET', root(created.realm)), 404);
  await answer(
    sessions.operator.main('GET', `${root(created.realm)}?${acting(sessions.operator)}`),
    name === 'operator' ? 200 : 404,
  );
  await answer(
    person.main('GET', `${root(sessions.realm)}/settings?${acting(person)}`),
    name === 'owner' ? 200 : 403,
  );
  await answer(
    person.main('GET', `${root(sessions.realm)}?${acting(person)}`),
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
    const shared = command(person, 'public');
    const responses = await Promise.all([
      person.main('POST', '/v1/spaces', shared),
      person.main('POST', '/v1/spaces', shared),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    const winner = (await responses.find((response) => response.status === 201)!.json()) as {
      space: string;
      realm: string;
    };
    expect(
      await answer(
        sessions.visitor.main('GET', `/v1/addresses/resolve?scope=space&key=${shared.handle}`),
      ),
    ).toMatchObject({ holder: winner.space, capabilities: { realm: winner.realm } });
  }
}
outcomeTest(creation, 'stranger', () => found('stranger'));
outcomeTest(creation, 'member', () => found('member'));
outcomeTest(creation, 'owner', () => found('owner'));
outcomeTest(creation, 'moderator', () => found('moderator'));
outcomeTest(creation, 'operator', () => found('operator'));
