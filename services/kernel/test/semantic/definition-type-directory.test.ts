import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  CATALOGUE_FORMAT,
  CATALOGUE_NODE_FORMAT,
  KIND_FORMAT,
  buildCatalogue,
  parseCatalogueJson,
  releaseDigest,
  valueSchema,
  type Release,
} from '@rezics/definitions';
import { createPool } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { typeDirectorySort } from '../../src/semantic/definition-type-directory.ts';
import { createRealAccess } from './real-access.ts';
import { testReceiptKeys } from '../support/receipt-keys.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';

function release(shard: number, size: number): Release {
  const types: Release['types'] = {};
  for (let i = 0; i < size; i++) {
    const id = `test:T${shard}${String(i).padStart(3, '0')}`;
    types[id] = {
      iri: `https://types.example/${id}`,
      labels: { en: 'Shared Type', ja: '型' },
      descriptions: { en: 'A short description.' },
      mappings: [],
      bases: i ? [`test:T${shard}000`] : [],
      properties: ['test:tag'],
      facets: ['test:tag'],
      listPresentation: { imageAspect: 'square', keyFacts: ['test:tag'] },
    };
  }
  return {
    format: 'https://rezics.com/definitions/release/1',
    catalogue: { id: `https://types.example/shard/${shard}`, version: '1' },
    generator: { name: 'test', version: '1' },
    prefixes: { test: 'https://types.example/' },
    types,
    properties: {
      'test:tag': {
        iri: 'https://types.example/tag',
        labels: { en: 'Tag' },
        mappings: [],
        datatype: 'string',
        multivalued: true,
        qualifiers: [],
        value: valueSchema('string'),
      },
    },
  };
}

test('Type directory sort preserves literal label and ID order beyond B-tree key sizes', () => {
  const strings = ['', '\0', 'A', 'Aa', 'B', '\ud800', '😀', '\uffff', 'z'.repeat(5000)];
  expect([...strings].sort((a, b) => Buffer.compare(typeDirectorySort(a), typeDirectorySort(b)))).toEqual(
    [...strings].sort(),
  );
  expect(Buffer.compare(typeDirectorySort('Same', 'a'), typeDirectorySort('Same', 'aa'))).toBeLessThan(0);
});

