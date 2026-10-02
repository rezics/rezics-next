import { expect, test } from 'bun:test';
import type { PublicAgentProfile } from '../features/auth/agent-profile.ts';
import { profileSaveInput, saveAgentProfile } from '../features/settings/profile-api.ts';

const agent = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
const profile: PublicAgentProfile = { id: agent, displayName: 'Ada',
  revision: 'https://rezics.com/id/00000000-0000-4000-8000-000000000002',
  bio: { text: 'Old bio', language: 'en' }, avatarSelection: null, avatarUrl: null };
const key = '00000000-0000-4000-8000-000000000003';

test('profile save preserves the read revision and trims public text', async () => {
  let request: Request | undefined;
  const send = (async (input: RequestInfo | URL, init?: RequestInit) => {
    request = new Request(input, init);
    return Response.json({ revision: 'new' }, { status: 201 });
  });
  const input = profileSaveInput(profile, { token: 'token', agent, displayName: '  Ada Writer  ',
    bioText: '  A new bio  ', bioLanguage: 'zh-Hans', removeAvatar: false, key });
  expect(await saveAgentProfile(input, send)).toBe('saved');
  expect(request?.url).toBe('http://127.0.0.1:3001/v1/agents/00000000-0000-4000-8000-000000000001/profile');
  expect(request?.headers.get('idempotency-key')).toBe(key);
  expect(await request?.json()).toEqual({ profile: 'agent-public-profile-v1', expectedHead: profile.revision,
    displayName: 'Ada Writer', bio: { text: 'A new bio', language: 'zh-Hans' }, avatarSelection: null });
});

test('avatar upload, selection and profile CAS use the same Agent in order', async () => {
  const calls: Request[] = [];
  const replies = [Response.json({ asset: 'asset-id', upload: 'upload-id' }, { status: 201 }),
    Response.json({ status: 'activated', representation: 'representation-id' }, { status: 201 }),
    Response.json({ recorded: true }, { status: 201 }),
    Response.json({ selection: 'selection-id' }, { status: 201 }),
    Response.json({ revision: 'new' }, { status: 201 })];
  const send = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(new Request(input, init));
    return replies.shift()!;
  });
  const image = new File([new Uint8Array([137, 80, 78, 71])], 'portrait.png', { type: 'image/png' });
  const input = profileSaveInput(profile, { token: 'token', agent, displayName: 'Ada',
    bioText: 'Old bio', bioLanguage: 'en', avatar: image, removeAvatar: false, key });
  expect(await saveAgentProfile(input, send)).toBe('saved');
  expect(calls.map(call => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
    'POST /v1/media/uploads', 'PUT /v1/media/uploads/upload-id/bytes',
    'POST /v1/media/representations/representation-id/inferences',
    'PUT /v1/resources/00000000-0000-4000-8000-000000000001/avatar',
    'PUT /v1/agents/00000000-0000-4000-8000-000000000001/profile',
  ]);
  expect(await calls[0]!.json()).toMatchObject({ actingSubject: agent, disclosure: 'public',
    mediaType: 'image/png' });
  expect(await calls[2]!.json()).toMatchObject({ actingSubject: agent, status: 'unavailable', result: 'unknown' });
  expect(await calls[3]!.json()).toMatchObject({ actingSubject: agent,
    expectedSelection: null, asset: 'asset-id' });
  expect(await calls[4]!.json()).toMatchObject({ expectedHead: profile.revision,
    avatarSelection: 'selection-id', bio: profile.bio });
});

test('stale profile is a conflict; oversized avatar never reaches Main', async () => {
  const stale = async () => Response.json({ code: 'stale_agent_profile' }, { status: 409 });
  const input = profileSaveInput(profile, { token: 'token', agent, displayName: 'Ada',
    bioText: '', bioLanguage: 'en', removeAvatar: false, key });
  expect(await saveAgentProfile(input, stale)).toBe('conflict');
  const tooLarge = new File([new Uint8Array(4 * 1024 * 1024 + 1)], 'huge.png', { type: 'image/png' });
  const never = async () => { throw new Error('should not send'); };
  expect(await saveAgentProfile({ ...input, avatar: tooLarge }, never)).toBe('invalid');
});

test('unavailable media stops before the profile CAS', async () => {
  let calls = 0;
  const unavailable = async () => {
    calls++;
    return Response.json({ code: 'media_unavailable' }, { status: 503 });
  };
  const avatar = new File([new Uint8Array([137, 80, 78, 71])], 'portrait.png', { type: 'image/png' });
  const input = profileSaveInput(profile, { token: 'token', agent, displayName: 'Ada',
    bioText: 'Old bio', bioLanguage: 'en', avatar, removeAvatar: false, key });
  expect(await saveAgentProfile(input, unavailable)).toBe('avatar-unavailable');
  expect(calls).toBe(1);
  const denied = async () => Response.json({ code: 'authority_denied' }, { status: 403 });
  expect(await saveAgentProfile(input, denied)).toBe('avatar-denied');
});
