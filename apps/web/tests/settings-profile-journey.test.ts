import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { loadProfileRecord, saveProfileRecord, type ProfileValues } from '../src/settings/profile-data';
import {
  ProfileEditor,
  profileFieldErrors,
  type ProfileAttempt,
  type ProfileEditorIO,
} from '../src/settings/profile-write';
import { parseProfileWrite } from '../src/settings/profile-write-input';

function initial(): ProfileValues {
  return {
    accountId: '019a0000-0000-7000-8000-000000000001',
    kind: 'actor',
    displayName: 'Avery',
    biography: 'Reading notes',
    avatar: {
      media: '019a0000-0000-7000-8000-000000000002',
      width: 80,
      height: 80,
      placeholder: { thumbhash: 'hash', color: '#123456' },
      variants: [{ format: 'webp', width: 240 }],
      focalPoint: null,
      credit: null,
    },
    links: [{ label: 'Home', url: 'https://example.test' }],
    publicViews: { posts: true, reviews: true, collections: true, realms: false },
  };
}
function api(options: { handleless?: boolean; unavailable?: boolean; compactHandle?: boolean } = {}) {
  let current = initial();
  const writes: { patch: object; key: string | null }[] = [];
  const reads: string[] = [];
  const client = createKernelClient('https://kernel.example.test', {
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      expect(request.headers.get('authorization')).toBe('Bearer self');
      if (request.method === 'PATCH') {
        const patch = (await request.json()) as {
          displayName?: string | null;
          biography?: string | null;
          avatar?: string | null;
          links?: ProfileValues['links'];
          publicViews?: Partial<ProfileValues['publicViews']>;
          speakersListed?: boolean;
        };
        writes.push({ patch, key: request.headers.get('idempotency-key') });
        current = {
          ...current,
          ...patch,
          avatar: patch.avatar === undefined ? current.avatar : patch.avatar === null ? null : { media: patch.avatar },
          publicViews: { ...current.publicViews, ...patch.publicViews },
        };
        return Response.json({ accountId: current.accountId });
      }
      reads.push(new URL(request.url).search);
      if (options.unavailable) return Response.json({ code: 'dependency_unavailable' }, { status: 503 });
      const identity = {
        id: current.accountId,
        kind: current.kind,
        state: 'active',
        displayName: current.displayName,
        handle: options.handleless ? null : 'avery',
        automated: false,
        operatorId: null,
      };
      return Response.json({
        accounts: [
          new URL(request.url).searchParams.has('ids') || options.compactHandle
            ? identity
            : {
                ...identity,
                bio: current.biography,
                avatar: current.avatar,
                links: current.links,
                publicViews: current.publicViews,
                verified: false,
                subject: null,
              },
        ],
        next: null,
      });
    }) as typeof fetch,
  });
  const io: ProfileEditorIO = {
    read: () => loadProfileRecord(client, 'Bearer self', initial().accountId),
    save: (attempt) =>
      saveProfileRecord(
        client,
        'Bearer self',
        initial().accountId,
        attempt.before,
        attempt.after,
        attempt.idempotencyKey,
      ),
  };
  return { io, writes, reads, current: () => current };
}

test('An account edits its profile and public-view controls using the real self profile API and reloads confirmed values', async () => {
  const boundary = api();
  const editor = new ProfileEditor(boundary.io);
  await editor.reload();
  expect(editor.snapshot().known?.avatar).toEqual(initial().avatar);
  editor.edit({
    displayName: 'Avery Reader',
    biography: 'New notes',
    links: [{ label: 'Notes', url: 'https://notes.example.test' }],
  });
  await editor.submit('profile');
  expect(editor.snapshot().phase).toBe('saved');
  expect(boundary.writes[0]?.patch).toEqual({
    displayName: 'Avery Reader',
    biography: 'New notes',
    links: [{ label: 'Notes', url: 'https://notes.example.test' }],
  });
  editor.edit({ publicViews: { ...editor.snapshot().draft!.publicViews, posts: false } });
  await editor.submit('views');
  expect(boundary.writes[1]?.patch).toEqual({ publicViews: { posts: false } });
  await editor.reload();
  expect(editor.snapshot().known).toEqual(boundary.current());
  expect(editor.snapshot().draft?.publicViews).toEqual({
    posts: false,
    reviews: true,
    collections: true,
    realms: false,
  });
  expect(editor.snapshot().draft?.displayName).toBe('Avery Reader');
});

