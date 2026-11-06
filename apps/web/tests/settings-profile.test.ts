import { expect, mock, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { settingsCommandKeyHeader } from '../src/settings/command-headers';
import { loadProfileRecord, saveProfileRecord, type ProfileValues } from '../src/settings/profile-data';
import type { EditableProfile } from '../src/settings/editable-profile-source';
import { createStoryRecordedKernelFetch } from '../src/kernel/fake';
import { EditableProfileReadError, officialProfileRead } from '../src/settings/editable-profile-source';
import { ProfileEditor, ProfileEditorSession, type ProfileAttempt } from '../src/settings/profile-write';
import { MediaProblem } from '../src/media/kernel';
import { m } from '../src/paraglide/messages.js';

const account = {
  id: 'alice',
  kind: 'actor',
  handle: 'alice',
  displayName: 'Alice',
  bio: 'A short bio',
  avatar: { id: 'media-old', url: '/media/old' },
  links: [{ label: 'Home', url: 'https://example.test' }],
  publicViews: { posts: true, reviews: true, collections: true, realms: true },
  verified: false,
  subject: null,
};

function clientFor(handler: (request: Request) => Response | Promise<Response>) {
  const calls: { method: string; url: string; body: unknown; key: string | null }[] = [];
  const client = createKernelClient('https://kernel.example.test', {
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      let body: unknown = null;
      if (request.method === 'PATCH') body = await request.json();
      calls.push({
        method: request.method,
        url: new URL(request.url).pathname + new URL(request.url).search,
        body,
        key: request.headers.get('idempotency-key'),
      });
      return handler(request);
    }) as typeof fetch,
  });
  return { client, calls };
}

test('profile story responses accept the relative URL used by PageStory and include extended identity data', async () => {
  const storyGlobal = globalThis as typeof globalThis & {
    __rezicsStoryContext?: { visitor: 'Signed In' | 'Signed Out'; url: string };
  };
  const previous = storyGlobal.__rezicsStoryContext;
  storyGlobal.__rezicsStoryContext = { visitor: 'Signed In', url: '/en/settings?profile=extended' };
  try {
    const response = await createStoryRecordedKernelFetch()(
      new Request('http://kernel.local/v1/accounts?ids=story-viewer'),
    );
    const body = (await response.json()) as { accounts: Array<Record<string, unknown>> };
    expect(response.status).toBe(200);
    expect(body.accounts[0]).toMatchObject({
      id: 'story-viewer',
      kind: 'actor',
      displayName: 'Avery Reader',
      avatar: { id: 'story-avatar' },
    });
    expect(body.accounts[0]?.links).toHaveLength(5);
    expect(String(body.accounts[0]?.bio).length).toBeGreaterThan(200);
  } finally {
    if (previous === undefined) delete storyGlobal.__rezicsStoryContext;
    else storyGlobal.__rezicsStoryContext = previous;
  }
});

test('profile reads editable values once by immutable id through the authenticated private no-store endpoint', async () => {
  const nativeProfile: EditableProfile = {
    id: '019a0000-0000-7000-8000-000000000001',
    kind: 'actor',
    handle: account.handle,
    displayName: account.displayName,
    bio: account.bio,
    avatar: {
      media: account.avatar.id,
      width: 80,
      height: 80,
      placeholder: { thumbhash: 'hash', color: '#123456' },
      variants: [{ format: 'webp', width: 80 }],
      focalPoint: null,
      credit: null,
    },
    links: account.links,
    publicViews: account.publicViews,
  };
  const { client, calls } = clientFor((request) => {
    expect(request.headers.get('authorization')).toBe('Bearer page-token');
    expect(request.headers.get('cache-control')).toBe('no-store');
    expect(request.cache).toBe('no-store');
    return Response.json(officialProfileRead(nativeProfile), { headers: { 'cache-control': 'private, no-store' } });
  });
  const profile = await loadProfileRecord(client, 'Bearer page-token', nativeProfile.id);
  expect(profile).toMatchObject({
    accountId: '019a0000-0000-7000-8000-000000000001',
    kind: 'actor',
    displayName: 'Alice',
    biography: 'A short bio',
    avatar: { media: 'media-old' },
    links: [{ label: 'Home', url: 'https://example.test' }],
    publicViews: { posts: true, reviews: true, collections: true, realms: true },
  });
  expect(profile.avatar).toEqual(nativeProfile.avatar);
  expect(calls).toEqual([
    {
      method: 'GET',
      url: '/v1/accounts/019a0000-0000-7000-8000-000000000001/profile',
      body: null,
      key: null,
    },
  ]);
  expect(profile).not.toHaveProperty('speakersListed');
});

