import { expect, expectTypeOf, test } from 'bun:test';
import {
  createKernelClient,
  zoneCollections,
  type ZoneCollectionsPage,
  type ZoneCollectionsQuery,
} from '../src/index.ts';

const ORIGIN = 'https://kernel.test';
const ZONE_ID = '019a1b2c-3d4e-7f00-8a00-000000000001';
const COLLECTION_ID = '019a1b2c-3d4e-7f00-8a00-000000000002';

function response(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': status < 400 ? 'application/json' : 'application/problem+json' },
  });
}

test('the installed Zone namespace receives a native Collection page envelope', async () => {
  const sent: Request[] = [];
  const page: ZoneCollectionsPage = {
    collections: [
      {
        id: COLLECTION_ID,
        membershipKind: 'curated',
        curatorAccountId: null,
        title: 'Public shelf',
        description: null,
        visibility: 'public',
        presentationKind: null,
        presentationKindSource: 'owner',
        coverSource: 'none',
        revision: 1,
        memberCount: 0,
        orderEpoch: 1,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ],
    next: null,
  };
  const client = createKernelClient(ORIGIN, {
    fetch: (async (input, init) => {
      sent.push(new Request(input, init));
      return response(200, page);
    }) as typeof fetch,
  });
  const query: ZoneCollectionsQuery = { limit: '1' };
  const result = await zoneCollections(client, ZONE_ID).get({ query });

  expect(sent.map(({ url, method }) => [url, method])).toEqual([
    [`${ORIGIN}/v1/zones/${ZONE_ID}/collections?limit=1`, 'GET'],
  ]);
  expect(result.status).toBe(200);
  expect(result.error).toBeNull();
  expect(result.data).toEqual(page);
  expectTypeOf(result.data!.collections[0]!.id).toEqualTypeOf<string>();
  expectTypeOf<ZoneCollectionsPage['next']>().toEqualTypeOf<string | null>();
});

test('native Zone refusals remain errors and an invalid bearer is sent without anonymous downgrade', async () => {
  const sent: Request[] = [];
  const refused = {
    type: 'https://rezics.com/problems/invalid_credentials',
    title: 'Invalid Credentials',
    status: 401,
    code: 'invalid_credentials',
    retryable: false,
    effect_status: 'not_applicable',
    request_id: '019a1b2c-3d4e-7f00-8a00-0000000000ff',
  };
  const client = createKernelClient(ORIGIN, {
    headers: { authorization: 'Bearer revoked' },
    fetch: (async (input, init) => {
      sent.push(new Request(input, init));
      return response(401, refused);
    }) as typeof fetch,
  });
  const result = await zoneCollections(client, ZONE_ID).get();

  expect(sent[0]!.headers.get('authorization')).toBe('Bearer revoked');
  expect(result.status).toBe(401);
  expect(result.data).toBeNull();
  expect(result.error).toMatchObject({ status: 401, value: refused });
});
