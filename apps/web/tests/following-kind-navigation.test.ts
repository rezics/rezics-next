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

test('uninstalled whole-population producer never reads or filters a mixed page, even with a cursor', async () => {
  let requests = 0;
  const client = createKernelClient('https://kernel.test', { fetch: async () => {
    requests++;
    throw new Error('unsupported kind must not request a mixed page');
  } });
  const env = {
    SITE_ORIGINS: 'https://site.test',
    SESSIONS: { idFromName: (name: string) => name, get: () => ({
      credential: async () => ({ status: 'active', subject: 'reader', accessToken: 'token', csrfToken: 'A'.repeat(22) }),
    }) },
  } as unknown as Partial<SessionEnv>;
  for (const kind of ['subject', 'collection', 'space', 'author']) {
    const request = new Request('https://site.test/library/following', {
      headers: { cookie: `__Host-rezics_session=${'a'.repeat(43)}` },
    });
    const page = await loadMineFollowingPage(client, request, env, { kind, cursor: 'another-kind-cursor' });
    expect(page.signedIn).toBe(true);
    expect(page.follows).toEqual([]);
    expect(page.next).toBeNull();
    expect(kind === 'author' ? page.addressInvalid : page.kindUnavailable).toBe(true);
  }
  expect(requests).toBe(0);
});