test('profile save sends only changed fields and an idempotency key, then returns the confirmed values', async () => {
  const { client, calls } = clientFor(() => Response.json({ accountId: 'alice' }));
  const before = account as unknown as ProfileValues;
  const result = await saveProfileRecord(
    client,
    'Bearer page-token',
    'alice',
    before,
    {
      ...before,
      displayName: 'Alice A.',
    },
    '123e4567-e89b-42d3-a456-426614174000',
  );
  expect(result).toMatchObject({ ok: true, profile: { displayName: 'Alice A.' } });
  expect(calls).toEqual([
    {
      method: 'PATCH',
      url: '/v1/accounts/alice',
      body: { displayName: 'Alice A.' },
      key: '"123e4567-e89b-42d3-a456-426614174000"',
    },
  ]);
});

test('profile HTTP serialization preserves the semantic key and original patch on explicit retry', async () => {
  for (const idempotencyKey of ['123e4567-e89b-42d3-a456-426614174000', '  command "quoted" \\ path  ', '123']) {
    const before = structuredClone(recoveryProfile);
    const after = Object.freeze({ ...before, biography: '  Original e\u0301\nwords  ' });
    const original = structuredClone({ before, after, idempotencyKey });
    const { client, calls } = clientFor((request) => {
      expect(request.headers.get('authorization')).toBe('Bearer page-token');
      return Response.json({ code: 'dependency_unavailable', detail: 'Original native detail' }, { status: 503 });
    });
    for (const attempt of [1, 2]) {
      expect(
        await saveProfileRecord(client, 'Bearer page-token', before.accountId, before, after, idempotencyKey),
      ).toMatchObject({ ok: false, status: 503, message: 'Original native detail' });
      expect(calls).toHaveLength(attempt);
      const sent = calls[attempt - 1]!;
      expect(sent.method).toBe('PATCH');
      expect(sent.url).toBe(`/v1/accounts/${before.accountId}`);
      expect(sent.key).toBe(settingsCommandKeyHeader(idempotencyKey));
      expect(sent.body).toEqual({ biography: '  Original e\u0301\nwords  ' });
      expect({ before, after, idempotencyKey }).toEqual(original);
    }
    expect(calls[1]!.key).toBe(calls[0]!.key);
  }
});

test('public activity patches only the switched key and links reject a sixth row before a write', async () => {
  const { client, calls } = clientFor(() => Response.json({ accountId: 'alice' }));
  await saveProfileRecord(
    client,
    'Bearer page-token',
    'alice',
    account as unknown as ProfileValues,
    { ...account, publicViews: { ...account.publicViews, posts: false } } as unknown as ProfileValues,
    '123e4567-e89b-42d3-a456-426614174000',
  );
  expect(calls[0]?.body).toEqual({ publicViews: { posts: false } });
  await expect(
    saveProfileRecord(
      client,
      'Bearer page-token',
      'alice',
      account as unknown as ProfileValues,
      {
        ...account,
        links: Array.from({ length: 6 }, (_, index) => ({
          label: `Link ${index}`,
          url: `https://example.test/${index}`,
        })),
      } as unknown as ProfileValues,
      '123e4567-e89b-42d3-a456-426614174001',
    ),
  ).rejects.toThrow();
  expect(calls).toHaveLength(1);
});

test('removing an avatar sends null and link edits are sent as the complete labelled list', async () => {
  const { client, calls } = clientFor(() => Response.json({ accountId: 'alice' }));
  const before = account as unknown as ProfileValues;
  await saveProfileRecord(
    client,
    'Bearer page-token',
    'alice',
    before,
    { ...before, avatar: null },
    '123e4567-e89b-42d3-a456-426614174000',
  );
  expect(calls[0]?.body).toEqual({ avatar: null });
  await saveProfileRecord(
    client,
    'Bearer page-token',
    'alice',
    before,
    {
      ...before,
      links: [...before.links, { label: 'Notes', url: 'https://notes.example.test' }],
    },
    '123e4567-e89b-42d3-a456-426614174001',
  );
  expect(calls[1]?.body).toEqual({
    links: [
      { label: 'Home', url: 'https://example.test' },
      { label: 'Notes', url: 'https://notes.example.test' },
    ],
  });
});

