import { afterAll, beforeAll, expect, test } from 'bun:test';
import { admitFilter, parseFilter, type FilterDocument } from '@rezics/filter';
import { releaseDigest, valueSchema, type Release } from '@rezics/definitions';
import pg from 'pg';
import { createPool } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { newId } from '../../src/route/route.ts';
import { compileFilter } from '../../src/search/filter.ts';
import { createOpenSearch } from '../../src/search/opensearch.ts';
import { createSearchScopeSource } from '../../src/search/scope-source.ts';
import { readSearchScopeRelease } from '../../src/search/scope-release.ts';
import { subjectSource } from '../../src/semantic/search-source.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import type { KeyRing } from '../../src/tokens/seal.ts';
import { createRealAccess } from '../semantic/real-access.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(databaseUrl);
const admin = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const actions = ['definitions:publish', 'definitions:activate'] as const;
const realAccess = await createRealAccess(admin, { steward: newId(32001) }, actions);
const routeKey = new Uint8Array(32).fill(74);
const tokens: KeyRing = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(5)]]) };
const kernel = createKernel({ pool, access: realAccess.access, tokens, routeKey, writeRate: realAccess.writeRate });

beforeAll(async () => {
  await realAccess.grant({ route: 0, id: GLOBAL_CONTEXT }, 'steward', 'definitions:publish');
  await realAccess.grant({ route: 0, id: GLOBAL_CONTEXT }, 'steward', 'definitions:activate');
});

afterAll(async () => {
  await pool.end();
  await admin.end();
});

const definitionRelease = (savedType: 'schema:Person' | 'schema:Book'): Release => ({
  format: 'https://rezics.com/definitions/release/1',
  catalogue: { id: 'https://rezics.com/catalogue/scope-release', version: '1.0.0' },
  generator: { name: 'scope-release-test', version: '1' },
  prefixes: { schema: 'http://schema.org/' },
  types: {
    'schema:Person': {
      iri: 'http://schema.org/Person',
      labels: { en: 'person' },
      mappings: [],
      bases: [],
      properties: ['schema:datePublished'],
      facets: ['schema:datePublished'],
    },
    'schema:Book': {
      iri: 'http://schema.org/Book',
      labels: { en: 'book' },
      mappings: [],
      bases: [],
      properties: [],
      facets: [],
    },
  },
  properties: {
    'schema:datePublished': {
      iri: 'http://schema.org/datePublished',
      labels: { en: 'date published' },
      mappings: [],
      datatype: 'time',
      multivalued: false,
      qualifiers: [],
      value: valueSchema('time'),
    },
  },
  filters: {
    'subjects/scope': {
      labels: { en: 'Scope' },
      filter: { type: { in: [savedType] } },
    },
  },
});

async function call(method: string, path: string, body: unknown) {
  const response = await kernel.handle(
    new Request(`http://kernel.test${path}`, {
      method,
      headers: {
        authorization: `Bearer ${realAccess.bearer('steward')}`,
        'idempotency-key': `"${crypto.randomUUID()}"`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    }),
  );
  return { response, body: (await response.json()) as Record<string, unknown> };
}

test('actual immutable release lookup preserves saved scope meaning after active definition changes without a caller release object', async () => {
  const firstBody = definitionRelease('schema:Person');
  const secondBody = definitionRelease('schema:Book');
  const firstDigest = releaseDigest(firstBody);
  const secondDigest = releaseDigest(secondBody);

  expect((await call('POST', '/v1/definitions/releases', { release: firstBody })).response.status).toBe(201);
  expect((await call('POST', '/v1/definitions/releases', { release: secondBody })).response.status).toBe(201);
  expect(
    (await call('POST', `/v1/definitions/releases/${firstDigest}:activate`, { expected_head: null })).body,
  ).toEqual({ digest: firstDigest, head: 1 });
  expect((await call('POST', `/v1/definitions/releases/${secondDigest}:activate`, { expected_head: 1 })).body).toEqual({
    digest: secondDigest,
    head: 2,
  });
  expect(realAccess.checks).toEqual(
    ['definitions:publish', 'definitions:publish', 'definitions:activate', 'definitions:activate'].map((action) => ({
      persona: 'steward',
      action,
      resource: { route: 0, id: GLOBAL_CONTEXT },
    })),
  );

  const saved = parseFilter({ saved: 'subjects/scope' });
  const first = await readSearchScopeRelease(pool, firstDigest);
  expect(first?.digest).toBe(firstDigest);
  expect(first?.release.filters?.['subjects/scope']?.filter).toEqual({ type: { in: ['schema:Person'] } });
  const firstQuery = compileFilter(admitFilter(saved, first!.release), { prefix: 'f' });
  expect(firstQuery).toEqual({
    query: { terms: { type: ['schema:Person'], _name: 'f0' } },
    leaves: [{ name: 'f0', facet: 'type', values: ['schema:Person'], negated: false }],
  });

  const active = await readSearchScopeRelease(pool);
  expect(active?.digest).toBe(secondDigest);
  expect(active?.release.filters?.['subjects/scope']?.filter).toEqual({ type: { in: ['schema:Book'] } });
  const secondQuery = compileFilter(admitFilter(saved, active!.release), { prefix: 'f' });
  expect(secondQuery.leaves[0]).toEqual({ name: 'f0', facet: 'type', values: ['schema:Book'], negated: false });
  expect(secondQuery.query).toEqual({ terms: { type: ['schema:Book'], _name: 'f0' } });

  const scopedFilter: FilterDocument = parseFilter({
    and: [
      { saved: 'subjects/scope' },
      { statement: { property: 'schema:datePublished', range: { gte: 1990, lte: 1999 } } },
    ],
  });
  const scope = createSearchScopeSource({
    pool,
    client: createOpenSearch('http://127.0.0.1:1'),
    prefix: 'scope-release-test-',
    source: subjectSource(pool, routeKey),
  });
  // Pin A expands the same saved ID under A and reaches the existing native-readiness boundary.
  await expect(scope.prepare(scopedFilter, { releaseDigest: firstDigest })).rejects.toMatchObject({
    code: 'semantic_not_ready',
  });
  // Without a pin, current B is selected; its saved expansion no longer supports this current facet.
  await expect(scope.prepare(scopedFilter)).rejects.toMatchObject({ code: 'unsupported_query' });

  const missingDigest = `sha256:${'0'.repeat(64)}`;
  await expect(scope.prepare(scopedFilter, { releaseDigest: 'not-a-digest' })).rejects.toMatchObject({
    code: 'semantic_not_ready',
  });
  await expect(scope.prepare(scopedFilter, { releaseDigest: missingDigest })).rejects.toMatchObject({
    code: 'semantic_not_ready',
  });
  const malformed = await readSearchScopeRelease(pool, 'not-a-digest');
  const missing = await readSearchScopeRelease(pool, missingDigest);
  expect(malformed).toBeNull();
  expect(missing).toBeNull();

  const savedBody = structuredClone(first!.release);
  const cachedPin = await readSearchScopeRelease(pool, firstDigest);
  expect(cachedPin?.digest).toBe(firstDigest);
  expect(cachedPin?.release).toBe(first!.release);
  expect(cachedPin?.release).toEqual(savedBody);
  expect(Object.isFrozen(cachedPin?.release)).toBe(true);
  expect(compileFilter(admitFilter(saved, cachedPin!.release), { prefix: 'f' })).toEqual(firstQuery);
  const { rows } = await admin.query('SELECT body FROM semantic.definition_release WHERE route = 0 AND digest = $1', [
    firstDigest,
  ]);
  expect(rows).toEqual([{ body: firstBody }]);
});
