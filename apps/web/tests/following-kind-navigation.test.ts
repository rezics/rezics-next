import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { followingKind } from '../src/library/following-kind-navigation/address';
import {
  acceptFollowingWindow,
  emptyFollowingWindowHistory,
  reconcileFollowingAddress,
  reconcileFollowingIdentity,
  seedFollowingWindow,
  stageFollowingWindow,
  type FollowingWindow,
} from '../src/library/following-kind-navigation/window-history';
import { loadMineFollowingPage } from '../src/library/mine-following';
import type { SessionEnv } from '../src/session/client';

test('kind address admits the rebuilt target kinds without broadening unknown filters', () => {
  for (const kind of ['all', 'subject', 'collection', 'space']) expect(followingKind(kind)).toBe(kind);
  expect(followingKind(undefined)).toBe('all');
  for (const invalid of ['', 'author', 'concept', 'realm', ['space'], null, 1])
    expect(followingKind(invalid)).toBeNull();
});

test('native reads select a complete kind, retain it on stale restart, and omit it for all', async () => {
  const requests: URL[] = [];
  const client = createKernelClient('https://kernel.test', {
    fetch: async (input, init) => {
      const url = new URL(String(input));
      requests.push(url);
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer token');
      if (url.searchParams.has('cursor')) return Response.json({ code: 'stale_cursor' }, { status: 409 });
      const kind = url.searchParams.get('targetType') ?? 'subject';
      return Response.json({
        follows: ['second', 'first'].map((targetId) => ({
          targetId,
          targetType: kind,
          state: 'following',
          reason: 'explicit',
          target: null,
        })),
        next: 'continue',
      });
    },
  });
  const env = {
    SITE_ORIGINS: 'https://site.test',
    AUTH_ISSUER: 'https://auth.test',
    API_RESOURCE: 'https://kernel.test',
    WEBSITE_SCOPES: 'openid',
    WEBSITE_CLIENT_ID: 'web',
    WEBSITE_CLIENT_KEY: 'unused',
    SESSIONS: {
      idFromName: (name: string) => name,
      get: () => ({
        credential: async () => ({
          status: 'active',
          subject: 'reader',
          accessToken: 'token',
          csrfToken: 'A'.repeat(22),
        }),
      }),
    },
  } as unknown as Partial<SessionEnv>;
  for (const kind of ['subject', 'collection', 'space', 'all']) {
    const request = new Request('https://site.test/library/following', {
      headers: { cookie: `__Host-rezics_session=${'a'.repeat(43)}` },
    });
    const page = await loadMineFollowingPage(client, request, env, { kind, cursor: 'another-kind-cursor' });
    expect(page.signedIn).toBe(true);
    expect(page.follows.map((row) => row.targetId)).toEqual(['second', 'first']);
    expect(page.follows.map((row) => row.targetType)).toEqual([
      kind === 'all' ? 'subject' : kind,
      kind === 'all' ? 'subject' : kind,
    ]);
    expect(page.next).toBe('continue');
    expect(page.cursorReset).toBe(true);
    expect(page.kindUnavailable).toBeUndefined();
    for (const url of requests.splice(0)) {
      expect(url.searchParams.get('targetType')).toBe(kind === 'all' ? null : kind);
      expect(url.searchParams.get('limit')).toBe('20');
      expect(url.searchParams.get('view')).toBe('FULL');
    }
  }
  expect(requests).toEqual([]);
});

test('unavailable kind retires inspection and destinations without presenting an empty population', async () => {
  const { mountFollowing, follow, page } = await import('./helpers/following-reading');
  const row = follow('space');
  row.destination = { kind: 'space', spaceId: row.targetId, address: 'reading' };
  const view = await mountFollowing(page(row));
  try {
    await view.inspect(row.targetId);
    expect(view.host.querySelector('h3')?.textContent).toBe('space title');
    await view.replace({ signedIn: true, follows: [], next: null, kindUnavailable: true });
    expect(view.host.querySelector('h3')).toBeNull();
    expect(view.host.querySelector('a[href*="/spaces/"]')).toBeNull();
    expect(view.host.querySelector('[role="alert"]')?.textContent).toContain('currently unavailable');
    expect(view.host.textContent).not.toContain('You aren’t following');
    expect(view.host.querySelector('nav a[aria-current="page"]')?.textContent).toBe('All kinds');
  } finally {
    await view.dispose();
  }
});

