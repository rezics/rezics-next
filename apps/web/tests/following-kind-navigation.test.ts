import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { followingKind } from '../src/library/following-kind-navigation/address';
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
      if (url.searchParams.has('cursor'))
        return Response.json({ code: 'stale_cursor' }, { status: 409 });
      const kind = url.searchParams.get('targetType') ?? 'subject';
      return Response.json({ follows: ['second', 'first'].map((targetId) => ({
        targetId, targetType: kind, state: 'following', reason: 'explicit', target: null,
      })), next: 'continue' });
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
    expect(page.follows.map((row) => row.targetType)).toEqual([kind === 'all' ? 'subject' : kind, kind === 'all' ? 'subject' : kind]);
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
