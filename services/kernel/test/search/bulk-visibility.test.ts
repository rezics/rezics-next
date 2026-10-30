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

// Receipt evidence includes the actual submitted order and unmodified native result.
// Corruptions below change only a clone, after the real write has completed.
type Receipt = { errors: boolean; items: Record<string, Record<string, unknown>>[] };
function receiptBoundary(options: { corrupt?: (body: Receipt) => void; lost?: boolean } = {}) {
  const calls: { lines: readonly unknown[]; options: unknown; native: Receipt; returned: Receipt }[] = [];
  const requests: string[] = [];
  const engine: OpenSearch = {
    async bulk<T>(lines: readonly unknown[], requestOptions?: Parameters<OpenSearch['bulk']>[1]) {
      const native = await search.bulk<Receipt>(lines, requestOptions);
      const returned = structuredClone(native);
      options.corrupt?.(returned);
      calls.push({ lines: structuredClone(lines), options: requestOptions, native, returned });
      if (options.lost) throw new Error('native response lost after write');
      return returned as T;
    },
    async request<T>(...args: Parameters<OpenSearch['request']>) {
      requests.push(`${args[0]} ${args[1]}`);
      return search.request<T>(...args);
    },
  };
  return { engine, calls, requests };
}

async function recordedWrite(index: string, actions: IndexAction[], control = receiptBoundary()) {
  try {
    await writeIndexActions(control.engine, index, actions);
  } finally {
    console.info('native keyed receipt', JSON.stringify({ index, ...control, engine: undefined }));
  }
  return control;
}

function itemAt(body: Receipt, n = 0) {
  return Object.values(body.items[n]!)[0]!;
}

test('native keyed lifecycle binds ordered multi-key index, replacement, delete and missing delete', async () => {
  await fixture(async (index) => {
    await search.request('PUT', `/${index}/_settings`, { index: { refresh_interval: '100ms' } });
    const initial = [action('z-last-lexically', 123456789n), action('a-first-lexically', 17n)];
    const first = await recordedWrite(index, initial);
    expect(first.calls[0]!.native.errors).toBe(false);
    expect(first.calls[0]!.native.items.map((item) => item.index!._id)).toEqual(initial.map((item) => item.id));
    expect(first.calls[0]!.native.items.map((item) => item.index!._version)).toEqual([123456789, 17]);
    expect(first.requests).toEqual([]);
    for (const item of initial) {
      expect((await hits(index)).find((hit) => hit._id === item.id)).toMatchObject({
        _version: Number(item.version),
        _source: item.op === 'index' ? item.document : null,
      });
    }
    const replacement = action(initial[0]!.id, BigInt(Number.MAX_SAFE_INTEGER));
    if (replacement.op === 'index') replacement.document.descriptions = ['Native replacement, complete body'];
    const replaced = await recordedWrite(index, [replacement]);
    expect(itemAt(replaced.calls[0]!.native)).toMatchObject({ status: 200, result: 'updated' });
    expect((await hits(index)).find((hit) => hit._id === replacement.id)).toMatchObject({
      _version: Number.MAX_SAFE_INTEGER,
      _source: replacement.op === 'index' ? replacement.document : null,
    });
    const deletions: IndexAction[] = [
      { op: 'delete', id: initial[1]!.id, version: 18n },
      { op: 'delete', id: 'never-existed', version: 18n },
    ];
    const deleted = await recordedWrite(index, deletions);
    expect(
      deleted.calls[0]!.native.items.map((item) => [item.delete!._id, item.delete!.status, item.delete!.result]),
    ).toEqual([
      [initial[1]!.id, 200, 'deleted'],
      ['never-existed', 404, 'not_found'],
    ]);
    expect((await hits(index)).map((hit) => hit._id)).toEqual([replacement.id]);
    expect(deleted.requests).toEqual([]);
    const mixedActions: IndexAction[] = [
      action('mixed-z', 2n),
      { op: 'delete', id: 'never-existed', version: 19n },
      action('mixed-a', 3n),
    ];
    const mixed = await recordedWrite(index, mixedActions);
    expect(mixed.calls[0]!.native.items.map((item) => Object.keys(item)[0])).toEqual(['index', 'delete', 'index']);
    expect(mixed.calls[0]!.native.items.map((item) => Object.values(item)[0]!._id)).toEqual(
      mixedActions.map((item) => item.id),
    );
    expect(mixed.requests).toEqual([]);
    for (const control of [first, replaced, deleted, mixed]) {
      expect(control.calls).toHaveLength(1);
      expect(control.calls[0]!.options).toEqual({ query: { refresh: 'wait_for' } });
      for (const item of control.calls[0]!.native.items) {
        const result = Object.values(item)[0]!;
        expect(result._index).toBe(index);
        expect(result._shards).toEqual({ total: 1, successful: 1, failed: 0 });
        expect(Number.isSafeInteger(result._seq_no)).toBe(true);
        expect(result._primary_term).toBeGreaterThan(0);
      }
    }
  });
}, 30_000);

