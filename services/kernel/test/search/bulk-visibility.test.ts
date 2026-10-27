import { expect, test } from 'bun:test';
import { bulkLines, type IndexAction } from '../../src/search/document.ts';
import { IndexWriteError } from '../../src/search/indexer.ts';
import { createOpenSearch, OpenSearchError, type OpenSearch } from '../../src/search/opensearch.ts';
import { writeIndexActions } from '../../src/search/write-actions.ts';

const url = process.env.OPENSEARCH_URL;
if (!url) throw new Error("OPENSEARCH_URL must name the check's OpenSearch node");
const search = createOpenSearch(url, { timeoutMs: 15_000 });
type Bulk = { items: Record<string, { status: number; error?: { type: string } }>[] };
type Hits = { hits: { hits: { _id: string; _version: number; _source: unknown }[] } };

function action(id: string, version = 7n): IndexAction {
  return {
    op: 'index',
    id,
    version,
    document: {
      id,
      partition: 1,
      type: 'schema:Book',
      security_revision: 3,
      names: ['Full body'],
      descriptions: ['Preserve every field'],
      name_sort: 'full body',
      statements: ['schema:genre=fiction'],
      facts: [{ property: 'schema:genre', value: 'fiction', qualifiers: [] }],
      relation_facet_overflow: ['schema:author'],
      public_collection_count: 4,
    },
  };
}

async function hits(index: string) {
  return (await search.request<Hits>('POST', `/${index}/_search`, { size: 100, version: true })).body.hits.hits;
}

async function fixture(run: (index: string, owned: Promise<unknown>[]) => Promise<void>, shards = 1) {
  const index = `test-bulk-visibility-${crypto.randomUUID()}`;
  const owned: Promise<unknown>[] = [];
  await search.request('PUT', `/${index}`, {
    settings: { number_of_shards: shards, number_of_replicas: 0, refresh_interval: '-1' },
  });
  try {
    await run(index, owned);
  } finally {
    // Restore and refresh only this disposable index; drain all writes before deleting it.
    try {
      await search.request('PUT', `/${index}/_settings`, { index: { refresh_interval: '1s' } });
      await search.request('POST', `/${index}/_refresh`);
    } finally {
      await Promise.allSettled(owned);
      await search.request('DELETE', `/${index}`);
    }
  }
}

async function pendingWinner(index: string, actions: IndexAction[], owned: Promise<unknown>[]) {
  let settled = false;
  const promise = search.bulk<Bulk>(bulkLines(index, actions), { query: { refresh: 'wait_for' } });
  owned.push(promise);
  void promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  const deadline = Date.now() + 5_000;
  for (const item of actions) {
    while (true) {
      try {
        const result = await search.request<{ _version: number }>('GET', `/${index}/_doc/${item.id}`);
        if (result.body._version === Number(item.version)) break;
      } catch (error) {
        if (!(error instanceof OpenSearchError) || error.status !== 404) throw error;
      }
      if (Date.now() >= deadline) throw new Error('Winning version did not reach realtime GET');
      await Bun.sleep(10);
    }
  }
  expect(await hits(index)).toEqual([]);
  expect(settled).toBe(false);
  return { promise, settled: () => settled };
}

// All positive responses and versions come from the native node. Only negative boundary
// cases corrupt an actual transport result, after executing the real operation.
function boundary(options: {
  bulk?: (body: unknown) => unknown;
  refresh?: (response: { status: number; body: unknown }) => { status: number; body: unknown };
  refreshFailure?: Error;
  observe?: (body: Bulk) => void;
}): OpenSearch {
  return {
    async bulk<T>(lines: readonly unknown[], requestOptions?: Parameters<OpenSearch['bulk']>[1]): Promise<T> {
      const body = await search.bulk<Bulk>(lines, requestOptions);
      options.observe?.(body);
      return (options.bulk ? options.bulk(body) : body) as T;
    },
    async request<T>(
      method: Parameters<OpenSearch['request']>[0],
      path: string,
      body?: unknown,
      requestOptions?: Parameters<OpenSearch['request']>[3],
    ) {
      const result = await search.request(method, path, body, requestOptions);
      if (/^\/test-bulk-visibility-[^/]+\/_refresh$/.test(path)) {
        if (options.refreshFailure) throw options.refreshFailure;
        return (options.refresh ? options.refresh(result) : result) as { status: number; body: T };
      }
      return result as { status: number; body: T };
    },
  };
}

