import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import {
  BOARD_ROW_LIMIT,
  changeMembership,
  COVER_ROW_LIMIT,
  loadMyRealms,
  loadSpacePage,
  locateRealm,
} from '../src/community/space';
import type { SessionEnv } from '../src/session/client';
import type { SessionStore } from '../src/session/store';

const scales = [1, 10, 100];
const sessionId = 'a'.repeat(43);
const csrfToken = 'A'.repeat(22);
const stamp = '2026-10-26T12:00:00.000Z';
const id = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;
const space = id(1);
const realm = id(2);

type Counts = { D: number; K: number };

/** A kernel whose Realm has `size` boards, publications and memberships; every page honours its `limit`. */
function setup(size: number, signedIn: boolean, address: string | null = 'atlas') {
  const counts: Counts = { D: 0, K: 0 };
  const paths: string[] = [];
  const client = createKernelClient('https://kernel.example.test', {
    fetch: (async (input, init) => {
      counts.K += 1;
      const request = new Request(input, init);
      const url = new URL(request.url);
      paths.push(`${request.method} ${url.pathname}`);
      expect(request.headers.get('authorization')).toBe(signedIn ? 'Bearer page-token' : null);
      const limit = Number(url.searchParams.get('limit') ?? 20);
      const page = (length: number, item: (index: number) => unknown) =>
        Response.json({
          items: Array.from({ length: Math.min(length, limit) }, (_, index) => item(index)),
          next: null,
        });
      if (url.pathname.startsWith('/v1/spaceAddresses/')) return Response.json({ spaceId: space });
      if (url.pathname === `/v1/spaces/${space}`)
        return Response.json({
          space: {
            spaceId: space,
            realmId: realm,
            state: 'active',
            headRevisionId: id(3),
            createdAt: stamp,
            creator: id(4),
            predecessor: null,
            address,
            title: 'Atlas',
            summary: 'Maps',
            revisionCreatedAt: stamp,
            author: id(4),
          },
        });
      if (url.pathname === `/v1/realms/${realm}`)
        return Response.json({
          realm: { realmId: realm, spaceId: space, visibility: 'public', title: 'Atlas', summary: '', votes: {} },
        });
      if (url.pathname === `/v1/realms/${realm}/boards`)
        return page(size, (index) => ({
          id: id(1000 + index),
          route: 1,
          visibility: 'published',
          securityRevision: '1',
          createdAt: stamp,
          title: `Board ${index}`,
          purpose: 'discussion',
          availability: 'available',
        }));
      if (url.pathname === `/v1/realms/${realm}/publications`)
        return page(size, (index) => ({
          realmId: realm,
          subjectId: id(2000 + index),
          publicationId: id(3000 + index),
          subjectRevisionId: null,
          publishedAt: stamp,
          verdict: 'adopt',
        }));
      if (url.pathname.startsWith('/v1/subjects/'))
        return Response.json({
          subject: { id: url.pathname.split('/').pop(), type: 'schema:Book', labels: { en: 'Book' } },
          related: {},
          summary: {
            id: 'x',
            type: 'schema:Book',
            types: ['schema:Book'],
            label: null,
            creativeWork: true,
            cover: null,
          },
        });
      if (url.pathname === `/v1/realms/${realm}/members/me`) return Response.json({ state: 'member', since: stamp });
      if (url.pathname === `/v1/realms/${realm}/participation`) return new Response(null, { status: 204 });
      if (url.pathname === '/v1/me/realms')
        return page(size, (index) => ({ realmId: id(4000 + index), name: `Realm ${index}`, role: 'member' }));
      if (url.pathname === `/v1/realms/${realm}/membership`) return Response.json({ workflowId: 'w' }, { status: 202 });
      throw new Error(`unexpected kernel request ${request.method} ${url.pathname}`);
    }) as typeof fetch,
  });
  const session = {
    async credential() {
      counts.D += 1;
      return { status: 'active', subject: 'alice', accessToken: 'page-token', csrfToken };
    },
    async signedIn() {
      counts.D += 1;
      return { signedIn: true, subject: 'alice', csrfToken };
    },
  };
  const env = {
    SITE_ORIGINS: 'https://site.example.test',
    AUTH_ISSUER: 'https://auth.example.test',
    API_RESOURCE: 'https://api.rezics.test',
    WEBSITE_SCOPES: 'openid',
    WEBSITE_CLIENT_ID: 'rezics-web-cost',
    WEBSITE_CLIENT_KEY: 'unused-by-this-read',
    SESSIONS: {
      idFromName: (name: string) => name,
      get: () => session,
    } as unknown as DurableObjectNamespace<SessionStore>,
  } as Partial<SessionEnv>;
  const request = (path: string, method = 'GET') =>
    new Request(`https://site.example.test/en/${path}`, {
      method,
      headers: {
        ...(signedIn ? { cookie: `__Host-rezics_session=${sessionId}` } : {}),
        ...(method === 'GET' ? {} : { origin: 'https://site.example.test', 'x-csrf-token': csrfToken }),
      },
    });
  return { client, env, request, counts, paths };
}