test('mounted current Type pages and descriptors span releases, survive staging and reject changed catalogue cursors', async () => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must name the migrated test database');
  const pool = createPool(process.env.DATABASE_URL);
  try {
    const authority = await createRealAccess(pool, { publisher: '019a1b2c-3d4e-7f00-8a00-d1aec7000001' }, [
      'definitions:publish',
      'definitions:activate',
      'definitions:read',
      'gate:definition_publication',
    ]);
    for (const action of ['definitions:publish', 'definitions:activate', 'gate:definition_publication'])
      await authority.grant({ route: 0, id: GLOBAL_CONTEXT }, 'publisher', action);
    const kernel = createKernel({
      pool,
      access: authority.access,
      writeRate: createWriteRateLimiter({
        secret: 'type-directory-native-regression-rate-secret',
        overrides: JSON.stringify({
          'new-account': { write: { maximum: 100000, seconds: 60 } },
          member: { write: { maximum: 100000, seconds: 60 } },
        }),
      }),
      tokens: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(81)]]) },
      routeKey: new Uint8Array(32).fill(82),
      receiptKeys: testReceiptKeys(),
    });
    async function call(path: string, body?: unknown, signed = body !== undefined) {
      const response = await kernel.handle(
        new Request(`http://kernel.test${path}`, {
          method: body === undefined ? 'GET' : 'POST',
          headers: {
            ...(signed ? { authorization: `Bearer ${authority.bearer('publisher')}` } : {}),
            ...(body === undefined
              ? {}
              : { 'content-type': 'application/json', 'idempotency-key': `"${randomUUID()}"` }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      );
      return { status: response.status, body: (await response.json()) as any };
    }
    const shards = [release(0, 24), release(1, 24), release(2, 24)];
    const longId = `test:${'z'.repeat(4096)}`;
    shards[2]!.types[longId] = { ...shards[2]!.types['test:T2000']!, iri: `https://types.example/${longId}` };
    // Original Release1 activation is also a usable, bounded directory and retains historical reads.
    expect((await call('/v1/definitions/releases', { release: shards[0] })).status).toBe(201);
    const legacyDigest = releaseDigest(shards[0]!);
    expect((await call(`/v1/definitions/releases/${legacyDigest}:activate`, { expected_head: null })).status).toBe(200);
    expect((await call('/v1/definitionTypes?locale=fr&limit=2')).body.types[0]).toMatchObject({
      label: 'Shared Type',
      language: 'en',
    });
    const objects = new Map<string, Uint8Array>();
    const store = {
      read: async (digest: string) => objects.get(digest),
      put: async (digest: string, bytes: Uint8Array) => {
        objects.set(digest, bytes);
      },
    };
    async function build(releases: Release[]) {
      const pin = await buildCatalogue({ releases, compatibility: 'all' }, store);
      for (const bytes of objects.values()) {
        const artifact = parseCatalogueJson(bytes, 4194304) as any;
        const kind =
          artifact.format === CATALOGUE_FORMAT
            ? 'root'
            : artifact.format === CATALOGUE_NODE_FORMAT
              ? 'node'
              : artifact.format.endsWith('/release/1')
                ? 'release'
                : artifact.format === KIND_FORMAT
                  ? 'declaration'
                  : 'node';
        expect([200, 201]).toContain((await call('/v1/definitions/catalogue/artifacts', { kind, artifact })).status);
      }
      let progress = await call('/v1/definitions/catalogues', { pin });
      expect(progress.status).toBe(200);
      while (progress.body.state === 'building') {
        progress = await call(`/v1/definitions/catalogues/${pin.rootDigest}:step`, {});
        expect(progress.status).toBe(200);
      }
      expect(progress.body.state).toBe('ready');
      return pin;
    }
    const first = await build(shards.slice(0, 2));
    expect(
      (await call(`/v1/definitions/catalogues/${first.rootDigest}:activate`, { expected_head: null })).status,
    ).toBe(200);
    const page = await call('/v1/definitionTypes?query=Shared&limit=20&locale=fr');
    expect(page.status).toBe(200);
    expect(page.body.types).toHaveLength(20);
    expect(page.body.types.map((t: any) => t.typeId)).toEqual(Object.keys(shards[0]!.types).slice(0, 20));
    expect(page.body.types[0]).toMatchObject({
      releaseDigest: legacyDigest,
      language: 'en',
      description: 'A short description.',
    });
    const cursor = encodeURIComponent(page.body.next);
    const second = await call(`/v1/definitionTypes?query=Shared&limit=20&locale=fr&cursor=${cursor}`);
    expect(second.status).toBe(200);
    expect(second.body.types[4].typeId).toBe('test:T1000');
    expect((await call(`/v1/definitionTypes?query=Shared&limit=19&locale=fr&cursor=${cursor}`)).status).toBe(400);
    expect((await call(`/v1/definitionTypes?query=Shared&limit=20&locale=ja&cursor=${cursor}`)).status).toBe(400);
    expect((await call(`/v1/definitionTypes?query=Shared&limit=20&locale=fr&cursor=${cursor}x`)).status).toBe(400);
    const descriptor = await call('/v1/definitionTypes/test%3AT1001?locale=ja');
    expect(descriptor.body).toMatchObject({
      typeId: 'test:T1001',
      label: '型',
      language: 'ja',
      parents: ['test:T1000'],
      definition: { facets: ['test:tag'], listPresentation: { imageAspect: 'square' } },
      properties: { 'test:tag': { datatype: 'string', value: valueSchema('string') } },
    });
    expect((await call('/v1/definitionTypes?typeId=test%3AT1001')).body.types).toHaveLength(1);
    expect((await call('/v1/definitionTypes/test%3Aunknown')).status).toBe(404);
    expect((await call('/v1/definitionTypes?limit=21')).status).toBe(400);
    expect(
      authority.readChecks.some((check) => check.action === 'definitions:read' && check.resource.id === GLOBAL_CONTEXT),
    ).toBe(true);
    expect(
      (
        await kernel.handle(
          new Request('http://kernel.test/v1/definitionTypes', { headers: { authorization: 'Bearer invalid' } }),
        )
      ).status,
    ).toBe(401);
    expect((await call('/v1/definitionTypes?query=absent')).body).toEqual({ types: [], next: null });
    const grown = await build(shards);
    // An interrupted directory rebuild hides no part of the active, complete old catalogue.
    await pool.query('DELETE FROM semantic.definition_type_build WHERE route=0 AND catalogue=$1', [grown.rootDigest]);
    const incomplete = await call(`/v1/definitions/catalogues/${grown.rootDigest}:activate`, { expected_head: 1 });
    expect(incomplete.status).toBe(503);
    expect((await call('/v1/definitionTypes?typeId=test%3AT2000')).body.types).toEqual([]);
    let status = await call(`/v1/definitions/catalogues/${grown.rootDigest}:step`, {});
    while (status.body.state === 'building')
      status = await call(`/v1/definitions/catalogues/${grown.rootDigest}:step`, {});
    expect(status.body.state).toBe('ready');
    expect((await call(`/v1/definitions/catalogues/${grown.rootDigest}:activate`, { expected_head: 1 })).status).toBe(
      200,
    );
    expect((await call(`/v1/definitionTypes?query=Shared&limit=20&locale=fr&cursor=${cursor}`)).status).toBe(409);
    expect((await call(`/v1/definitionTypes/${encodeURIComponent(longId)}`)).body.typeId).toBe(longId);
    const current = await call('/v1/definitionTypes?query=Shared');
    expect(current.body.types).toHaveLength(20);
    expect((await call(`/v1/definitions/releases/${legacyDigest}`)).body.release).toEqual(shards[0]);
    // At both catalogue sizes, the actual next-edge plan uses a range index and a fixed lookahead.
    for (const catalogue of [first.rootDigest, grown.rootDigest]) {
      const plan = (
        await pool.query(
          `EXPLAIN (ANALYZE,FORMAT JSON) SELECT chunk,node_key,entry_key
        FROM semantic.definition_type_edge WHERE route=0 AND catalogue=$1 AND locale='fr' AND parent_key=''
        AND chunk>=$2::bytea ORDER BY chunk LIMIT 21`,
          [catalogue, Buffer.alloc(0)],
        )
      ).rows[0]['QUERY PLAN'][0].Plan;
      expect(plan['Actual Rows']).toBeLessThanOrEqual(21);
      expect(JSON.stringify(plan)).toContain('definition_type_edge_pkey');
      expect(JSON.stringify(plan)).not.toContain('"Node Type":"Sort"');
    }
  } finally {
    await pool.end();
  }
});