test('a same-version conflict proves independent winning data searchable before successful return', async () => {
  await fixture(async (index, owned) => {
    const original = action('winner');
    const winner = await pendingWinner(index, [original], owned);
    let conflict = false;
    await writeIndexActions(
      boundary({
        observe(body) {
          expect(body.items[0]?.index?.status).toBe(409);
          expect(body.items[0]?.index?.error?.type).toBe('version_conflict_engine_exception');
          conflict = true;
        },
      }),
      index,
      [action('winner')],
    );
    expect(conflict).toBe(true);
    expect(await hits(index)).toEqual([
      expect.objectContaining({
        _id: original.id,
        _version: Number(original.version),
        _source: original.op === 'index' ? original.document : null,
      }),
    ]);
    expect((await winner.promise).items[0]?.index?.status).toBe(201);
    expect(winner.settled()).toBe(true);
  });
}, 30_000);

test('complete native success retains exact external versions and full bodies', async () => {
  await fixture(async (index, owned) => {
    const item = action('complete', 123456789n);
    // This case allows automatic refresh only on its own disposable index.
    await search.request('PUT', `/${index}/_settings`, { index: { refresh_interval: '100ms' } });
    const write = writeIndexActions(search, index, [item]);
    owned.push(write);
    await write;
    expect(await hits(index)).toEqual([
      expect.objectContaining({
        _id: item.id,
        _version: Number(item.version),
        _source: item.op === 'index' ? item.document : null,
      }),
    ]);
  });
}, 30_000);

test('mixed success and conflict waits for independently winning data on every shard', async () => {
  await fixture(async (index, owned) => {
    const ids: string[] = [];
    const shardIds = new Set<number>();
    for (let n = 0; shardIds.size < 2 && n < 100; n++) {
      const id = `shard-${n}`;
      const response = await search.request<{ shards: { shard: number }[][] }>(
        'GET',
        `/${index}/_search_shards`,
        undefined,
        { query: { routing: id } },
      );
      const shard = response.body.shards[0]![0]!.shard;
      if (!shardIds.has(shard)) {
        shardIds.add(shard);
        ids.push(id);
      }
    }
    expect(shardIds.size).toBe(2);
    const winners = ids.map((id) => action(id));
    const winner = await pendingWinner(index, winners, owned);
    let observed = false;
    const write = writeIndexActions(
      boundary({
        observe(body) {
          const statuses = body.items.map((item) => Object.values(item)[0]!.status);
          expect(statuses.filter((status) => status === 409)).toHaveLength(2);
          expect(statuses).toContain(201);
          observed = true;
        },
      }),
      index,
      [...winners, action('new-document')],
    );
    owned.push(write);
    // A native refresh=true write refreshes only its own shard, unlike index _refresh.
    // Two independent winners guarantee another shard still needs a visibility proof.
    const deadline = Date.now() + 5_000;
    while (true) {
      try {
        await search.request('GET', `/${index}/_doc/new-document`);
        break;
      } catch (error) {
        if (!(error instanceof OpenSearchError) || error.status !== 404) throw error;
      }
      if (Date.now() >= deadline) throw new Error('Mixed bulk was not accepted');
      await Bun.sleep(10);
    }
    await search.bulk(bulkLines(index, [action('new-document', 8n)]), { query: { refresh: true } });
    await write;
    expect(observed).toBe(true);
    expect((await hits(index)).map((hit) => hit._id).sort()).toEqual([...ids, 'new-document'].sort());
    await winner.promise;
  }, 2);
}, 30_000);

