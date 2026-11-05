import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { bundledRelease } from '@rezics/definitions/bundled';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { subjectListingSource } from '../../src/library/listing-counts.ts';
import { bulkLines, documentActions } from '../../src/search/document.ts';
import { rebuildSubjects } from '../../src/search/generations.ts';
import { createSubjectIndexer } from '../../src/search/indexer.ts';
import {
  createSubjectIndex,
  subjectAlias,
  subjectGenerations,
  subjectIndexDefinition,
  subjectIndexName,
} from '../../src/search/indices.ts';
import { createOpenSearch, type OpenSearch } from '../../src/search/opensearch.ts';
import { startSearchIndexing } from '../../src/search/runner.ts';
import { subjectPartition } from '../../src/search/source.ts';
import { subjectSource } from '../../src/semantic/search-source.ts';
import { setupSemantic } from '../../src/semantic/setup.ts';
import { createImportIdentityDriver } from '../imports/identity-driver.ts';
import { identitySupport } from '../imports/identity-fixture.ts';

const searchUrl = process.env.OPENSEARCH_URL;
if (!searchUrl || !process.env.DATABASE_URL)
  throw new Error('DATABASE_URL and OPENSEARCH_URL must name the check database and OpenSearch ICU node');
const search = createOpenSearch(searchUrl);
const expanded = '\uFDFA'.repeat(250);
const cjk = '漢'.repeat(250);
type Hit = {
  _id: string;
  _version: number;
  _source: { id: string; partition: number; names: string[]; name_sort: string | null };
  fields?: { name_sort?: string[] };
  sort: unknown[];
};
type Hits = { hits: { hits: Hit[] } };

// The oracle is the node's complete ICU result, never a local growth classifier.
async function normalize(index: string, text: string) {
  const { body } = await search.request<{ tokens: { token: string }[] }>('POST', `/${index}/_analyze`, {
    normalizer: 'name_key',
    text,
  });
  expect(body.tokens).toHaveLength(1);
  return body.tokens[0]!.token;
}

async function get(index: string, id: string) {
  const { body } = await search.request<Hits>('POST', `/${index}/_search`, {
    query: { ids: { values: [id] } },
    version: true,
    docvalue_fields: ['name_sort'],
  });
  return body.hits.hits[0];
}

async function pages(index: string, ids: string[]) {
  const hits: Hit[] = [];
  let after: unknown[] | undefined;
  for (let page = 0; page < 20; page++) {
    const { body } = await search.request<Hits>('POST', `/${index}/_search`, {
      size: 1,
      query: { ids: { values: ids } },
      sort: [{ name_sort: { order: 'asc', missing: '_last' } }, { id: 'asc' }],
      ...(after ? { search_after: after } : {}),
    });
    if (body.hits.hits.length === 0) return hits;
    hits.push(body.hits.hits[0]!);
    after = hits.at(-1)!.sort;
  }
  throw new Error('Native search_after did not terminate');
}

