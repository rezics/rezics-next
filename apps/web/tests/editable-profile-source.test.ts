import { editableProfile } from './factories/profile';
import { expect, mock, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import {
  closedProfileEditing,
  EditableProfileReadError,
  officialProfileRead,
} from '../src/settings/editable-profile-source';
import {
  loadProfileRecord,
  profileReadResult,
  profileReadSetupFailure,
  profileReadValue,
  runReadProfile,
  runSaveProfile,
  saveProfileRecord,
  serializeProfileResult,
  type ProfileValues,
} from '../src/settings/profile-data';
import { ProfileEditor } from '../src/settings/profile-write';
import { MediaProblem } from '../src/media/kernel';

const profile = editableProfile();
const editing = {
  viewer: { accountId: profile.id },
  target: { accountId: profile.id, kind: 'actor' as const },
  fields: {
    displayName: { applicable: true as const, maxLength: 4096 as const },
    biography: { applicable: true as const, maxLength: 4096 as const },
    avatar: { applicable: true as const },
    links: {
      applicable: true as const,
      maxItems: 5 as const,
      labelMaxLength: 64 as const,
      urlMaxLength: 2048 as const,
    },
    publicViews: { applicable: true as const, flags: ['posts', 'reviews', 'collections', 'realms'] as const },
  },
};

test('the editable source accepts additive envelope fields but rejects malformed profile and advice identities', async () => {
  const { bio, ...incomplete } = profile;
  for (const body of [
    { profile },
    { profile: incomplete, editing },
    { profile: { ...profile, id: 'another-account' }, editing },
    { profile: { ...profile, state: 'deleted' }, editing },
    { profile: { ...profile, bio: 'x'.repeat(4097) }, editing },
    { profile: { ...profile, links: [{ label: 'x'.repeat(65), url: 'https://example.test' }] }, editing },
    { profile: { ...profile, links: [{ label: 'Home', url: `https://example.test/${'x'.repeat(2049)}` }] }, editing },
    { profile: { ...profile, publicViews: { posts: false } }, editing },
    { profile: { ...profile, avatar: { media: 'incomplete-avatar' } }, editing },
    {
      profile: {
        ...profile,
        avatar: {
          media: profile.id,
          width: 1,
          height: 1,
          placeholder: { thumbhash: 'hash', color: '#ffffff' },
          variants: Array.from({ length: 13 }, () => ({ format: 'webp' as const, width: 1 })),
          focalPoint: null,
          credit: null,
        },
      },
      editing,
    },
    { profile: { ...profile, kind: 'organization' }, editing },
    { profile, editing: closedProfileEditing({ id: profile.id, kind: 'organization' }) },
    { profile, editing: { ...editing, viewer: { accountId: 'another-account' } } },
    { profile, editing: { ...editing, target: { ...editing.target, accountId: 'another-account' } } },
    {
      profile,
      editing: { ...editing, fields: { ...editing.fields, links: { ...editing.fields.links, maxItems: 500 } } },
    },
    { profile, editing: { ...editing, fields: { ...editing.fields, extra: true } } },
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

  const client = createKernelClient('https://kernel.example.test', {
    fetch: (async () => Response.json({ profile, editing, permissions: { save: true } })) as typeof fetch,
  });
  const accepted = await loadProfileRecord(client, 'Bearer unchanged', profile.id);
  expect(accepted).toMatchObject({ accountId: profile.id, editing });
  expect(accepted).not.toHaveProperty('permissions');

  const unicodeLinks = [{ label: '😀'.repeat(64), url: 'https://example.test' }];
  const unicodeClient = createKernelClient('https://kernel.example.test', {
    fetch: (async () => Response.json({ profile: { ...profile, links: unicodeLinks }, editing })) as typeof fetch,
  });
  expect((await loadProfileRecord(unicodeClient, 'Bearer unchanged', profile.id)).links).toEqual(unicodeLinks);

  const advice = {
    ...editing,
    fields: { ...editing.fields, displayName: { ...editing.fields.displayName, applicable: false } },
  };
  const disabledClient = createKernelClient('https://kernel.example.test', {
    fetch: (async () => Response.json({ profile, editing: advice })) as typeof fetch,
  });
  expect((await loadProfileRecord(disabledClient, 'Bearer unchanged', profile.id)).editing?.fields.displayName).toEqual(
    { applicable: false, maxLength: 4096 },
  );
});

test('the official private GET supplies field advice and keeps unsupported local choices review-only', async () => {
  const client = createKernelClient('https://kernel.example.test', {
    fetch: (async () =>
      Response.json(officialProfileRead(profile), {
        headers: { 'cache-control': 'private, no-store' },
      })) as typeof fetch,
  });
  const editor = new ProfileEditor({
    read: () => loadProfileRecord(client, 'Bearer unchanged', profile.id),
    save: async () => {
      throw new Error('Must not write');
    },
  });
  await editor.reload();
  expect(editor.snapshot().known?.displayName).toBe('Native name');
  expect(editor.snapshot().editing).toEqual(closedProfileEditing(profile, profile.id));
  editor.edit({ speakersListed: true });
  await editor.submit('profile');
  expect(editor.snapshot().attempt).toBeNull();
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
    const editor = new ProfileEditor({
      read: async () => profileReadValue(result),
      save: async () => {
        throw new Error('Must not write');
      },
    });
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

test('thrown setup yields a serializable unavailable result rather than an escaped transport failure', async () => {
  const leaked = 'private-setup-token';
  const headers: string[] = [];
  mock.module('@tanstack/react-start/server', () => ({
    getRequest() {
      throw new Error(leaked);
    },
    setResponseHeader(name: string, value: string) {
      headers.push(`${name}: ${value}`);
    },
  }));
  mock.module('cloudflare:workers', () => ({ env: {} }));
  const setup = serializeProfileResult(profileReadSetupFailure(new Error(leaked)));
  expect(setup).toEqual({ ok: false, status: 503 });
  expect(JSON.stringify(setup)).not.toContain(leaked);
  const read = JSON.parse(JSON.stringify(await runReadProfile()));
  expect(read).toEqual(setup);
  expect(JSON.stringify(read)).not.toContain(leaked);
  const write = JSON.parse(
    JSON.stringify(
      await runSaveProfile({
        before: {
          accountId: profile.id,
          kind: 'actor',
          displayName: null,
          biography: null,
          avatar: null,
          links: [],
          publicViews: profile.publicViews,
        },
        after: {
          accountId: profile.id,
          kind: 'actor',
          displayName: 'Later',
          biography: null,
          avatar: null,
          links: [],
          publicViews: profile.publicViews,
        },
        idempotencyKey: '123e4567-e89b-42d3-a456-426614174000',
      }),
    ),
  );
  expect(write).toEqual({ ok: false, status: 503, message: '' });
  expect(JSON.stringify(write)).not.toContain(leaked);
  expect(headers).toEqual(['cache-control: private, no-store', 'cache-control: private, no-store']);
});

test('a PATCH without the matching account acknowledgement keeps the original unresolved', async () => {
  const before: ProfileValues = {
    accountId: profile.id,
    kind: 'actor',
    displayName: 'Native name',
    biography: 'Native notes',
    avatar: null,
    links: [],
    publicViews: profile.publicViews,
  };
  for (const body of [{}, { accountId: 'another-account' }, { accountId: profile.id, extra: true }, before]) {
    const result = await saveProfileRecord(
      createKernelClient('https://kernel.example.test', {
        fetch: (async (input, init) => {
          const request = new Request(input, init);
          expect(request.method).toBe('PATCH');
          expect(request.headers.get('cache-control')).toBe('no-store');
          expect(request.cache).toBe('no-store');
          return Response.json(body);
        }) as typeof fetch,
      }),
      'Bearer unchanged',
      profile.id,
      before,
      { ...before, displayName: 'Submitted name' },
      '123e4567-e89b-42d3-a456-426614174000',
    );
    expect(result).toEqual({ ok: false, status: 503, message: '' });
  }
  const acknowledged = await saveProfileRecord(
    createKernelClient('https://kernel.example.test', {
      fetch: (async () => Response.json({ accountId: profile.id })) as typeof fetch,
    }),
    'Bearer unchanged',
    profile.id,
    before,
    { ...before, displayName: 'Submitted name' },
    '123e4567-e89b-42d3-a456-426614174000',
  );
  expect(acknowledged).toEqual({ ok: true, profile: { ...before, displayName: 'Submitted name' } });
});

test('native applicability and each public-view flag gate complete patches without granting missing advice', async () => {
  const { profilePatchAdmitted, profileFieldAdmitted } = await import('../src/settings/profile-data');
  const advice = closedProfileEditing(profile);
  advice.fields.displayName.applicable = false;
  advice.fields.publicViews.flags = ['posts'];
  expect(profileFieldAdmitted('displayName', advice)).toBe(false);
  expect(profileFieldAdmitted('biography', advice)).toBe(true);
  expect(profilePatchAdmitted({ displayName: 'Unadmitted' }, advice)).toBe(false);
  expect(profilePatchAdmitted({ biography: 'Admitted' }, advice)).toBe(true);
  expect(profilePatchAdmitted({ publicViews: { posts: true } }, advice)).toBe(true);
  expect(profilePatchAdmitted({ publicViews: { posts: true, reviews: false } }, advice)).toBe(false);
  expect(profilePatchAdmitted({ speakersListed: true }, advice)).toBe(false);
  expect(profilePatchAdmitted({ displayName: 'Unavailable' }, null)).toBe(false);
  advice.fields.publicViews.applicable = false;
  expect(profilePatchAdmitted({ publicViews: { posts: true } }, advice)).toBe(false);
  let writes = 0;
  const editor = new ProfileEditor({
    read: async () => ({
      accountId: profile.id,
      kind: 'actor',
      displayName: profile.displayName,
      biography: profile.bio,
      avatar: profile.avatar,
      links: profile.links,
      publicViews: profile.publicViews,
      editing: advice,
    }),
    save: async () => {
      writes++;
      throw new Error('Unadmitted patch');
    },
  });
  await editor.reload();
  editor.edit({ displayName: 'Keep for review' });
  await editor.submit('profile');
  expect(editor.snapshot()).toMatchObject({
    phase: 'review',
    attempt: null,
    draft: { displayName: 'Keep for review' },
  });
  expect(writes).toBe(0);
});