test('equal and newer independent native winners retain their bodies behind aligned conflict receipts', async () => {
  await fixture(async (index, owned) => {
    const winners = [action('equal', 10n), action('newer', 12n)];
    const pending = await pendingWinner(index, winners, owned);
    const control = await recordedWrite(index, [action('equal', 10n), action('newer', 11n)]);
    expect(control.requests).toEqual([`POST /${index}/_refresh`]);
    expect(control.calls[0]!.native.errors).toBe(true);
    for (const [n, winner] of winners.entries()) {
      expect(itemAt(control.calls[0]!.native, n)).toMatchObject({
        _id: winner.id,
        _index: index,
        status: 409,
        error: { type: 'version_conflict_engine_exception' },
      });
      expect(itemAt(control.calls[0]!.native, n)._version).toBeUndefined();
      expect((await hits(index)).find((hit) => hit._id === winner.id)).toMatchObject({
        _version: Number(winner.version),
        _source: winner.op === 'index' ? winner.document : null,
      });
    }
    await pending.promise;
    expect(pending.settled()).toBe(true);
  });
}, 30_000);

const receiptCorruptions: [string, (body: Receipt) => void][] = [
  ...['_id', '_index', '_version', 'result', '_seq_no', '_primary_term', '_shards'].map(
    (key): [string, (body: Receipt) => void] => [
      `missing ${key}`,
      (body) => {
        delete itemAt(body)[key];
      },
    ],
  ),
  [
    'foreign id',
    (body) => {
      itemAt(body)._id = 'foreign';
    },
  ],
  [
    'foreign index',
    (body) => {
      itemAt(body)._index = 'foreign-index';
    },
  ],
  [
    'foreign version',
    (body) => {
      itemAt(body)._version = 6;
    },
  ],
  [
    'newer version is not this success',
    (body) => {
      itemAt(body)._version = 8;
    },
  ],
  [
    'string version',
    (body) => {
      itemAt(body)._version = '7';
    },
  ],
  [
    'unsafe version',
    (body) => {
      itemAt(body)._version = Number.MAX_SAFE_INTEGER + 1;
    },
  ],
  [
    'fractional version',
    (body) => {
      itemAt(body)._version = 7.5;
    },
  ],
  [
    'duplicate item',
    (body) => {
      body.items[1] = structuredClone(body.items[0]!);
    },
  ],
  [
    'reordered items',
    (body) => {
      body.items.reverse();
    },
  ],
  [
    'partial response',
    (body) => {
      body.items.pop();
    },
  ],
  [
    'extra item',
    (body) => {
      body.items.push(structuredClone(body.items[0]!));
    },
  ],
  [
    'wrong operation',
    (body) => {
      body.items[0] = { delete: itemAt(body) };
    },
  ],
  [
    'ambiguous operation',
    (body) => {
      body.items[0]!.delete = structuredClone(itemAt(body));
    },
  ],
  [
    'malformed error flag',
    (body) => {
      Object.assign(body, { errors: 'false' });
    },
  ],
  [
    'contradictory top-level errors',
    (body) => {
      body.errors = true;
    },
  ],
  [
    'success with native error',
    (body) => {
      itemAt(body).error = { type: 'version_conflict_engine_exception' };
    },
  ],
  [
    'wrong result',
    (body) => {
      itemAt(body).result = 'deleted';
    },
  ],
  [
    'wrong result status',
    (body) => {
      itemAt(body).status = 200;
    },
  ],
  [
    'negative sequence',
    (body) => {
      itemAt(body)._seq_no = -1;
    },
  ],
  [
    'unsafe sequence',
    (body) => {
      itemAt(body)._seq_no = Number.MAX_SAFE_INTEGER + 1;
    },
  ],
  [
    'zero primary term',
    (body) => {
      itemAt(body)._primary_term = 0;
    },
  ],
  [
    'malformed forced refresh',
    (body) => {
      itemAt(body).forced_refresh = 'true';
    },
  ],
  [
    'failed shard',
    (body) => {
      itemAt(body)._shards = { total: 2, successful: 1, failed: 1 };
    },
  ],
  [
    'partial shards without failure',
    (body) => {
      itemAt(body)._shards = { total: 2, successful: 1, failed: 0 };
    },
  ],
  [
    'zero shards',
    (body) => {
      itemAt(body)._shards = { total: 0, successful: 0, failed: 0 };
    },
  ],
  [
    'contradictory shard failures',
    (body) => {
      itemAt(body)._shards = { total: 1, successful: 1, failed: 0, failures: [{}] };
    },
  ],
];
for (const [name, corrupt] of receiptCorruptions) {
  test(`executed native keyed success rejects ${name}`, async () => {
    await fixture(async (index) => {
      await search.request('PUT', `/${index}/_settings`, { index: { refresh_interval: '100ms' } });
      const submitted = [action('ordered-second'), action('ordered-first')];
      const control = receiptBoundary({ corrupt });
      await expect(recordedWrite(index, submitted, control)).rejects.toBeInstanceOf(IndexWriteError);
      expect(control.calls).toHaveLength(1);
      expect(control.calls[0]!.native.items.map((item) => item.index!._id)).toEqual(submitted.map((item) => item.id));
      expect(control.requests).toEqual([]);
      expect((await hits(index)).map((hit) => [hit._id, hit._version]).sort()).toEqual([
        ['ordered-first', 7],
        ['ordered-second', 7],
      ]);
    });
  }, 30_000);
}