test('window history bounds branches, retries exact addresses, and clears on First or kind change', () => {
  const first: FollowingWindow = { cursor: null, kind: 'subject' };
  let identity = { source: {}, subject: 'owner', locale: 'en', authorityEpoch: 1 };
  let history = seedFollowingWindow({ current: null, previous: [], staged: null }, first, 0, identity);
  for (let index = 1; index <= 10; index++) {
    const from = history.current!.address;
    const target = { cursor: `cursor-${index}`, kind: 'subject' as const };
    const staged = stageFollowingWindow(history, {
      from,
      addressVisit: history.current!.addressVisit,
      target,
      movement: 'next',
      identity,
      id: index,
      keyboard: false,
    })!;
    expect(
      stageFollowingWindow(staged, {
        from,
        addressVisit: history.current!.addressVisit,
        target,
        movement: 'next',
        identity,
        id: 99,
        keyboard: false,
      }),
    ).toBeNull();
    identity = { ...identity, source: {} };
    history = acceptFollowingWindow(staged, target, index, identity);
    expect(history.previous.length).toBeLessThanOrEqual(8);
  }
  expect(history.previous.map(({ cursor }) => cursor)).toEqual([
    'cursor-2',
    'cursor-3',
    'cursor-4',
    'cursor-5',
    'cursor-6',
    'cursor-7',
    'cursor-8',
    'cursor-9',
  ]);

  const previous = history.previous.at(-1)!;
  const stagedPrevious = stageFollowingWindow(history, {
    from: history.current!.address,
    addressVisit: history.current!.addressVisit,
    target: previous,
    movement: 'previous',
    identity,
    id: 11,
    keyboard: false,
  })!;
  expect(acceptFollowingWindow(stagedPrevious, { cursor: 'wrong', kind: 'subject' }, 99, identity)).toBe(
    stagedPrevious,
  );
  expect(stagedPrevious.previous).toEqual(history.previous);
  identity = { ...identity, source: {} };
  history = acceptFollowingWindow(stagedPrevious, previous, 11, identity);
  expect(history.previous.map(({ cursor }) => cursor)).toEqual([
    'cursor-2',
    'cursor-3',
    'cursor-4',
    'cursor-5',
    'cursor-6',
    'cursor-7',
    'cursor-8',
  ]);

  const branch = { cursor: 'branch+', kind: 'subject' as const };
  const stagedBranch = stageFollowingWindow(history, {
    from: history.current!.address,
    addressVisit: history.current!.addressVisit,
    target: branch,
    movement: 'next',
    identity,
    id: 12,
    keyboard: false,
  })!;
  identity = { ...identity, source: {} };
  history = acceptFollowingWindow(stagedBranch, branch, 12, identity);
  expect(history.previous.at(-1)).toEqual(previous);
  expect(history.previous.some(({ cursor }) => cursor === 'cursor-10')).toBe(false);

  const stagedFirst = stageFollowingWindow(history, {
    from: history.current!.address,
    addressVisit: history.current!.addressVisit,
    target: first,
    movement: 'first',
    identity,
    id: 13,
    keyboard: false,
  })!;
  expect(acceptFollowingWindow(stagedFirst, { cursor: 'not-first', kind: 'subject' }, 99, identity)).toBe(stagedFirst);
  expect(stagedFirst.previous).toEqual(history.previous);
  identity = { ...identity, source: {} };
  history = acceptFollowingWindow(stagedFirst, first, 13, identity);
  expect(history.previous).toEqual([]);

  const stagedKind = stageFollowingWindow(history, {
    from: first,
    addressVisit: history.current!.addressVisit,
    target: { cursor: null, kind: 'space' },
    movement: 'kind',
    identity,
    id: 14,
    keyboard: false,
  })!;
  identity = { ...identity, source: {} };
  history = acceptFollowingWindow(stagedKind, { cursor: null, kind: 'space' }, 14, identity);
  expect(history.previous).toEqual([]);
});

test('direct A/B/A visits, equal-source replacement and abandoned staged movement retire coordinates', () => {
  const first: FollowingWindow = { cursor: null, kind: 'all' };
  const second: FollowingWindow = { cursor: 'cursor-b', kind: 'all' };
  let identity = { source: {}, subject: 'owner', locale: 'en', authorityEpoch: 1 };
  const seed = seedFollowingWindow(emptyFollowingWindowHistory(), first, 1, identity);
  const staged = stageFollowingWindow(seed, {
    from: first,
    addressVisit: 1,
    target: second,
    movement: 'next',
    identity,
    id: 1,
    keyboard: true,
  })!;
  const targetVisit = reconcileFollowingAddress(staged, second, 2);
  identity = { ...identity, source: {} };
  const accepted = acceptFollowingWindow(targetVisit, second, 2, identity);
  expect(accepted.previous).toEqual([first]);
  expect(accepted.current?.focusId).toBe(1);

  const replacement = reconcileFollowingIdentity(accepted, second, { ...identity, source: {} });
  expect(replacement).toEqual(emptyFollowingWindowHistory());
  expect(reconcileFollowingAddress(accepted, first, 3)).toEqual(emptyFollowingWindowHistory());

  const pending = stageFollowingWindow(accepted, {
    from: second,
    addressVisit: 2,
    target: first,
    movement: 'first',
    identity,
    id: 2,
    keyboard: true,
  })!;
  const visitedTarget = reconcileFollowingAddress(pending, first, 4);
  expect(visitedTarget.staged).not.toBeNull();
  expect(reconcileFollowingAddress(visitedTarget, second, 5)).toEqual(emptyFollowingWindowHistory());
});