test('A lost save response retries the exact original payload and key while retaining a separately edited draft', async () => {
  const boundary = api();
  const attempts: ProfileAttempt[] = [];
  let lose = true;
  const editor = new ProfileEditor(
    {
      ...boundary.io,
      save: async (attempt) => {
        attempts.push(attempt);
        const result = await boundary.io.save(attempt);
        if (lose) {
          lose = false;
          throw new Error('Response lost');
        }
        return result;
      },
    },
    initial(),
  );
  editor.edit({ displayName: 'Submitted name' });
  await editor.submit('profile');
  expect(editor.snapshot().phase).toBe('uncertain');
  const original = editor.snapshot().attempt;
  expect(Object.isFrozen(original)).toBe(true);
  expect(Object.isFrozen(original?.after.links)).toBe(true);
  editor.edit({ displayName: 'Later draft', biography: 'Keep this separate' });
  await editor.submit('profile');
  expect(attempts).toHaveLength(1);
  await editor.retry();
  expect(attempts).toHaveLength(2);
  expect(attempts[1]).toBe(attempts[0]);
  expect(boundary.writes[1]).toEqual(boundary.writes[0]);
  expect(editor.snapshot().known?.displayName).toBe('Submitted name');
  expect(editor.snapshot().draft?.displayName).toBe('Later draft');
  expect(editor.snapshot().draft?.biography).toBe('Keep this separate');
  expect(editor.snapshot().attempt).toBeNull();
  expect(editor.snapshot().phase).toBe('review');
});

test('An unavailable or handleless account is never shown as a fabricated empty editable profile', async () => {
  for (const options of [{ handleless: true }, { unavailable: true }, { compactHandle: true }]) {
    const boundary = api(options);
    const editor = new ProfileEditor(boundary.io);
    await editor.reload();
    expect(editor.snapshot().phase).toBe('unavailable');
    expect(editor.snapshot().draft).toBeNull();
    expect(editor.snapshot().known).toBeNull();
    await editor.submit('profile');
    expect(boundary.writes).toHaveLength(0);
    if ('handleless' in options) expect(boundary.reads).toHaveLength(1);
  }
});

test('a successful activity write shares readback without submitting or discarding profile drafts', async () => {
  const boundary = api();
  const confirmed: ProfileValues[] = [];
  const editor = new ProfileEditor({ ...boundary.io, confirmed: (current) => confirmed.push(current) }, initial());
  editor.edit({ displayName: 'Unsaved name' });
  editor.edit({ publicViews: { ...initial().publicViews, reviews: false } });
  await editor.submit('views');
  expect(boundary.writes[0]?.patch).toEqual({ publicViews: { reviews: false } });
  expect(editor.snapshot().draft?.displayName).toBe('Unsaved name');
  expect(confirmed[0]?.displayName).toBe('Avery');
  await editor.submit('profile');
  expect(boundary.writes[1]?.patch).toEqual({ displayName: 'Unsaved name' });
  expect(editor.snapshot().known?.publicViews.reviews).toBe(false);
});

test('a receipt never claims success when current readback differs or is unavailable', async () => {
  for (const unreadable of [false, true]) {
    const editor = new ProfileEditor(
      {
        save: async (attempt) => ({ ok: true, profile: attempt.after }),
        read: async () => {
          if (unreadable) throw new Error('Read unavailable');
          return { ...initial(), displayName: 'Another device' };
        },
      },
      initial(),
    );
    editor.edit({ displayName: 'Intended name' });
    await editor.submit('profile');
    expect(editor.snapshot().phase).toBe(unreadable ? 'uncertain' : 'review');
    expect(editor.snapshot().draft?.displayName).toBe('Intended name');
    expect(!!editor.snapshot().attempt).toBe(unreadable);
  }
});