test('the Realm page reads its fixed set once, however many boards, publications and memberships there are', async () => {
  for (const signedIn of [false, true])
    for (const size of scales) {
      const { client, env, request, counts, paths } = setup(size, signedIn);
      const page = await loadSpacePage(client, request('spaces/atlas'), env, { address: 'atlas' }, 'anonymous');
      expect(page.realm?.boards).toHaveLength(Math.min(size, BOARD_ROW_LIMIT));
      expect(page.realm?.published).toHaveLength(Math.min(size, COVER_ROW_LIMIT));
      // The page is always anonymous; personal membership reads belong to the browser after hydration.
      const bound = 5 + Math.min(size, COVER_ROW_LIMIT);
      expect({ size, signedIn, reads: paths.length }).toEqual({ size, signedIn, reads: bound });
      expect(counts).toEqual({ D: 0, K: bound });
    }
});

test('the Realm page of a Space without an address is read from the same fixed set', async () => {
  for (const size of scales) {
    const { client, env, request, counts } = setup(size, true, null);
    const located = await locateRealm(client, request(`realms/${realm}`), env, { realmId: realm }, 'anonymous');
    expect(located.kind).toBe('page');
    // The Realm and the Space, then boards, publications, membership and participation, then the cover row.
    expect(counts).toEqual({ D: 0, K: 4 + Math.min(size, COVER_ROW_LIMIT) });
  }
});

test('a Realm link of a Space with an address costs two reads', async () => {
  for (const size of scales) {
    const { client, env, request, counts } = setup(size, true);
    expect(await locateRealm(client, request(`realms/${realm}`), env, { realmId: realm }, 'anonymous')).toEqual({
      kind: 'redirect',
      address: 'atlas',
    });
    expect(counts).toEqual({ D: 0, K: 2 });
  }
});

test('my Realms is one page read, however many Realms the person has joined', async () => {
  for (const size of scales) {
    const { client, env, request, counts, paths } = setup(size, true);
    const page = await loadMyRealms(client, request('realms'), env, {});
    expect(page.realms).toHaveLength(Math.min(size, 20));
    expect(paths).toEqual(['GET /v1/me/realms']);
    expect(counts).toEqual({ D: 1, K: 1 });
  }
});

test('joining or leaving is one write', async () => {
  for (const action of ['join', 'leave'] as const) {
    const { client, env, request, counts, paths } = setup(10, true);
    const outcome = await changeMembership(client, request(`spaces/atlas`, 'POST'), env, {
      realmId: realm,
      action,
      idempotencyKey: '123e4567-e89b-42d3-a456-426614174000',
    });
    expect(outcome).toBe('accepted');
    expect(paths).toEqual([`${action === 'join' ? 'POST' : 'DELETE'} /v1/realms/${realm}/membership`]);
    expect(counts).toEqual({ D: 1, K: 1 });
  }
});
