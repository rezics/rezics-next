import { expect, test } from 'bun:test';
import { systemClock } from '../../src/clock.ts';
import { createDiscoveryProducerEntry } from '../../src/composition/discovery.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { subjectListingSource } from '../../src/library/listing-counts.ts';
import type { Access } from '../../src/request/access.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { createDiscoveryProjection, nativeDiscoveryRegistry } from '../../src/search/account-discovery.ts';
import { resolveDiscoveryOwnerAdapters } from '../../src/search/discovery-owner-registry.ts';
import { advanceDiscovery, discoveryGenerations } from '../../src/search/generations.ts';
import { createOpenSearch, SearchUnavailableError, type OpenSearch } from '../../src/search/opensearch.ts';
import {
  createSubjectIndex,
  discoveryIndexName,
  markSubjectCalendarReady,
  readSubjectCalendarFormat,
  subjectAlias,
  subjectGenerations,
  subjectIndexName,
} from '../../src/search/indices.ts';
import { publishSubjectActivationMetadata } from '../../src/search/generation-publication.ts';
import { createSemanticDriver } from '../semantic/outcome-driver.ts';

test('native mixed generation settles the exact Collection copy and can replay its visible winner', async () => {
  let access!: Access;
  const driver = await createSemanticDriver((deps) =>
    createKernel({
      ...deps,
      onAccessReady(nativeAccess, viewerActions) {
        access = nativeAccess;
        deps.onAccessReady?.(nativeAccess, viewerActions);
      },
    }),
  );
  const { pool, runtime } = driver.fixtures;
  const search = createOpenSearch(process.env.OPENSEARCH_URL!);
  const prefix = `metadata-${crypto.randomUUID().slice(0, 8)}-`;
  let index: string | undefined;
  try {
    await driver.fixtures.openFeatures(['personal_library']);
    const curator = await driver.fixtures.person('metadata-curator');
    const created = await driver.fixtures.send(
      curator,
      'POST',
      '/v1/collections',
      { title: 'Mixed generation Collection', visibility: 'public' },
      { 'Idempotency-Key': JSON.stringify(crypto.randomUUID()) },
    );
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const { id } = created.body.collection as { id: string };
    const route = routeOf(id)!;
    const routeKey = Buffer.from(runtime.routeKey, 'base64url');
    const producers = createDiscoveryProducerEntry({ pool, routeKey, access, clock: systemClock });
    const { ownerAdapters, metadataProducers } = await resolveDiscoveryOwnerAdapters({
      ownerAdapters: producers.ownerAdapters,
      metadataProducers: { collection: producers.metadataProducers.collection! },
    });
    const registry = await nativeDiscoveryRegistry(pool, routeKey, producers.subjects, { ownerAdapters });
    const options = { pool, search, prefix, registry, listing: subjectListingSource(pool), metadataProducers };
    await advanceDiscovery(options);
    const target = (await discoveryGenerations(pool, prefix))[0]!;
    index = discoveryIndexName(prefix, target.generation);
    expect(target.state).toBe('populating');
    const projection = createDiscoveryProjection({ ...options, target });
    const home = partitionOf(route);

    expect(await projection.projectOwner('collection', home, [id])).toMatchObject([
      { key: { owner: 'commerce', kind: 'collection', id, route }, action: { op: 'index' } },
    ]);
    const copy = await pool.query(
      "SELECT settled FROM search.discovery_copy WHERE route=$1 AND source_id=$2 AND prefix=$3 AND generation=$4 AND kind='collection'",
      [route, id, prefix, target.generation],
    );
    expect(copy.rows).toEqual([{ settled: true }]);
    expect(await projection.projectOwner('collection', home, [id])).toEqual([]);
  } finally {
    try {
      if (index) await search.request('DELETE', `/${index}`);
    } finally {
      await driver.close();
    }
  }
}, 120_000);

test('contradictory duplicate alias receipts cannot choose their first native target', async () => {
  const native = createOpenSearch(process.env.OPENSEARCH_URL!);
  const prefix = `metadata-${crypto.randomUUID().slice(0, 8)}-`;
  const first = subjectIndexName(prefix, 1),
    second = subjectIndexName(prefix, 2),
    alias = subjectAlias(prefix);
  await createSubjectIndex(native, prefix, 1);
  await createSubjectIndex(native, prefix, 2);
  try {
    await native.request('POST', '/_aliases', { actions: [{ add: { index: first, alias } }] });
    const client: OpenSearch = {
      bulk: native.bulk,
      async request<T>(...args: Parameters<OpenSearch['request']>) {
        const response = await native.request<T>(...args);
        if (!args[1].startsWith('/_resolve/index/')) return response;
        const body = structuredClone(response.body) as { aliases: { name: string; indices: string[] }[] };
        expect(body.aliases.find((value) => value.name === alias)?.indices).toEqual([first]);
        body.aliases.push({ name: alias, indices: [second] });
        return { ...response, body: body as T };
      },
    };
    await expect(subjectGenerations(client, prefix)).rejects.toBeInstanceOf(SearchUnavailableError);
  } finally {
    await native.request('DELETE', `/${first}`);
    await native.request('DELETE', `/${second}`);
  }
});

test('activation preserves released calendar metadata through a lost mapping response', async () => {
  const native = createOpenSearch(process.env.OPENSEARCH_URL!);
  const prefix = `metadata-${crypto.randomUUID().slice(0, 8)}-`;
  const index = subjectIndexName(prefix, 1);
  await createSubjectIndex(native, prefix, 1);
  try {
    await markSubjectCalendarReady(native, prefix, 1);
    const before = await native.request<Record<string, { mappings: { _meta: Record<string, unknown> } }>>(
      'GET',
      `/${index}/_mapping`,
    );
    let writes = 0;
    const search: OpenSearch = {
      ...native,
      async request<T>(...args: Parameters<OpenSearch['request']>) {
        const response = await native.request<T>(...args);
        if (args[0] === 'PUT' && args[1] === `/${index}/_mapping`) {
          writes++;
          throw new Error('Lost native activation mapping response after apply');
        }
        return response;
      },
    };
    const activatedAt = new Date().toISOString();
    await publishSubjectActivationMetadata(search, index, activatedAt);
    expect(writes).toBe(1);
    const after = await native.request<typeof before.body>('GET', `/${index}/_mapping`);
    expect(after.body[index]!.mappings._meta).toEqual({
      ...before.body[index]!.mappings._meta,
      activated_at: activatedAt,
    });
    expect(await readSubjectCalendarFormat(native, prefix, 1)).toBe(1);
  } finally {
    await native.request('DELETE', `/${index}`);
  }
});