test('an organization exposes speakersListed; API refusals retain their status for the form message', async () => {
  const organization = { ...account, id: 'org', kind: 'organization', speakersListed: false };
  const { client, calls } = clientFor(() => Response.json({ accountId: 'org' }));
  const saved = await saveProfileRecord(
    client,
    'Bearer page-token',
    'org',
    organization as unknown as ProfileValues,
    { ...organization, speakersListed: true } as unknown as ProfileValues,
    '123e4567-e89b-42d3-a456-426614174000',
  );
  expect(saved).toMatchObject({ ok: true, profile: { speakersListed: true } });
  expect(calls[0]?.body).toEqual({ speakersListed: true });

  for (const status of [400, 403, 409, 422]) {
    const refused = clientFor(() =>
      Response.json({ code: `error_${status}`, detail: `refused ${status}` }, { status }),
    );
    const answer = await saveProfileRecord(
      refused.client,
      'Bearer page-token',
      'alice',
      account as unknown as ProfileValues,
      { ...account, displayName: 'Draft remains' } as unknown as ProfileValues,
      '123e4567-e89b-42d3-a456-426614174000',
    );
    expect(answer).toMatchObject({ ok: false, status });
  }
});

const recoveryProfile: ProfileValues = {
  accountId: '019a0000-0000-7000-8000-000000000001',
  kind: 'actor',
  displayName: 'Private name',
  biography: 'Private biography',
  avatar: null,
  links: [],
  publicViews: { posts: true, reviews: true, collections: true, realms: false },
};
const recoveryProblem = {
  type: 'https://rezics.com/problems/dependency_unavailable',
  title: 'Dependency Unavailable',
  status: 503,
  code: 'dependency_unavailable',
  retryable: true,
  request_id: 'native-save-request',
};

test('profile and activity failure controls honor native delay/date headers while draft review stays local', async () => {
  mock.module('cloudflare:workers', () => ({ env: {} }));
  const { ProfileCard } = await import('../src/settings/profile');
  const { PublicViewsCard } = await import('../src/settings/public-views');
  for (const scope of ['profile', 'views'] as const) {
    for (const retryAfter of [
      '60',
      new Date(Date.now() + 60_000).toUTCString(),
      'malformed',
      '-2',
      '0',
      new Date(Date.now() - 60_000).toUTCString(),
      undefined,
    ]) {
      const { client, calls } = clientFor((request) => {
        expect(request.headers.get('authorization')).toBe('Bearer page-token');
        return Response.json(recoveryProblem, {
          status: 503,
          headers: retryAfter ? { 'retry-after': retryAfter } : {},
        });
      });
      const editor = new ProfileEditor(
        {
          read: async () => recoveryProfile,
          save: (attempt) =>
            saveProfileRecord(
              client,
              'Bearer page-token',
              recoveryProfile.accountId,
              attempt.before,
              attempt.after,
              attempt.idempotencyKey,
            ),
        },
        recoveryProfile,
      );
      editor.edit(
        scope === 'profile'
          ? { biography: 'Original words' }
          : { publicViews: { ...recoveryProfile.publicViews, posts: false } },
      );
      await editor.submit(scope);
      const failure = editor.snapshot().failure;
      expect(failure).toEqual({
        status: 503,
        message: '',
        code: recoveryProblem.code,
        retryable: true,
        requestId: recoveryProblem.request_id,
        ...(retryAfter ? { retryAfter } : {}),
      });
      const attempt = editor.snapshot().attempt;
      editor.edit({ biography: 'Later words' });
      editor.review();
      expect(editor.snapshot().failure).toBe(failure);
      expect(editor.snapshot().attempt).toBe(attempt);
      const waiting = retryAfter === '60' || (retryAfter?.endsWith('GMT') && Date.parse(retryAfter) > Date.now());
      const html = renderToStaticMarkup(
        createElement('div', null, createElement(ProfileCard, { editor }), createElement(PublicViewsCard, { editor })),
      );
      const controls = [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)];
      const retryLabel = scope === 'views' ? m.settings_public_activity_retry() : m.settings_profile_retry_save();
      const reloadLabel = m.settings_profile_reload_current();
      const retry = controls.filter((control) => control[2]?.includes(retryLabel));
      const reload = controls.filter((control) => control[2]?.includes(reloadLabel));
      expect(retry).toHaveLength(1);
      expect(reload).toHaveLength(2);
      for (const control of retry) expect(/(?:^|\s)disabled(?:=|\s|$)/.test(control[1] ?? '')).toBe(!!waiting);
      for (const control of reload) expect(/(?:^|\s)disabled(?:=|\s|$)/.test(control[1] ?? '')).toBe(false);
      expect(html.includes(m.settings_retry_wait())).toBe(!!waiting);
      const review = controls.find((control) => control[2]?.includes(m.settings_profile_review_draft()));
      expect(review).toBeDefined();
      expect(/\sdisabled(?:=|\s|$)/.test(review?.[1] ?? '')).toBe(false);
      expect(editor.snapshot().draft?.biography).toBe('Later words');
      expect(calls).toHaveLength(1);
      expect(calls[0]?.body).toEqual(
        scope === 'profile' ? { biography: 'Original words' } : { publicViews: { posts: false } },
      );
      expect(calls[0]?.key).toBe(JSON.stringify(attempt?.idempotencyKey ?? 'missing original attempt'));
      editor.retire();
    }
  }
});