test('default index relay and rebuild bound native sort values before visible writes and do not checkpoint failed normalization', async () => {
  const driver = createImportIdentityDriver();
  const prefix = `test-${randomUUID().slice(0, 8)}-`;
  let runner: Awaited<ReturnType<typeof startSearchIndexing>> | undefined;
  try {
    const identity = await driver.open({ clock: () => new Date() });
    const { pool, admin } = identity.database;
    await setupSemantic(pool, bundledRelease);
    const scopes = ['subject:create', 'subject:read', 'subject:merge', 'moderation:hide', 'moderation:takedown'];
    const clientId = `native-sort-${randomUUID()}`;
    await identity.auth.internal.registerClient({ clientId, firstParty: true, scopes });
    const support = identitySupport(identity);
    const signed = await support.request('/signin', {
      email: 'governance@identity.test',
      password: 'private native identity fixture password',
      client_id: clientId,
      scope: scopes,
    });
    expect(signed.status).toBe(200);
    const issued = await support.request(
      '/token',
      {},
      new Headers({
        cookie: signed.headers
          .getSetCookie()
          .map((cookie) => cookie.split(';')[0])
          .join('; '),
      }),
    );
    expect(issued.status).toBe(200);
    const bearer = ((await issued.json()) as { access_token: string }).access_token;
    const kernel = createKernel({
      pool,
      access: identity.access,
      routeKey: identity.routeKey,
      tokens: identity.tokenKeys,
      writeRate: createWriteRateLimiter({ secret: randomUUID() }),
    });
    async function post(path: string, body: unknown, status = 200) {
      const response = await kernel.handle(
        new Request(`https://kernel.test${path}`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${bearer}`,
            'content-type': 'application/json',
            'idempotency-key': JSON.stringify(randomUUID()),
          },
          body: JSON.stringify(body),
        }),
      );
      const result = (await response.json()) as Record<string, any>;
      if (response.status !== status) throw new Error(`${path}: HTTP ${response.status} ${JSON.stringify(result)}`);
      return result;
    }
    async function create(label: string) {
      const result = await post('/v1/subjects', { type: 'schema:Book', labels: { en: label }, statements: {} }, 201);
      return result.subject.id as string;
    }
    const labels = new Map<string, string>();
    for (const label of [expanded, cjk, 'Ａ', 'a', expanded]) labels.set(await create(label), label);
    const [overflowId, cjkId, , , secondOverflowId] = [...labels.keys()];
    const hidden = await create('hidden private sort evidence');
    const takenDown = await create('taken down private sort evidence');
    const mergeA = await create('redirect private sort evidence');
    const mergeB = await create('surviving merge label');
    await post(`/v1/subjects/${hidden}:hide`, { reason: 'Native visibility test' });
    await post(`/v1/subjects/${takenDown}:takedown`, {
      notice: { complaint: 'Native visibility test', received_at: new Date().toISOString() },
    });
    const merged = await post('/v1/subjects:merge', { subjects: [mergeA, mergeB] });
    const redirected = merged.redirected as string;
    const survivor = merged.survivor as string;
    expect([mergeA, mergeB]).toContain(redirected);
    expect(redirected).not.toBe(survivor);
    labels.set(survivor, survivor === mergeA ? 'redirect private sort evidence' : 'surviving merge label');
    const excluded = [hidden, takenDown, redirected];
    const all = [...labels.keys(), ...excluded];
    const partitions = [...new Set(all.map(subjectPartition))];
    const source = subjectSource(pool, identity.routeKey);
    const listing = subjectListingSource(pool);
    const snapshots = await Promise.all(
      partitions.map((partition) =>
        source.read(
          partition,
          all.filter((id) => subjectPartition(id) === partition),
        ),
      ),
    );
    for (const snapshot of snapshots) {
      expect(snapshot.position).toBeGreaterThan(0n);
      for (const subject of snapshot.subjects) expect(subjectPartition(subject.id)).toBe(snapshot.partition);
    }

    // Native baseline: keyword ignore_above sees the 250-unit input BEFORE ICU expands it.
    // This historical generation deliberately retains the former raw writer's document.
    const old = subjectIndexName(prefix, 1);
    const definition = structuredClone(subjectIndexDefinition()) as { mappings: { properties: Record<string, any> } };
    definition.mappings.properties.name_sort = { type: 'keyword', normalizer: 'name_key' };
    await search.request('PUT', `/${old}`, definition);
    const full = await normalize(old, expanded);
    const cjkKey = await normalize(old, cjk);
    expect(full.length).toBeGreaterThan(512);
    expect(cjkKey.length).toBe(250);
    for (const snapshot of snapshots) {
      const actions = documentActions(
        snapshot,
        snapshot.subjects.map(({ id }) => id).filter((id) => id !== secondOverflowId),
      );
      if (actions.length === 0) continue;
      const result = await search.bulk<{ errors: boolean }>(bulkLines(old, actions), {
        query: { refresh: 'wait_for' },
      });
      expect(result.errors).toBe(false);
    }
    expect((await get(old, overflowId!))?.fields?.name_sort).toEqual([full]);
    await search.request('PUT', `/${old}/_mapping`, {
      properties: { name_sort: { type: 'keyword', normalizer: 'name_key', ignore_above: 512 } },
    });
    expect((await get(old, overflowId!))?._source.name_sort).toBe(expanded);
    expect((await get(old, overflowId!))?.fields?.name_sort).toEqual([full]);
    // A subsequent real raw write still expands past the mapping bound. The mapping
    // checks input length, so WRITE preparation is required even for newly indexed terms.
    const baseline = snapshots.find((snapshot) => snapshot.partition === subjectPartition(secondOverflowId!))!;
    const raw = documentActions(baseline, [secondOverflowId!]);
    expect(
      (await search.bulk<{ errors: boolean }>(bulkLines(old, raw), { query: { refresh: 'wait_for' } })).errors,
    ).toBe(false);
    expect((await get(old, overflowId!))?.fields?.name_sort).toEqual([full]);
    expect((await get(old, secondOverflowId!))?.fields?.name_sort).toEqual([full]);
    await search.request('POST', '/_aliases', { actions: [{ add: { index: old, alias: subjectAlias(prefix) } }] });

    const index = subjectIndexName(prefix, 2);
    await createSubjectIndex(search, prefix, 2);
    async function checkpoint(consumer: string, partition: number) {
      const result = await admin.query<{ position: string }>(
        'SELECT position::text FROM core.consumer_checkpoint WHERE consumer=$1 AND partition_no=$2',
        [consumer, partition],
      );
      return BigInt(result.rows[0]?.position ?? '0');
    }
    const analysisInputs: string[] = [];
    const writes: { lines: readonly unknown[]; refresh: unknown }[] = [];
    let fault: 'throw' | 'invalid' | undefined;
    let injected = 0;
    let watching: { consumer: string; partition: number } | undefined;
    let visibilityChecks = 0;
    const transport: OpenSearch = {
      request: (async (...args: Parameters<OpenSearch['request']>) => {
        if (args[1].endsWith('/_analyze')) {
          analysisInputs.push(JSON.stringify(args[2]));
          if (fault) {
            const mode = fault;
            fault = undefined;
            injected++;
            if (mode === 'throw') throw new Error('Injected native analysis transport failure');
            return { status: 200, body: { tokens: [{ token: 42 }] } };
          }
        }
        return search.request(...args);
      }) as OpenSearch['request'],
      bulk: (async (lines: readonly unknown[], options?: Parameters<OpenSearch['bulk']>[1]) => {
        writes.push({ lines: structuredClone(lines), refresh: options?.query?.refresh });
        const watch = watching;
        const before = watch ? await checkpoint(watch.consumer, watch.partition) : undefined;
        const result = await search.bulk(lines, options);
        if (watch) {
          // The real refresh=wait_for response must precede checkpoint advancement.
          expect(await checkpoint(watch.consumer, watch.partition)).toBe(before!);
          visibilityChecks++;
        }
        return result;
      }) as OpenSearch['bulk'],
    };
    const consumer = `sort_all_${randomUUID().replaceAll('-', '')}`;
    const relay = createSubjectIndexer({ pool, search: transport, source, listing, index, consumer });
    for (const partition of partitions) {
      watching = { consumer, partition };
      await relay.run(partition);
      const snapshot = snapshots.find((entry) => entry.partition === partition)!;
      expect(await checkpoint(consumer, partition)).toBe(snapshot.position);
    }
    watching = undefined;
    expect(
      (await get(index, overflowId!))?._source.name_sort,
      'actual default outbox drain must store null for the full ICU key exceeding 512 UTF-16 units',
    ).toBeNull();
    expect((await get(index, cjkId!))?._source.name_sort).toBe(cjkKey);
    expect(visibilityChecks).toBeGreaterThan(0);
    expect(writes.length).toBeGreaterThan(0);
    for (const write of writes) {
      expect(write.refresh).toBe('wait_for');
      for (const line of write.lines) {
        const item = line as Record<string, any>;
        const metadata = item.index ?? item.delete;
        if (metadata) {
          expect(metadata.version_type).toBe('external');
          expect(metadata.version).toBe(
            Number(snapshots.find((entry) => entry.partition === subjectPartition(metadata._id))!.position),
          );
        } else {
          expect(item.name_sort === null || (typeof item.name_sort === 'string' && item.name_sort.length <= 512)).toBe(
            true,
          );
          expect(excluded).not.toContain(item.id);
        }
      }
    }
    for (const id of excluded)
      expect(
        writes.some(({ lines }) => lines.some((line) => (line as { delete?: { _id: string } }).delete?._id === id)),
      ).toBe(true);
    async function verify(target: string) {
      for (const [id, label] of labels) {
        const hit = await get(target, id);
        expect(hit?._source.partition).toBe(subjectPartition(id));
        expect(hit?._source.names).toContain(label);
        expect(hit?._source.name_sort).toBe(label === expanded ? null : await normalize(target, label));
        expect(hit?._version).toBe(
          Number(snapshots.find((entry) => entry.partition === subjectPartition(id))!.position),
        );
        const exact = await search.request<Hits>('POST', `/${target}/_search`, {
          query: { term: { 'names.exact': label } },
        });
        expect(exact.body.hits.hits.map((entry) => entry._id)).toContain(id);
        const text = await search.request<Hits>('POST', `/${target}/_search`, { query: { match: { names: label } } });
        expect(text.body.hits.hits.map((entry) => entry._id)).toContain(id);
      }
      for (const id of excluded) expect(await get(target, id)).toBeUndefined();
      expect((await get(target, cjkId!))?.fields?.name_sort).toEqual([cjkKey]);
      const hits = await pages(target, [...labels.keys()]);
      expect(new Set(hits.map((hit) => hit._id)).size).toBe(labels.size);
      const expected = await Promise.all(
        [...labels].map(async ([id, label]) => ({
          id,
          key: label === expanded ? null : await normalize(target, label),
        })),
      );
      expected.sort((a, b) =>
        a.key === b.key ? a.id.localeCompare(b.id) : a.key === null ? 1 : b.key === null ? -1 : a.key < b.key ? -1 : 1,
      );
      expect(hits.map((hit) => hit._id)).toEqual(expected.map(({ id }) => id));
      expect((await pages(target, [...labels.keys()])).map((hit) => hit.sort)).toEqual(hits.map((hit) => hit.sort));
    }
    await verify(index);
    // Both faults must be rejected before bulk, with no successful checkpoint invented.
    for (const mode of ['throw', 'invalid'] as const) {
      const consumer = `sort_${mode}_${randomUUID().replaceAll('-', '')}`;
      const relay = createSubjectIndexer({ pool, search: transport, source, listing, index, consumer });
      const partition = subjectPartition(overflowId!);
      watching = { consumer, partition };
      const before = await checkpoint(consumer, partition);
      const bulkBefore = writes.length;
      fault = mode;
      const failure = await relay.run(partition).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(injected, 'default production indexer must call native analysis before any bulk').toBe(
        mode === 'throw' ? 1 : 2,
      );
      expect(failure, 'failed or invalid native normalization must reject the drain').toBeInstanceOf(Error);
      expect(writes.length).toBe(bulkBefore);
      expect(await checkpoint(consumer, partition)).toBe(before);
      await relay.run(partition);
      expect(await checkpoint(consumer, partition)).toBeGreaterThan(before);
    }
    watching = undefined;
    // Merely updating the old mapping did not repair its historical oversized doc value.
    expect((await get(old, overflowId!))?.fields?.name_sort).toEqual([full]);
    // Remove the disposable relay target: replay must prepare an EMPTY new generation,
    // rather than pass by conflicting with documents this test has already prepared.
    await search.request('DELETE', `/${index}`);
    const beforeReplay = writes.length;
    runner = await startSearchIndexing({
      pool,
      search: transport,
      source,
      listing,
      prefix,
      intervalMs: 20,
      discoverMs: 50,
    });
    expect(
      await rebuildSubjects({ pool, search: transport, source, prefix, runner, pollMs: 20, timeoutMs: 60_000 }),
    ).toEqual({ generation: 2, previous: 1 });
    expect(
      writes.slice(beforeReplay).some(({ lines }) => lines.some((line) => (line as any).index?._index === index)),
    ).toBe(true);
    await verify(subjectAlias(prefix));
    for (const secret of [
      'hidden private sort evidence',
      'taken down private sort evidence',
      labels.has(mergeA) ? 'surviving merge label' : 'redirect private sort evidence',
    ])
      expect(analysisInputs.some((input) => input.includes(secret))).toBe(false);
  } finally {
    try {
      await runner?.stop();
    } finally {
      try {
        for (const generation of (await subjectGenerations(search, prefix)).generations)
          await search.request('DELETE', `/${subjectIndexName(prefix, generation)}`);
      } finally {
        await driver.close();
      }
    }
  }
}, 600_000);
