import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import {
  changeCollectionVisibility,
  readOwnedCollections,
  type OwnedCollectionsPage,
} from '../src/settings/preferences';

const sessionId = 'a'.repeat(43);
const csrfToken = 'A'.repeat(22);
const env = {
  SITE_ORIGINS: 'https://site.example.test',
  AUTH_ISSUER: 'https://auth.example.test',
  API_RESOURCE: 'https://api.rezics.test',
  WEBSITE_SCOPES: 'openid account:read account:update collection:read collection:update',
  WEBSITE_CLIENT_ID: 'rezics-web-privacy',
  WEBSITE_CLIENT_KEY: 'unused',
  SESSIONS: {
    idFromName: (name: string) => name,
    get: () => ({
      async credential() {
        return { status: 'active', subject: 'alice', accessToken: 'page-token', csrfToken };
      },
      async signedIn() {
        return { signedIn: true, subject: 'alice', csrfToken };
      },
    }),
  },
} as never;

function request(method: 'GET' | 'POST' = 'GET') {
  return new Request('https://site.example.test/en/settings', {
    method,
    headers: {
      cookie: `__Host-rezics_session=${sessionId}`,
      ...(method === 'POST' ? { origin: 'https://site.example.test', 'x-csrf-token': csrfToken } : {}),
    },
  });
}

function collection(id: string, title: string, visibility: 'private' | 'unlisted' | 'public', revision = 7) {
  return {
    id,
    title,
    description: null,
    visibility,
    revision,
    curatorAccountId: 'alice',
    state: 'active',
    memberCount: 0,
    orderEpoch: 0,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

test('privacy page reads one bounded owner page at a time and preserves its cursor', async () => {
  const calls: Request[] = [];
  const client = createKernelClient('https://kernel.example.test', {
    fetch: (async (input, init) => {
      const current = new Request(input, init);
      calls.push(current);
      return Response.json({
        collections: [collection(`c${calls.length}`, 'Reading list', 'unlisted')],
        next: calls.length === 1 ? 'cursor-2' : null,
      });
    }) as typeof fetch,
  });
  const first = await readOwnedCollections(client, request(), env, null);
  expect(first.collections.map((item) => item.id)).toEqual(['c1']);
  expect(first.next).toBe('cursor-2');
  expect(calls).toHaveLength(1);
  expect(new URL(calls[0]!.url).pathname).toBe('/v1/accounts/alice/collections');
  expect(new URL(calls[0]!.url).searchParams.get('limit')).toBe('20');
  expect(calls[0]!.headers.get('authorization')).toBe('Bearer page-token');

  const second = await readOwnedCollections(client, request(), env, first.next);
  expect(second.collections).toHaveLength(1);
  expect(calls).toHaveLength(2);
  expect(new URL(calls[1]!.url).searchParams.get('cursor')).toBe('cursor-2');
});

test('first-page cost stays fixed for 5 and 50 Collections, then grows by one read per requested page', async () => {
  for (const size of [5, 50]) {
    let reads = 0;
    const client = createKernelClient('https://kernel.example.test', {
      fetch: (async (input) => {
        reads += 1;
        const url = new URL(input instanceof Request ? input.url : input.toString());
        const second = url.searchParams.get('cursor') === 'next-page';
        const start = second ? 20 : 0;
        const count = Math.min(20, size - start);
        return Response.json({
          collections: Array.from({ length: Math.max(0, count) }, (_, index) =>
            collection(`c${start + index}`, `Collection ${start + index}`, 'private'),
          ),
          next: start + count < size ? 'next-page' : null,
        });
      }) as typeof fetch,
    });
    const first = await readOwnedCollections(client, request(), env, null);
    expect(first.collections).toHaveLength(Math.min(20, size));
    expect(reads).toBe(1);
    if (first.next) {
      await readOwnedCollections(client, request(), env, first.next);
      expect(reads).toBe(2);
    }
  }
});

test('visibility changes send the collection revision and expose the server answer', async () => {
  for (const visibility of ['private', 'unlisted', 'public'] as const) {
    let sent: Request | undefined;
    const client = createKernelClient('https://kernel.example.test', {
      fetch: (async (input, init) => {
        sent = new Request(input, init);
        return Response.json({ collection: collection('c1', 'Reading list', visibility, 8) });
      }) as typeof fetch,
    });
    const result = await changeCollectionVisibility(client, request('POST'), env, {
      collectionId: 'c1',
      revision: 7,
      visibility,
      idempotencyKey: '123e4567-e89b-42d3-a456-426614174000',
    });
    expect(result).toEqual({ ok: true, collection: expect.objectContaining({ visibility, revision: 8 }) });
    expect(sent?.method).toBe('PATCH');
    expect(new URL(sent!.url).pathname).toBe('/v1/collections/c1');
    expect(await sent!.clone().json()).toEqual({ revision: 7, visibility });
  }
});

test('stale and failed writes report a refusal without inventing a new collection value', async () => {
  const conflictClient = createKernelClient('https://kernel.example.test', {
    fetch: (async () => Response.json({ code: 'conflict' }, { status: 409 })) as typeof fetch,
  });
  const conflict = await changeCollectionVisibility(conflictClient, request('POST'), env, {
    collectionId: 'c1',
    revision: 7,
    visibility: 'private',
    idempotencyKey: '123e4567-e89b-42d3-a456-426614174000',
  });
  expect(conflict).toEqual({ ok: false, reason: 'conflict' });

  const unavailableClient = createKernelClient('https://kernel.example.test', {
    fetch: (async () => new Response('down', { status: 503 })) as typeof fetch,
  });
  const unavailable = await changeCollectionVisibility(unavailableClient, request('POST'), env, {
    collectionId: 'c1',
    revision: 7,
    visibility: 'private',
    idempotencyKey: '123e4567-e89b-42d3-a456-426614174000',
  });
  expect(unavailable).toEqual({ ok: false, reason: 'unavailable' });
});

test('settings collection rows have a stable privacy-page contract', () => {
  const page: OwnedCollectionsPage = { collections: [collection('c1', 'Reading list', 'private')], next: null };
  expect(page.collections[0]).toMatchObject({ id: 'c1', title: 'Reading list', visibility: 'private', revision: 7 });
});
