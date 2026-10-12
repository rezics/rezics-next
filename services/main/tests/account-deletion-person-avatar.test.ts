import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { png, sha, startMediaStack, type MediaStack } from '../../../tests/qa/integration/media-support.ts';
import { grantFixtureAuthority } from '../src/modules/access/fixture-authority.ts';
import { engageAccessRecoveryFence, releaseAccessRecoveryFence } from '../src/modules/access/admission.ts';
import { DEFAULT_PERSON_CHOICES, PersonPreferencesStore } from '../src/modules/preferences/store.ts';

type Member = Awaited<ReturnType<MediaStack['member']>>;
type PersonAvatar = { member: Member; agent: string; selection: string; url: string; digest: string };

let stack: MediaStack | undefined;
let deleting: PersonAvatar;
let unrelated: PersonAvatar;
let privatePerson: PersonAvatar;

function mediaStack(): MediaStack {
  if (!stack) throw new Error('Person avatar fixture is not ready');
  return stack;
}

async function json<T>(response: Response, status: number): Promise<T> {
  const text = await response.text();
  expect(response.status, text).toBe(status);
  return JSON.parse(text) as T;
}

async function personAvatar(displayName: string): Promise<PersonAvatar> {
  const current = mediaStack();
  // Seed stable identities so MediaStack.member reuses Access-owned grants
  // rather than entering its legacy direct-insert grant path.
  const name = `person-avatar-${randomUUID()}`;
  const fixtureId = (key: string) => {
    const hex = sha(`rezics-fixture:${key}`);
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  };
  const principalId = fixtureId(`principal:${name}`), actor = `https://rezics.com/id/${fixtureId(`actor:${name}`)}`;
  await current.accessPool.query('INSERT INTO access.principal (id, account_issuer, account_subject) VALUES ($1,$2,$3)',
    [principalId, 'https://qa-wiki-fixture.test', name]);
  await current.accessPool.query("INSERT INTO access.authority_subject (id, kind) VALUES ($1,'agent')", [actor]);
  for (const action of ['media.upload', 'media.manage']) await grantFixtureAuthority(current.accessPool, {
    scope: `media:owner:${actor}`, requireDispatch: true,
    representations: [{ principalId, actor, action, lifetime: '8 hours' }],
    grant: { actor, action, lifetime: '8 hours' },
  });
  const member = await current.member(name, { stable: true, verified: true });
  const { agent } = await json<{ agent: string }>(await member.send('POST', '/v1/agents', {
    profile: 'agent-provision-v1', kind: 'person', displayName,
  }), 201);
  const profilePath = `/v1/agents/${agent.slice(-36)}`;
  const { revision } = await json<{ revision: string }>(await current.call('GET', profilePath), 200);
  const bytes = png(64, 64);
  const upload = await json<{ upload: string; asset: string }>(await member.send('POST', '/v1/media/uploads', {
    profile: 'media-image-upload-v1', asset: null, mediaType: 'image/png', byteLength: bytes.length,
    sha256: sha(bytes), disclosure: 'public', actingSubject: agent,
  }), 201);
  await json(await current.call('PUT', `/v1/media/uploads/${upload.upload}/bytes`, {
    token: member.token, raw: bytes,
  }), 201);
  const { selection } = await json<{ selection: string }>(await member.send('PUT',
    `/v1/resources/${agent.slice(-36)}/avatar`, {
      profile: 'resource-avatar-selection-v1', expectedSelection: null, asset: upload.asset,
      crop: null, actingSubject: agent,
    }), 201);
  await json(await member.send('PUT', `${profilePath}/profile`, {
    profile: 'agent-public-profile-v1', expectedHead: revision, displayName,
    avatarSelection: selection, bio: null,
  }), 201);
  const profile = await json<{ avatarSelection: string; avatarUrl: string }>(
    await current.call('GET', profilePath), 200);
  expect(profile.avatarSelection).toBe(selection);
  expect(profile.avatarUrl).toBe(`/v1/media/avatars/${selection}`);
  return { member, agent, selection, url: profile.avatarUrl, digest: sha(bytes) };
}

async function available(person: PersonAvatar): Promise<void> {
  const response = await mediaStack().call('GET', person.url);
  expect(response.status, await response.clone().text()).toBe(200);
  expect(sha(new Uint8Array(await response.arrayBuffer()))).toBe(person.digest);
  expect(response.headers.get('cache-control')).toContain('public');
}

beforeAll(async () => {
  stack = await startMediaStack('account-deletion-person-avatar');
  deleting = await personAvatar('Closing Person');
  unrelated = await personAvatar('Unrelated Person');
  privatePerson = await personAvatar('Private Person');
}, 180_000);

afterAll(async () => { await stack?.stop(); });

test('known adopted Person avatar URLs deliver bytes before Account deletion', async () => {
  await available(deleting);
  await available(unrelated);
});

