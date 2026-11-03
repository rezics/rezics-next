import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createPool } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { readExposure } from '../../src/access/gates/catalogue.ts';
import { AuthenticationError, type Access, type AccountActor } from '../../src/request/access.ts';
import { routeOf } from '../../src/route/route.ts';
import { decodeSearchCursor, encodeSearchCursor, type SearchCursorBinding } from '../../src/search/cursor.ts';
import type { SearchService } from '../../src/search/http/routes.ts';
import { bindSearchScopeCursorRequest } from '../../src/search/service.ts';
import type { KeyRing } from '../../src/tokens/seal.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(databaseUrl);
const opening = randomUUID();
const now = Date.now();
const asOf = new Date(now).toISOString();
const routeKey = new Uint8Array(32).fill(13);
const tokens: KeyRing = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(9)]]) };
const reader: AccountActor = {
  kind: 'account',
  accountId: '019a1b2c-3d4e-7f00-8a00-5ab1ec700001',
  clientId: 'reader',
  scopes: [],
  requestedBy: '019a1b2c-3d4e-7f00-8a00-5ab1ec700002',
  authnEpoch: 1,
};
const grants = new Map<string, boolean>();
const access: Access = {
  async authenticate(token) {
    if (token === 'reader') return reader;
    throw new AuthenticationError(401, 'Bearer error="invalid_token"');
  },
  async authorize(_client, _actor, action, resource) {
    return action === 'collection:read' ? (grants.get(resource.id) ?? false) : true;
  },
};

let observed:
  | {
      principal: string;
      request: unknown;
      context: Parameters<SearchService['search']>[4];
    }
  | undefined;
const page = { subjects: [], next: null, as_of: asOf } as const;
const search: SearchService = {
  async search(principal, request, _time, _active, context) {
    observed = { principal, request, context };
    await context?.complete(page);
    return page;
  },
  async facets() {
    return { facets: [], as_of: asOf };
  },
  async suggest() {
    return { subjects: [], as_of: asOf };
  },
};
const app = createKernel({ pool, access, tokens, routeKey, search });

beforeAll(async () => {
  for (const group of ['search', 'search_advanced']) {
    if (!(await readExposure(pool, group, new Date(), Date.now() + 10_000)).open) {
      await pool.query(
        `INSERT INTO access.exposure_opening ("group", valid, transaction_id)
         VALUES ($1, tstzrange('2000-01-01T00:00:00Z'::timestamptz, NULL, '[)'), $2)`,
        [group, opening],
      );
    }
  }
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM access.exposure_opening WHERE transaction_id = $1', [opening]);
  } finally {
    await pool.end();
  }
});

test('Library scope requests preserve the verified reader, Access, route key, deadline, text and released conditions', async () => {
  observed = undefined;
  const body = {
    text: 'Kokoro',
    filter: {
      and: [
        { owner: { presence: true } },
        { type: { in: ['schema:Book'] } },
        { statement: { property: 'schema:datePublished', range: { gte: 1990, lte: 1999 } } },
      ],
    },
    sort: 'name',
    limit: 5,
    cursor: 'signed-scope-cursor',
  };
  const response = await app.handle(
    new Request('http://kernel.test/v1/subjects:search', {
      method: 'POST',
      headers: { authorization: 'Bearer reader', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );

  expect(response.status).toBe(200);
  expect(observed?.principal).toBe(`account:${reader.accountId}`);
  expect(observed?.request).toEqual(body);
  expect(observed?.context?.scope?.actor).toBe(reader);
  expect(observed?.context?.scope?.access).toBe(access);
  expect(observed?.context?.scope?.routeKey).toBe(routeKey);
  expect(observed?.context?.scope?.deadline).toBeGreaterThan(Date.now());
  expect(observed?.context?.deadline).toBe(observed?.context?.scope?.deadline);

  const scope = observed!.context!.scope!;
  const collection = '018f0000-0000-7000-8000-00a000000010';
  const concealed = '018f0000-0000-7000-8000-00a000000011';
  grants.set(collection, true);
  expect(await scope.access.authorize({} as never, scope.actor, 'collection:read', { route: routeOf(collection)!, id: collection })).toBe(
    true,
  );
  grants.set(collection, false);
  expect(await scope.access.authorize({} as never, scope.actor, 'collection:read', { route: routeOf(collection)!, id: collection })).toBe(
    false,
  );
  expect(await scope.access.authorize({} as never, scope.actor, 'collection:read', { route: routeOf(concealed)!, id: concealed })).toBe(
    false,
  );
});

test('a scoped cursor is bound to the current canonical source basis', async () => {
  const query = { text: 'Kokoro', filter: { owner: { presence: true } }, sort: 'name' };
  const basis = {
    release: 'release-a',
    query: 'query-a',
    profile: 'subject',
    canonical: 'source-a',
    generation: 4,
    index: 'subjects_4',
  } as const;
  const binding: SearchCursorBinding = {
    operation: 'subjects.search',
    request: bindSearchScopeCursorRequest(query, basis),
    principal: `account:${reader.accountId}`,
  };
  const token = await encodeSearchCursor(tokens, binding, { generation: 4, after: ['name', reader.accountId] }, now);
  expect((await decodeSearchCursor(tokens, binding, token, now)).ok).toBe(true);
  const changed: SearchCursorBinding = {
    ...binding,
    request: bindSearchScopeCursorRequest(query, { ...basis, canonical: 'source-b' }),
  };
  expect(await decodeSearchCursor(tokens, changed, token, now)).toEqual({ ok: false, reason: 'invalid' });
});
