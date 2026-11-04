import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { loadProfileRecord, saveProfileRecord, type ProfileValues } from '../src/settings/profile-data';
import { EditableProfileReadError } from '../src/settings/editable-profile-source';
import {
  ProfileEditor,
  profileFieldErrors,
  type ProfileAttempt,
  type ProfileEditorIO,
} from '../src/settings/profile-write';
import { parseProfileWrite } from '../src/settings/profile-write-input';
import { profileNeedsNavigationDecision } from '../src/settings/profile-navigation';

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
      variants: [{ format: 'webp', width: 80 }],
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
      const url = new URL(request.url);
      expect(url.pathname).toBe(`/v1/accounts/${current.accountId}/profile`);
      expect(url.search).toBe('');
      reads.push(url.pathname);
      if (options.unavailable) return Response.json({ code: 'dependency_unavailable' }, { status: 503 });
      const identity = {
        id: current.accountId,
        kind: current.kind,
        displayName: current.displayName,
        handle: options.handleless ? null : 'avery',
      };
      return Response.json(
        options.compactHandle
          ? { accounts: [identity], next: null }
          : {
              profile: {
                ...identity,
                bio: current.biography,
                avatar: current.avatar,
                links: current.links,
                publicViews: current.publicViews,
              },
            },
        { headers: { 'cache-control': 'private, no-store' } },
      );
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
    if ('handleless' in options) {
      expect(boundary.reads).toEqual([`/v1/accounts/${initial().accountId}/profile`]);
      expect(editor.snapshot().known).toEqual(initial());
      expect(editor.snapshot().draft).toEqual(initial());
      editor.edit({ displayName: 'Handleless reader', biography: 'Updated native notes' });
      await editor.submit('profile');
      expect(editor.snapshot().phase).toBe('saved');
      expect(boundary.writes[0]?.patch).toEqual({
        displayName: 'Handleless reader',
        biography: 'Updated native notes',
      });
      expect(editor.snapshot().known).toEqual(boundary.current());
      continue;
    }
    expect(editor.snapshot().phase).toBe('unavailable');
    expect(editor.snapshot().draft).toBeNull();
    expect(editor.snapshot().known).toBeNull();
    await editor.submit('profile');
    expect(boundary.writes).toHaveLength(0);
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

