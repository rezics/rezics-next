import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import {
  currentSpaceDestination,
  suppliedDestination,
  suppliedRealmMembershipHref,
} from '../src/library/following-reading/destinations';
import { readSelectedSpace } from '../src/library/following-reading/space-reader';
import type { SessionEnv } from '../src/session/client';
import recording from '../src/kernel/recorded/space.json';
import { follow, realmId, spaceId } from './helpers/following-reading';

test('only admitted address or actual Realm identity builds the localized community route', () => {
  expect(suppliedDestination(follow('space'), 'Community', 'ja')).toBeNull();
  const addressTarget = {
    ...follow('space'),
    destination: { kind: 'space' as const, spaceId, address: 'quiet / reading' },
  };
  expect(
    suppliedDestination({ ...follow('space'), destination: { kind: 'realm', realmId } }, 'Community', 'de')?.href,
  ).toBe(`/de/realms/${realmId}`);
  expect(suppliedDestination(addressTarget, 'Community', 'ja')?.href).toBe('/ja/spaces/quiet%20%2F%20reading');
  expect(realmId).not.toBe(spaceId);
  expect(
    suppliedDestination(
      { ...follow('zone'), destination: { kind: 'zone', zoneId: spaceId } },
      'Independent Zone',
      'en',
    ),
  ).toBeNull();
  expect(
    suppliedDestination({ ...follow('space'), destination: { kind: 'zone', zoneId: realmId } }, 'Zone', 'en'),
  ).toBeNull();
  expect(suppliedDestination({ ...addressTarget, destination: { kind: 'unavailable' } }, 'Community', 'en')).toBeNull();
  expect(
    suppliedDestination({ ...addressTarget, destination: { kind: 'space', spaceId, address: '' } }, 'Community', 'en'),
  ).toBeNull();
});

test('FULL Space operands keep address, Space identity and admitted Realm action identity separate', () => {
  const supplied = {
    ...follow('space'),
    destination: { kind: 'space' as const, spaceId, address: 'quiet / reading' },
    actions: {
      status: 'available' as const,
      resourceType: 'community.realm' as const,
      resourceId: realmId,
      viewerActions: [{ action: 'realm:join', operations: ['realm.join', 'realm.leave'] }],
    },
  };
  const current = {
    spaceId,
    title: 'Community',
    summary: 'Summary',
    address: 'quiet / reading',
    realmId,
  };
  expect(suppliedDestination(supplied, 'Community', 'ja')?.href).toBe('/ja/spaces/quiet%20%2F%20reading');
  expect(currentSpaceDestination(supplied, current, 'ja')?.href).toBe('/ja/spaces/quiet%20%2F%20reading');
  expect(suppliedRealmMembershipHref(supplied, current, 'ja')).toBe(`/ja/realms/${realmId}`);
  expect(suppliedRealmMembershipHref(supplied, { ...current, realmId: spaceId }, 'ja')).toBeNull();
  expect(
    suppliedRealmMembershipHref(
      {
        ...supplied,
        actions: {
          status: 'available',
          resourceType: 'community.realm',
          resourceId: realmId,
          viewerActions: [],
        },
      },
      current,
      'ja',
    ),
  ).toBeNull();
  expect(suppliedRealmMembershipHref({ ...supplied, actions: { status: 'unavailable' } }, current, 'en')).toBeNull();
  expect(suppliedRealmMembershipHref({ ...supplied, destination: { kind: 'unavailable' } }, current, 'en')).toBeNull();
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