test('recovery-held name owner refuses known avatar delivery and recovers after release', async () => {
  const current = mediaStack();
  const before = (await current.accessPool.query<{ generation: string }>(
    'SELECT generation::text FROM access.recovery_fence WHERE id')).rows[0]!.generation;
  const generation = await engageAccessRecoveryFence(current.accessPool);
  expect(BigInt(generation)).toBe(BigInt(before) + 1n);
  expect(await engageAccessRecoveryFence(current.accessPool)).toBe(generation);
  try {
    expect((await current.accessPool.query('SELECT open, generation::text FROM access.recovery_fence WHERE id')).rows)
      .toEqual([{ open: false, generation }]);
    await json(await current.call('GET', unrelated.url), 503);
    await json(await unrelated.member.send('GET', unrelated.url), 503);
  } finally {
    expect((await current.accessPool.query(`SELECT
      EXISTS (SELECT 1 FROM access.search_read_lease WHERE state = 'delivering')
      OR EXISTS (SELECT 1 FROM access.download_read_lease WHERE state = 'delivering') AS delivering`)).rows)
      .toEqual([{ delivering: false }]);
    await releaseAccessRecoveryFence(current.accessPool, generation);
  }
  expect((await current.accessPool.query('SELECT open, generation::text FROM access.recovery_fence WHERE id')).rows)
    .toEqual([{ open: true, generation: String(BigInt(generation) + 1n) }]);
  await available(unrelated);
});

async function privateName(person: PersonAvatar): Promise<void> {
  // Keep the public graph profile to exercise the independent name owner,
  // including the interval before its derived-name projection catches up.
  const preferences = new PersonPreferencesStore(mediaStack().accessPool, async () => {});
  const current = await preferences.read(person.member.principal, person.agent);
  await preferences.write(person.member.principal, person.agent,
    { ...DEFAULT_PERSON_CHOICES, profileVisibility: 'private' }, current.version, randomUUID());
}

test('controller receives a retained public-graph avatar with private name preferences only in a private cache', async () => {
  await privateName(privatePerson);
  await json(await mediaStack().call('GET', privatePerson.url), 404);
  const response = await privatePerson.member.send('GET', privatePerson.url);
  expect(response.status, await response.clone().text()).toBe(200);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(sha(new Uint8Array(await response.arrayBuffer()))).toBe(privatePerson.digest);
});

for (const change of ['private-name', 'ended-authority'] as const) {
  test(`avatar hydration rechecks ${change} before returning ${change === 'private-name' ? '304' : 'bytes'}`, async () => {
    const current = mediaStack(), person = await personAvatar(`Concurrent ${change}`);
    await available(person);
    const query = current.fuseki.query.bind(current.fuseki);
    let resume: () => void = () => {}, hydrated: () => void = () => {};
    const paused = new Promise<void>(resolve => { hydrated = resolve; });
    const released = new Promise<void>(resolve => { resume = resolve; });
    let intercepted = false;
    current.fuseki.query = async (...args) => {
      if (!intercepted && args[0].includes('SELECT ?avatar WHERE') && args[0].includes(person.agent)) {
        intercepted = true;
        hydrated();
        await released;
      }
      return query(...args);
    };
    const request = current.main.handle(new Request(`http://main.local${person.url}`, {
      headers: change === 'private-name' ? { 'if-none-match': `"${person.digest}"` } : {},
    }));
    try {
      await paused;
      if (change === 'private-name') await privateName(person);
      else await current.access.strongDeactivateAccountSubject(person.member.principal.issuer, person.member.principal.subject);
      resume();
      const response = await request;
      expect(await json(response, 404)).toMatchObject({ code: 'media_unavailable' });
      expect(response.headers.get('cache-control')).not.toContain('public');
    } finally {
      resume();
      current.fuseki.query = query;
      await request;
    }
  }, 60_000);
}

test('Account deletion ends its Person and refuses retained avatar URLs without affecting another Person', async () => {
  const current = mediaStack();
  // This is the real Account deletion fence, not a fixture-only subject edit.
  // The Person authority transition is owned by Account deletion admission.
  const fence = await current.access.strongDeactivateAccountSubject(
    deleting.member.principal.issuer, deleting.member.principal.subject);
  expect(fence).toMatchObject({ principalId: deleting.member.principalId });
  expect((await current.accessPool.query<{ active: boolean }>(
    'SELECT active FROM access.authority_subject WHERE id = $1', [deleting.agent])).rows)
    .toEqual([{ active: false }]);
  // Media and the graph profile can remain until erasure; live name disclosure
  // must independently prevent delivery of the already-known selection.
  expect(await current.media.store.avatarDelivery(deleting.selection))
    .toMatchObject({ target: deleting.agent, selection: deleting.selection });
  expect(await json(await current.call('GET', deleting.url), 404))
    .toMatchObject({ code: 'media_unavailable' });
  expect(await json(await unrelated.member.send('GET', deleting.url), 404))
    .toMatchObject({ code: 'media_unavailable' });
  await available(unrelated);
}, 60_000);