test('late save, retry and reload readbacks retain a newer edit that restores the original value', async () => {
  for (const recovery of ['save', 'retry', 'reload'] as const) {
    let release!: (value: ProfileValues) => void;
    const readback = new Promise<ProfileValues>((resolve) => {
      release = resolve;
    });
    const attempts: ProfileAttempt[] = [];
    const editor = new ProfileEditor(
      {
        read: () => readback,
        save: async (attempt) => {
          attempts.push(attempt);
          if (recovery === 'retry' && attempts.length === 1) throw new Error('Response lost');
          return { ok: true, profile: attempt.after };
        },
      },
      initial(),
    );
    editor.edit({ displayName: 'Submitted name' });
    if (recovery === 'retry') await editor.submit('profile');
    const completing =
      recovery === 'reload' ? editor.reload() : recovery === 'retry' ? editor.retry() : editor.submit('profile');
    editor.edit({ displayName: initial().displayName });
    release({ ...initial(), displayName: 'Another device', biography: 'Current remote biography' });
    await completing;
    expect(editor.snapshot().draft?.displayName).toBe(initial().displayName);
    expect(editor.snapshot().draft?.biography).toBe('Current remote biography');
    if (recovery === 'retry') expect(attempts[1]).toBe(attempts[0]);
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
  expect(editor.snapshot().commandRetryAt).toBe(0);
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

test('Profile Retry-After deadlines stay independent and captured actions wait for expiry', async () => {
  const originalNow = Date.now;
  let now = 1_700_000_000_000;
  Date.now = () => now;
  try {
    const attempts: ProfileAttempt[] = [];
    let reads = 0;
    const editor = new ProfileEditor({
      save: async (attempt) => {
        attempts.push(attempt);
        return attempts.length === 1
          ? { ok: false, status: 503, message: 'Unavailable', failure: { status: 503, retryAfter: '120' } }
          : attempts.length === 3
            ? { ok: false, status: 429, message: 'Wait', failure: { status: 429, retryAfter: '30' } }
            : { ok: true, profile: attempt.after };
      },
      read: () =>
        ++reads === 1
          ? Promise.reject(new EditableProfileReadError(503, { status: 503, retryAfter: '5' }))
          : Promise.resolve(initial()),
    }, initial());
    editor.edit({ displayName: 'Submitted name' });
    await editor.submit('profile');
    const original = editor.snapshot().attempt, commandRetryAt = now + 120_000;
    expect(editor.snapshot().commandRetryAt).toBe(commandRetryAt);
    editor.edit({ displayName: 'Later draft' });
    const retry = editor.retry.bind(editor), reload = editor.reload.bind(editor);
    await reload();
    const readRetryAt = now + 5_000;
    expect(editor.snapshot().readRetryAt).toBe(readRetryAt);
    await Promise.all([reload(), retry()]);
    expect([reads, attempts.length]).toEqual([1, 1]);
    now = readRetryAt;
    await editor.reload();
    expect([reads, editor.snapshot().commandRetryAt]).toEqual([2, commandRetryAt]);
    await retry();
    expect(attempts).toHaveLength(1);
    now = commandRetryAt;
    await retry();
    expect(attempts[1]).toBe(original);
    expect(editor.snapshot().draft?.displayName).toBe('Later draft');
    editor.edit({ biography: 'First draft' });
    await editor.submit('profile');
    const submit = editor.submit.bind(editor), submitRetryAt = now + 30_000;
    expect(editor.snapshot().commandRetryAt).toBe(submitRetryAt);
    editor.edit({ biography: 'Later draft' });
    await submit('profile');
    expect([attempts.length, editor.snapshot().draft?.biography]).toEqual([3, 'Later draft']);
    editor.retire();
    expect([editor.snapshot().commandRetryAt, editor.snapshot().readRetryAt]).toEqual([0, 0]);
    await submit('profile');
    expect(attempts).toHaveLength(3);
  } finally {
    Date.now = originalNow;
  }
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
  const write = { before: profile, after: profile, idempotencyKey: crypto.randomUUID() };
  expect(parseProfileWrite(write).after.avatar).toEqual({ media: profile.avatar?.media });
  expect(() => parseProfileWrite({ ...write, after: { ...profile, injected: true } })).toThrow();
  expect(() => parseProfileWrite({ ...write, after: { ...profile, displayName: 'x'.repeat(4097) } })).toThrow();
  expect(() => parseProfileWrite({ ...write, after: { ...profile, speakersListed: true } })).toThrow();
});

test('invalid profile submission keeps the exact draft and local avatar without reading or sending a native command', async () => {
  const boundary = api();
  const editor = new ProfileEditor(boundary.io, initial());
  const localAvatar = { media: '019a0000-0000-7000-8000-000000000099' };
  editor.edit({
    displayName: 'x'.repeat(4097),
    biography: null,
    avatar: localAvatar,
    links: [{ label: ' '.repeat(64), url: 'http://example.test/exact draft' }],
  });
  const draft = editor.snapshot().draft;
  await editor.submit('profile');
  expect(profileFieldErrors(draft!)).toEqual({ displayName: 'text', 'label-0': 'label', 'url-0': 'url' });
  expect(editor.snapshot().draft).toBe(draft);
  expect(editor.snapshot().draft?.avatar).toBe(localAvatar);
  expect(editor.snapshot().draft?.displayName).toHaveLength(4097);
  expect(editor.snapshot().known).toEqual(initial());
  expect(editor.snapshot().attempt).toBeNull();
  expect(boundary.writes).toHaveLength(0);
  expect(boundary.reads).toHaveLength(0);
  editor.edit({ displayName: null, avatar: null, links: [{ label: '😀'.repeat(64), url: 'https://example.test' }] });
  await editor.submit('profile');
  expect(boundary.writes).toHaveLength(1);
  expect(boundary.writes[0]?.patch).toEqual({
    displayName: null,
    biography: null,
    avatar: null,
    links: [{ label: '😀'.repeat(64), url: 'https://example.test' }],
  });
  expect(editor.snapshot().phase).toBe('saved');
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

test('a cancelled discard decision retains the actual draft and immutable original unresolved attempt for retry', async () => {
  const sent: ProfileAttempt[] = [];
  let current = initial();
  const editor = new ProfileEditor(
    {
      read: async () => current,
      save: async (attempt) => {
        sent.push(attempt);
        current = attempt.after;
        if (sent.length === 1) throw new Error('Response lost');
        return { ok: true, profile: current };
      },
    },
    initial(),
  );
  editor.edit({ displayName: 'Sent name' });
  await editor.submit('profile');
  editor.edit({ biography: 'Later local draft' });
  const before = editor.snapshot();
  expect(profileNeedsNavigationDecision(before)).toBe(true);
  // Stay resolves only the router decision; no reload, edit, retry or draft replacement occurs.
  expect(editor.snapshot()).toBe(before);
  expect(editor.snapshot().draft).toBe(before.draft);
  expect(editor.snapshot().attempt).toBe(before.attempt);
  expect(Object.isFrozen(before.attempt)).toBe(true);
  await editor.retry();
  expect(sent[1]).toBe(sent[0]);
  expect(editor.snapshot().draft?.biography).toBe('Later local draft');
  expect(profileNeedsNavigationDecision(editor.snapshot())).toBe(true);
});

test('clean and confirmed-saved profiles need no decision, but later edits and unresolved commands do', async () => {
  const boundary = api();
  const editor = new ProfileEditor(boundary.io, initial());
  expect(profileNeedsNavigationDecision(editor.snapshot())).toBe(false);
  editor.edit({ displayName: 'Saved name' });
  expect(profileNeedsNavigationDecision(editor.snapshot())).toBe(true);
  await editor.submit('profile');
  expect(editor.snapshot().phase).toBe('saved');
  expect(profileNeedsNavigationDecision(editor.snapshot())).toBe(false);
  editor.edit({ biography: 'Later edit' });
  expect(profileNeedsNavigationDecision(editor.snapshot())).toBe(true);

  const uncertain = new ProfileEditor(
    {
      read: async () => initial(),
      save: async () => {
        throw new Error('Response lost');
      },
    },
    initial(),
  );
  uncertain.edit({ displayName: 'Unresolved name' });
  await uncertain.submit('profile');
  uncertain.edit({ displayName: initial().displayName });
  expect(uncertain.snapshot().draft).toEqual(uncertain.snapshot().known);
  expect(profileNeedsNavigationDecision(uncertain.snapshot())).toBe(true);
});

test('the shared activity draft and local image selection also require a discard decision', () => {
  const editor = new ProfileEditor(
    {
      read: async () => initial(),
      save: async () => {
        throw new Error('Unused');
      },
    },
    initial(),
  );
  editor.edit({ publicViews: { ...initial().publicViews, reviews: false } });
  expect(profileNeedsNavigationDecision(editor.snapshot())).toBe(true);
  editor.edit({ publicViews: initial().publicViews });
  for (const phase of ['uploading', 'ready', 'error'] as const)
    expect(profileNeedsNavigationDecision(editor.snapshot(), { phase, url: 'blob:local-selection' })).toBe(true);
  expect(profileNeedsNavigationDecision(editor.snapshot(), { phase: 'cancelled', url: null })).toBe(false);
});