test('a thrown native save remains unknown and replays the immutable original while a later read failure replaces its delay', async () => {
  const sent: ProfileAttempt[] = [];
  const editor = new ProfileEditor(
    {
      read: async () => {
        throw new EditableProfileReadError(403);
      },
      save: async (attempt) => {
        sent.push(attempt);
        if (sent.length === 1) throw new MediaProblem(recoveryProblem, { 'retry-after': '0' });
        return { ok: false, status: 403, message: '' };
      },
    },
    recoveryProfile,
  );
  editor.edit({ biography: 'Original words' });
  await editor.submit('profile');
  const original = editor.snapshot().attempt;
  expect(editor.snapshot().phase).toBe('uncertain');
  expect(editor.snapshot().failure?.retryAfter).toBe('0');
  expect(editor.snapshot().failure?.requestId).toBe(recoveryProblem.request_id);
  editor.edit({ biography: 'Later words' });
  await editor.retry();
  expect(sent).toHaveLength(2);
  expect(sent[1]).toBe(original);
  expect(Object.isFrozen(original?.patch)).toBe(true);
  expect(editor.snapshot().attempt).toBe(original);
  expect(editor.snapshot().phase).toBe('uncertain');
  expect(editor.snapshot().draft?.biography).toBe('Later words');
  expect(editor.snapshot().failure?.retryAfter).toBeUndefined();
  editor.unavailable(new EditableProfileReadError(503, { status: 503, retryAfter: '0' }));
  await editor.reload();
  expect(editor.snapshot().failure).toEqual({ status: 403, message: '' });
  expect(editor.snapshot().readAuthority).toBe('denied');
  expect(editor.snapshot().attempt).toBe(original);
  editor.receive({ ...recoveryProfile, biography: 'Stale cached value' });
  expect(editor.snapshot().draft?.biography).toBe('Later words');
  editor.unavailable(new Error('Retry-After: 100'));
  expect(editor.snapshot().failure).toBeUndefined();
  editor.retire();
});

test('viewer disposal removes failure metadata and ignores a late native problem without delaying the new viewer', async () => {
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const owner = new ProfileEditorSession(
    { state: 'signed-in', subject: recoveryProfile.accountId, csrfToken: 'old' },
    () => ({
      read: async () => recoveryProfile,
      save: async () => {
        await pending;
        throw new MediaProblem(recoveryProblem, { 'retry-after': '120' });
      },
    }),
  );
  owner.editor.receive(recoveryProfile);
  owner.editor.unavailable(new EditableProfileReadError(503, { status: 503, retryAfter: '60' }));
  owner.editor.review();
  owner.editor.edit({ biography: 'Old viewer draft' });
  const completing = owner.editor.submit('profile');
  owner.retire();
  finish();
  await completing;
  expect(owner.editor.snapshot().known).toBeNull();
  expect(owner.editor.snapshot().draft).toBeNull();
  expect(owner.editor.snapshot().attempt).toBeNull();
  expect(owner.editor.snapshot().failure).toBeUndefined();
  const next = new ProfileEditorSession({ state: 'signed-in', subject: 'another-viewer', csrfToken: 'new' }, () => ({
    read: async () => {
      throw new EditableProfileReadError(503);
    },
    save: async () => {
      throw new Error('Must not write');
    },
  }));
  await next.editor.reload();
  expect(next.editor.snapshot().failure).toEqual({ status: 503, message: '' });
  expect(next.editor.snapshot().draft).toBeNull();
  next.retire();
});
