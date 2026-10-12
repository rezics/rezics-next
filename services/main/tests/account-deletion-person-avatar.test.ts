import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { png, sha, startMediaStack, type MediaStack } from '../../../tests/qa/integration/media-support.ts';

type Member = Awaited<ReturnType<MediaStack['member']>>;
type PersonAvatar = { member: Member; agent: string; selection: string; url: string; digest: string };

let stack: MediaStack | undefined;
let deleting: PersonAvatar;
let unrelated: PersonAvatar;

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
  const member = await current.member(`person-avatar-${randomUUID()}`, { verified: true });
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
}, 180_000);

afterAll(async () => { await stack?.stop(); });

test('known adopted Person avatar URLs deliver bytes before Account deletion', async () => {
  await available(deleting);
  await available(unrelated);
});

test('recovery-held name owner refuses known avatar delivery and recovers after release', async () => {
  const current = mediaStack();
  await current.accessPool.query('UPDATE access.recovery_fence SET open = false WHERE id');
  try {
    await json(await current.call('GET', unrelated.url), 503);
    await json(await unrelated.member.send('GET', unrelated.url), 503);
  } finally {
    await current.accessPool.query('UPDATE access.recovery_fence SET open = true WHERE id');
  }
  await available(unrelated);
});

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