for (const [name, corrupt] of [
  ['missing items', () => ({})],
  ['empty items', () => ({ items: [] })],
  ['malformed item', () => ({ items: [null] })],
  ['missing status', () => ({ items: [{ index: {} }] })],
  ['wrong operation', () => ({ items: [{ delete: { status: 200 } }] })],
  ['success with error', () => ({ items: [{ index: { status: 200, error: { type: 'internal_error' } } }] })],
  ['unrelated conflict', () => ({ items: [{ index: { status: 409, error: { type: 'unrelated' } } }] })],
  ['unrelated failure', () => ({ items: [{ index: { status: 500, error: { type: 'internal_error' } } }] })],
] as const) {
  test(`native bulk boundary rejects ${name}`, async () => {
    await fixture(async (index) => {
      await search.bulk(bulkLines(index, [action('existing')]), { query: { refresh: true } });
      await expect(writeIndexActions(boundary({ bulk: corrupt }), index, [action('existing')])).rejects.toBeInstanceOf(
        IndexWriteError,
      );
    });
  });
}

for (const [name, corrupt] of [
  ['absent shards', () => ({})],
  ['failed shard', () => ({ _shards: { total: 2, successful: 1, failed: 1 } })],
  ['incomplete shards', () => ({ _shards: { total: 2, successful: 1, failed: 0 } })],
  ['malformed shards', () => ({ _shards: { total: '1', successful: 1, failed: 0 } })],
  ['zero shards', () => ({ _shards: { total: 0, successful: 0, failed: 0 } })],
] as const) {
  test(`conflict visibility rejects refresh with ${name}`, async () => {
    await fixture(async (index, owned) => {
      await pendingWinner(index, [action('existing')], owned);
      await expect(
        writeIndexActions(boundary({ refresh: (result) => ({ ...result, body: corrupt() }) }), index, [
          action('existing'),
        ]),
      ).rejects.toBeInstanceOf(IndexWriteError);
    });
  }, 30_000);
}

test('failed physical refresh propagates the native transport error', async () => {
  await fixture(async (index, owned) => {
    await pendingWinner(index, [action('existing')], owned);
    const failure = new Error('refresh transport disconnected');
    await expect(writeIndexActions(boundary({ refreshFailure: failure }), index, [action('existing')])).rejects.toBe(
      failure,
    );
  });
}, 30_000);

test('native missing-document delete succeeds but an absent physical index rejects', async () => {
  await fixture(async (index) => {
    await search.request('PUT', `/${index}/_settings`, { index: { refresh_interval: '100ms' } });
    const deletion: IndexAction = { op: 'delete', id: 'absent', version: 7n };
    let observed = false;
    await writeIndexActions(
      boundary({
        observe(body) {
          expect(body.items[0]?.delete?.status).toBe(404);
          expect(body.items[0]?.delete?.error).toBeUndefined();
          observed = true;
        },
      }),
      index,
      [deletion],
    );
    expect(observed).toBe(true);
    // Preserve a real native index_not_found error in a negative bulk-boundary injection.
    // External-version deletes may auto-create an index, so use GET to obtain the error.
    let missing: OpenSearchError | undefined;
    try {
      await search.request('GET', `/${index}-missing/_doc/absent`);
    } catch (error) {
      if (!(error instanceof OpenSearchError)) throw error;
      missing = error;
    }
    expect(missing?.status).toBe(404);
    expect(missing?.type).toBe('index_not_found_exception');
    const nativeError = (missing!.body as { error: unknown }).error;
    await expect(
      writeIndexActions(
        boundary({
          bulk(body) {
            const response = body as Bulk;
            return {
              ...response,
              items: [
                {
                  delete: {
                    ...response.items[0]!.delete,
                    status: missing!.status,
                    error: nativeError,
                  },
                },
              ],
            };
          },
        }),
        index,
        [{ ...deletion, version: 8n }],
      ),
    ).rejects.toBeInstanceOf(IndexWriteError);
  });
}, 30_000);