for (const [name, corrupt] of [
  [
    'foreign conflict id',
    (body: Receipt) => {
      itemAt(body)._id = 'foreign';
    },
  ],
  [
    'missing conflict index',
    (body: Receipt) => {
      delete itemAt(body)._index;
    },
  ],
  [
    'foreign conflict index',
    (body: Receipt) => {
      itemAt(body)._index = 'foreign';
    },
  ],
  [
    'duplicate conflicts',
    (body: Receipt) => {
      body.items[1] = structuredClone(body.items[0]!);
    },
  ],
  [
    'reordered conflicts',
    (body: Receipt) => {
      body.items.reverse();
    },
  ],
  [
    'contradictory conflict errors',
    (body: Receipt) => {
      body.errors = false;
    },
  ],
  [
    'conflict with success metadata',
    (body: Receipt) => {
      itemAt(body)._version = 7;
    },
  ],
  [
    'missing conflict reason',
    (body: Receipt) => {
      delete (itemAt(body).error as Record<string, unknown>).reason;
    },
  ],
  [
    'foreign engine error index',
    (body: Receipt) => {
      (itemAt(body).error as Record<string, unknown>).index = 'foreign';
    },
  ],
  [
    'missing native shard',
    (body: Receipt) => {
      delete (itemAt(body).error as Record<string, unknown>).shard;
    },
  ],
  [
    'missing native index uuid',
    (body: Receipt) => {
      delete (itemAt(body).error as Record<string, unknown>).index_uuid;
    },
  ],
] as const) {
  test(`executed native conflict rejects ${name} before any refresh`, async () => {
    await fixture(async (index) => {
      const submitted = [action('one'), action('two')];
      await search.bulk(bulkLines(index, submitted), { query: { refresh: true } });
      const control = receiptBoundary({ corrupt });
      await expect(recordedWrite(index, submitted, control)).rejects.toBeInstanceOf(IndexWriteError);
      expect(control.calls[0]!.native.items.every((item) => item.index!.status === 409)).toBe(true);
      expect(control.requests).toEqual([]);
    });
  });
}

