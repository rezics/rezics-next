import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { spaceDestination, suppliedDestination } from '../src/library/following-reading/destinations';
import { readSelectedSpace } from '../src/library/following-reading/space-reader';
import type { SessionEnv } from '../src/session/client';
import recording from '../src/kernel/recorded/space.json';
import { follow, realmId, spaceId } from './helpers/following-reading';

test('only admitted address or actual Realm identity builds the localized community route', () => {
  expect(suppliedDestination(follow('space'), 'Community', 'ja')).toBeNull();
  expect(spaceDestination({ address: 'quiet / reading', realmId }, 'ja')?.href).toBe(
    '/ja/spaces/quiet%20%2F%20reading',
  );
  expect(spaceDestination({ address: null, realmId }, 'de')?.href).toBe(`/de/realms/${realmId}`);
  expect(realmId).not.toBe(spaceId);
  expect(spaceDestination({ address: null, realmId: null }, 'en')).toBeNull();
  expect(spaceDestination({ address: '', realmId: 'invalid' }, 'en')).toBeNull();
});

test('one typed selected Space read uses the prepared credential and returns bounded current identity or a truthful refusal', async () => {
  let calls = 0;
  let status = 200;
  const client = createKernelClient('https://kernel.test', {
    fetch: async (input, init) => {
      const request = new Request(input, init);
      calls++;
      expect(new URL(request.url).pathname).toBe(`/v1/spaces/${spaceId}`);
      expect(request.headers.get('authorization')).toBe('Bearer current');
      expect(request.cache).toBe('no-store');
      return status === 200
        ? Response.json({ space: { ...recording.space, spaceId, realmId } })
        : Response.json({ code: 'refused' }, { status });
    },
  });
  const env = {
    SITE_ORIGINS: 'https://site.test',
    AUTH_ISSUER: 'https://auth.test',
    API_RESOURCE: 'https://kernel.test',
    WEBSITE_SCOPES: 'openid',
    WEBSITE_CLIENT_ID: 'web',
    WEBSITE_CLIENT_KEY: 'key',
    SESSIONS: {
      idFromName: (id: string) => id,
      get: () => ({
        credential: async () => ({ status: 'active', subject: 'owner', accessToken: 'current', csrfToken: 'csrf' }),
      }),
    },
  } as unknown as Partial<SessionEnv>;
  const request = () =>
    new Request('https://site.test/en/library/following', {
      headers: { cookie: `__Host-rezics_session=${'a'.repeat(43)}` },
    });
  const input = { spaceId, subject: 'owner', locale: 'en' };
  expect((await readSelectedSpace(client, request(), env, input)).result).toMatchObject({
    state: 'ready',
    space: { spaceId, realmId, address: recording.space.address },
  });
  expect(calls).toBe(1);
  for (const [code, state] of [
    [403, 'denied'],
    [404, 'retired'],
    [503, 'unavailable'],
  ] as const) {
    status = code;
    expect((await readSelectedSpace(client, request(), env, input)).result).toEqual({ state });
  }
  const before = calls;
  expect((await readSelectedSpace(client, request(), env, { ...input, subject: 'other' })).result.state).toBe(
    'unavailable',
  );
  expect(calls).toBe(before);
});
