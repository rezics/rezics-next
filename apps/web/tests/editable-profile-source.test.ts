import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { EditableProfileReadError, type EditableProfile } from '../src/settings/editable-profile-source';
import {
  loadProfileRecord,
  profileReadResult,
  profileReadValue,
  type ProfileValues,
} from '../src/settings/profile-data';
import { ProfileEditor } from '../src/settings/profile-write';
import { MediaProblem } from '../src/media/kernel';

const profile: EditableProfile = {
  id: '019a0000-0000-7000-8000-000000000001',
  kind: 'actor',
  handle: null,
  displayName: 'Native name',
  bio: 'Native notes',
  links: [],
  avatar: null,
  publicViews: { posts: false, reviews: true, collections: false, realms: true },
};

test('the editable source rejects incomplete, foreign and non-closed native bodies without a draft or write', async () => {
  const { bio, ...incomplete } = profile;
  for (const body of [
    { profile: incomplete },
    { profile: { ...profile, id: 'another-account' } },
    { profile: { ...profile, state: 'deleted' } },
    { profile: { ...profile, publicViews: { posts: false } } },
    { profile: { ...profile, avatar: { media: 'incomplete-avatar' } } },
    { profile: { ...profile, kind: 'organization' } },
    { profile, accounts: [] },
    { accounts: [{ id: profile.id, handle: null }] },
  ]) {
    let writes = 0;
    const client = createKernelClient('https://kernel.example.test', {
      fetch: (async (input, init) => {
        const request = new Request(input, init);
        expect(request.method).toBe('GET');
        expect(new URL(request.url).pathname).toBe(`/v1/accounts/${profile.id}/profile`);
        expect(new URL(request.url).search).toBe('');
        expect(request.headers.get('authorization')).toBe('Bearer unchanged');
        expect(request.cache).toBe('no-store');
        return Response.json(body, { headers: { 'cache-control': 'private, no-store' } });
      }) as typeof fetch,
    });
    const editor = new ProfileEditor({
      read: () => loadProfileRecord(client, 'Bearer unchanged', profile.id),
      save: async () => {
        writes++;
        return { ok: false, status: 403, message: 'Forbidden' };
      },
    });
    await editor.reload();
    expect(editor.snapshot().phase).toBe('unavailable');
    expect(editor.snapshot().known).toBeNull();
    expect(editor.snapshot().draft).toBeNull();
    await editor.submit('profile');
    expect(writes).toBe(0);
  }
});

test('native denial status survives the server boundary while transport failures retain the same-actor draft', async () => {
  const { id: accountId, handle, bio: biography, ...fields } = profile;
  const initial: ProfileValues = { accountId, biography, ...fields };
  for (const status of [401, 403, 404, 503]) {
    const client = createKernelClient('https://kernel.example.test', {
      fetch: (async () =>
        Response.json({ code: status === 503 ? 'dependency_unavailable' : 'forbidden' }, { status })) as typeof fetch,
    });
    const result = await profileReadResult(() => loadProfileRecord(client, 'Bearer unchanged', profile.id));
    expect(result).toEqual({ ok: false, status });
    expect(() => profileReadValue(result)).toThrow(EditableProfileReadError);
    const editor = new ProfileEditor(
      {
        read: async () => profileReadValue(JSON.parse(JSON.stringify(result))),
        save: async () => {
          throw new Error('Must not write');
        },
      },
      initial,
    );
    editor.edit({ biography: 'Local words' });
    const draft = editor.snapshot().draft;
    await editor.reload();
    expect(editor.snapshot().known).toBe(initial);
    expect(editor.snapshot().draft).toBe(draft);
    expect(editor.snapshot().readAuthority).toBe(status === 503 ? 'allowed' : 'denied');
    expect(editor.snapshot().phase).toBe('unavailable');
    editor.review();
    expect(editor.snapshot().phase).toBe(status === 503 ? 'idle' : 'unavailable');
  }
  const transportFailure = new Error('Connection interrupted');
  await expect(
    profileReadResult(async () => {
      throw transportFailure;
    }),
  ).rejects.toBe(transportFailure);
});

test('private profile recovery preserves actual native problem metadata and delay/date headers through serialization', async () => {
  for (const retryAfter of ['7', new Date(Date.now() + 60_000).toUTCString(), 'invalid', undefined]) {
    const problem = {
      type: 'https://rezics.com/problems/dependency_unavailable',
      title: 'Dependency Unavailable',
      status: 503,
      code: 'dependency_unavailable',
      retryable: true,
      request_id: 'native-read-request',
    };
    const requests: Request[] = [];
    const client = createKernelClient('https://kernel.example.test', {
      fetch: (async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        expect(request.method).toBe('GET');
        expect(new URL(request.url).pathname).toBe(`/v1/accounts/${profile.id}/profile`);
        expect(new URL(request.url).search).toBe('');
        expect(request.headers.get('authorization')).toBe('Bearer unchanged');
        expect(request.headers.get('cache-control')).toBe('no-store');
        expect(request.cache).toBe('no-store');
        return Response.json(problem, { status: 503, headers: retryAfter ? { 'retry-after': retryAfter } : {} });
      }) as typeof fetch,
    });
    const result = JSON.parse(
      JSON.stringify(await profileReadResult(() => loadProfileRecord(client, 'Bearer unchanged', profile.id))),
    );
    expect(result).toEqual({
      ok: false,
      status: 503,
      failure: {
        status: 503,
        code: problem.code,
        retryable: true,
        requestId: problem.request_id,
        ...(retryAfter ? { retryAfter } : {}),
      },
    });
    const editor = new ProfileEditor({ read: async () => profileReadValue(result), save: async () => {
      throw new Error('Must not write');
    } });
    await editor.reload();
    expect(editor.snapshot().failure).toEqual({ ...result.failure, message: '' });
    expect(editor.snapshot().draft).toBeNull();
    expect(requests).toHaveLength(1);

    // An alternate private source can already throw the shared native problem wrapper.
    const wrapped = await profileReadResult(async () => {
      throw new MediaProblem(problem, retryAfter ? { 'retry-after': retryAfter } : undefined);
    });
    expect(wrapped).toEqual(result);
  }
});