test('native delete conflicts and missing-delete metadata cannot fabricate a successful deletion', async () => {
  await fixture(async (index) => {
    await search.request('PUT', `/${index}/_settings`, { index: { refresh_interval: '100ms' } });
    const deletion: IndexAction = { op: 'delete', id: 'deleted-key', version: 7n };
    await recordedWrite(index, [action(deletion.id, 6n), action('independent', 9n)]);
    await recordedWrite(index, [deletion]);
    const replay = await recordedWrite(index, [deletion, { op: 'delete', id: 'independent', version: 8n }]);
    expect(replay.calls[0]!.native.items.every((item) => item.delete!.status === 409)).toBe(true);
    expect(replay.requests).toEqual([`POST /${index}/_refresh`]);
    expect((await hits(index)).map((hit) => [hit._id, hit._version])).toEqual([['independent', 9]]);
    for (const corrupt of [
      (body: Receipt) => {
        itemAt(body).result = 'deleted';
      },
      (body: Receipt) => {
        delete itemAt(body)._version;
      },
      (body: Receipt) => {
        itemAt(body)._id = 'independent';
      },
    ]) {
      const control = receiptBoundary({ corrupt });
      await expect(
        recordedWrite(index, [{ op: 'delete', id: crypto.randomUUID(), version: 10n }], control),
      ).rejects.toBeInstanceOf(IndexWriteError);
      expect(itemAt(control.calls[0]!.native)).toMatchObject({ status: 404, result: 'not_found', _version: 10 });
    }
  });
}, 30_000);

test('fixed keyed actions retain one bulk and at most one conflict refresh at three unrelated populations', async () => {
  const work: unknown[] = [];
  for (const population of [4, 32, 256]) {
    await fixture(async (index) => {
      await search.request('PUT', `/${index}/_settings`, { index: { refresh_interval: '100ms' } });
      await search.bulk(
        bulkLines(
          index,
          Array.from({ length: population }, (_, n) => action(`unrelated-${n}`)),
        ),
        {
          query: { refresh: true },
        },
      );
      const submitted = [action('fixed-one'), action('fixed-two')];
      const success = await recordedWrite(index, submitted);
      const conflict = await recordedWrite(index, submitted);
      const rejected = receiptBoundary({
        corrupt(body) {
          itemAt(body)._index = 'foreign';
        },
      });
      await expect(recordedWrite(index, submitted, rejected)).rejects.toBeInstanceOf(IndexWriteError);
      const lost = receiptBoundary({ lost: true });
      await expect(recordedWrite(index, [action('lost', 9n)], lost)).rejects.toThrow(
        'native response lost after write',
      );
      expect((await hits(index)).find((hit) => hit._id === 'lost')).toMatchObject({ _version: 9 });
      const replay = await recordedWrite(index, [action('lost', 9n)]);
      for (const control of [success, conflict, rejected, lost, replay]) expect(control.calls).toHaveLength(1);
      for (const control of [success, conflict, rejected]) {
        expect(control.calls[0]!.lines).toEqual(bulkLines(index, submitted));
        expect(control.calls[0]!.native.items).toHaveLength(submitted.length);
      }
      expect(success.requests).toEqual([]);
      expect(conflict.requests).toEqual([`POST /${index}/_refresh`]);
      expect(rejected.requests).toEqual([]);
      expect(lost.requests).toEqual([]);
      expect(replay.requests).toEqual([`POST /${index}/_refresh`]);
      work.push({
        population,
        actions: submitted.length,
        operations: [success, conflict, rejected, lost, replay].map((control) => ({
          bulkCalls: control.calls.length,
          refreshCalls: control.requests.length,
          requestBytes: Buffer.byteLength(
            control.calls[0]!.lines.map((line) => JSON.stringify(line)).join('\n') + '\n',
          ),
          parsedResponseBytes: Buffer.byteLength(JSON.stringify(control.calls[0]!.native)),
          items: control.calls[0]!.native.items.length,
        })),
        success,
        conflict,
        rejected,
        lost,
        replay,
      });
    });
  }
  console.info('keyed adapter growth raw work', JSON.stringify(work));
}, 60_000);

for (const name of ['non-success HTTP status', 'contradictory failures', 'missing successful count']) {
  test(`a real winner refresh cannot acknowledge ${name}`, async () => {
    await fixture(async (index, owned) => {
      await pendingWinner(index, [action('pending')], owned);
      const evidence: unknown[] = [];
      try {
        await expect(
          writeIndexActions(
            boundary({
              refresh(native) {
                const returned = structuredClone(native);
                const shards = (returned.body as { _shards: Record<string, unknown> })._shards;
                if (name === 'non-success HTTP status') returned.status = 500;
                else if (name === 'contradictory failures') shards.failures = [{}];
                else delete shards.successful;
                evidence.push({ native, returned });
                return returned;
              },
            }),
            index,
            [action('pending')],
          ),
        ).rejects.toBeInstanceOf(IndexWriteError);
        expect(evidence).toHaveLength(1);
      } finally {
        console.info('native conflict refresh evidence', JSON.stringify(evidence));
      }
    });
  }, 30_000);
}