test('refusals preserve drafts and unresolved reloads preserve the original attempt', async () => {
  const editor = new ProfileEditor(
    {
      save: async () => ({ ok: false, status: 403, message: 'Denied' }),
      read: async () => initial(),
    },
    initial(),
  );
  editor.edit({ biography: 'Keep my work' });
  await editor.submit('profile');
  expect(editor.snapshot().phase).toBe('refused');
  await editor.reload();
  expect(editor.snapshot().draft?.biography).toBe('Keep my work');
  const lost = new ProfileEditor(
    {
      save: async () => {
        throw new Error('Lost');
      },
      read: async () => initial(),
    },
    initial(),
  );
  lost.edit({ displayName: 'Uncertain' });
  await lost.submit('profile');
  const attempt = lost.snapshot().attempt;
  await lost.reload();
  expect(lost.snapshot().attempt).toBe(attempt);
  expect(lost.snapshot().phase).toBe('uncertain');
});

test('pending writes prevent concurrent duplicate submission and later edits clear success', async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const editor = new ProfileEditor(
    {
      save: async (attempt) => {
        calls++;
        await pending;
        return { ok: true, profile: attempt.after };
      },
      read: async () => ({ ...initial(), displayName: 'Saved' }),
    },
    initial(),
  );
  editor.edit({ displayName: 'Saved' });
  const saving = editor.submit('profile');
  await editor.submit('profile');
  await editor.submit('views');
  await editor.retry();
  expect(calls).toBe(1);
  expect(editor.snapshot().phase).toBe('saving');
  release();
  await saving;
  expect(editor.snapshot().phase).toBe('saved');
  editor.edit({ biography: 'New draft' });
  expect(editor.snapshot().phase).toBe('idle');
});

test('field validation matches Accounts limits and refuses credentialed, insecure or malformed links', () => {
  const profile = initial();
  expect(profileFieldErrors({ ...profile, displayName: 'x'.repeat(4096), biography: 'x'.repeat(4096) })).toEqual({});
  expect(profileFieldErrors({ ...profile, displayName: 'x'.repeat(4097) })).toHaveProperty('displayName');
  expect(profileFieldErrors({ ...profile, links: [{ label: '😀'.repeat(64), url: 'https://example.test' }] })).toEqual(
    {},
  );
  for (const url of [
    'http://example.test',
    'https://user:password@example.test',
    'https://example.test/a b',
    'https:///example.test',
  ])
    expect(profileFieldErrors({ ...profile, links: [{ label: 'Home', url }] })).toHaveProperty('url-0');
  expect(
    profileFieldErrors({ ...profile, links: [{ label: 'x'.repeat(65), url: 'https://example.test' }] }),
  ).toHaveProperty('label-0');
  expect(() => parseProfileWrite({ before: profile, after: {}, idempotencyKey: crypto.randomUUID() })).toThrow();
});

test('organization-only speaker listing and native avatar references use the ordinary patch boundary', async () => {
  const boundary = api();
  const before = { ...initial(), kind: 'organization' as const, speakersListed: false };
  await saveProfileRecord(
    createKernelClient('https://kernel.example.test', {
      fetch: (async (input, init) => {
        const request = new Request(input, init);
        expect(await request.json()).toEqual({ avatar: null, speakersListed: true });
        return Response.json({ accountId: before.accountId });
      }) as typeof fetch,
    }),
    'Bearer self',
    before.accountId,
    before,
    { ...before, avatar: null, speakersListed: true },
    crypto.randomUUID(),
  );
  const editor = new ProfileEditor(boundary.io, initial());
  expect(() => editor.receive({ ...initial(), accountId: 'different-account' })).toThrow('Profile account changed');
});
