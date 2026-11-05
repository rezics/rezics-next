import { afterAll, expect, test } from 'bun:test';
import pg from 'pg';
import { createPool } from '../../src/database/pool.ts';
import { createSubjectIndexer } from '../../src/search/indexer.ts';
import { createSubjectIndex, subjectGenerations, subjectIndexName } from '../../src/search/indices.ts';
import { createOpenSearch, type OpenSearch } from '../../src/search/opensearch.ts';
import {
  subjectPartition,
  type IndexedSubject,
  type SubjectSnapshot,
  type SubjectSource,
} from '../../src/search/source.ts';

const databaseUrl = process.env.DATABASE_URL;
const searchUrl = process.env.OPENSEARCH_URL;
if (!databaseUrl || !searchUrl)
  throw new Error('DATABASE_URL and OPENSEARCH_URL must name the check database and node');
const pool = createPool(databaseUrl);
const admin = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const search = createOpenSearch(searchUrl);
const invalidation = 'com.rezics.subject.relation_facet_changed.v1';
const prefixes: string[] = [];
const listing = { read: async () => new Map<string, number>() };

afterAll(async () => {
  for (const prefix of prefixes) {
    const { generations } = await subjectGenerations(search, prefix);
    for (const generation of generations) await search.request('DELETE', `/${subjectIndexName(prefix, generation)}`);
  }
  await pool.end();
  await admin.end();
});

async function fixture() {
  const prefix = `test-${crypto.randomUUID().slice(0, 8)}-`;
  prefixes.push(prefix);
  await createSubjectIndex(search, prefix, 1);
  return { index: subjectIndexName(prefix, 1), consumer: `relation_${crypto.randomUUID().replaceAll('-', '')}` };
}

const id = (partition: number, n: number) =>
  `018f0000-0000-7000-8000-${(partition * 16).toString(16).padStart(4, '0')}${String(n).padStart(8, '0')}`;
const subject = (partition: number, n: number): IndexedSubject => ({
  id: id(partition, n),
  type: 'schema:Book',
  visibility: 'visible',
  redirect: null,
  securityRevision: 1,
  labels: [{ language: 'en', value: `Book ${n}` }],
  aliases: [],
  descriptions: [],
  statements: [],
});

// Only append log envelopes. Relation production, target routing and witness work belong to semantic.
async function append(
  partition: number,
  subjectId: string,
  type = invalidation,
  data: unknown = { phase: 'requested', generation: '1' },
): Promise<bigint> {
  const client = await admin.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ epoch: number; position: string }>(
      'UPDATE core.partition SET position = position + 1 WHERE partition_no = $1 RETURNING epoch, position::text',
      [partition],
    );
    const head = rows[0]!;
    await client.query(
      `INSERT INTO core.outbox (partition_no, position, event_seq, event_count, epoch, id, type, subject, data)
       VALUES ($1, $2, 0, 1, $3, $4, $5, $6, $7::jsonb)`,
      [partition, head.position, head.epoch, crypto.randomUUID(), type, subjectId, JSON.stringify(data)],
    );
    await client.query('COMMIT');
    return BigInt(head.position);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function checkpoint(consumer: string, partition: number) {
  const { rows } = await admin.query<{ position: string }>(
    'SELECT position::text FROM core.consumer_checkpoint WHERE partition_no = $1 AND consumer = $2',
    [partition, consumer],
  );
  return rows[0]?.position ?? null;
}

function controlledSource(initial: IndexedSubject) {
  let current = initial;
  let replay: SubjectSnapshot | undefined;
  const reads: { partition: number; ids: string[] }[] = [];
  const source: SubjectSource = {
    async read(partition, ids) {
      reads.push({ partition, ids: [...ids] });
      expect(partition).toBe(subjectPartition(initial.id));
      expect(ids).toEqual([initial.id]);
      if (replay) return replay;
      const { rows } = await admin.query<{ position: string }>(
        'SELECT position::text FROM core.partition WHERE partition_no = $1',
        [partition],
      );
      return { partition, position: BigInt(rows[0]!.position), subjects: [current] };
    },
    async count() {
      throw new Error('Log consumption must not scan the source');
    },
  };
  return {
    source,
    reads,
    put(value: IndexedSubject) {
      current = value;
    },
    replay(snapshot: SubjectSnapshot) {
      replay = snapshot;
    },
  };
}

type BulkResult = { items: { index: { status: number; error?: { type: string } } }[] };
function observeEngine(index: string, consumer: string, partition: number) {
  const bulks: { lines: readonly unknown[]; result: BulkResult }[] = [];
  let before = '0';
  let visibleId: string | undefined;
  const engine: OpenSearch = {
    request: search.request,
    async bulk<T>(lines: readonly unknown[], options?: Parameters<OpenSearch['bulk']>[1]): Promise<T> {
      expect(options?.query?.refresh).toBe('wait_for');
      expect(await checkpoint(consumer, partition)).toBe(before);
      const result = await search.bulk<BulkResult>(lines, options);
      bulks.push({ lines, result });
      // Inspect real search visibility while the response is still withheld from projectBatch.
      if (visibleId && result.items.every((item) => item.index.status < 300 || item.index.status === 409)) {
        const visible = await search.request<{ hits: { hits: { _id: string; _source: unknown }[] } }>(
          'POST',
          `/${index}/_search`,
          {
            query: { ids: { values: [visibleId] } },
          },
        );
        expect(visible.body.hits.hits.map((hit) => hit._id)).toEqual([visibleId]);
        if (result.items[0]!.index.status < 300) expect(visible.body.hits.hits[0]!._source).toEqual(lines[1]);
      }
      expect(await checkpoint(consumer, partition)).toBe(before);
      return result as T;
    },
  };
  return {
    engine,
    bulks,
    expectCheckpoint(position: string, id?: string) {
      before = position;
      visibleId = id;
    },
  };
}

test('registered relation facet invalidations refresh only the anchor source and coalesce at sizes 1, 4 and 16', async () => {
  const { index, consumer } = await fixture();
  const partition = 141;
  const original = subject(partition, 1);
  const target = subject(142, 1);
  const source = controlledSource(original);
  const writes = observeEngine(index, consumer, partition);
  const relay = createSubjectIndexer({ pool, search: writes.engine, source: source.source, listing, index, consumer });
  const initialPosition = await append(partition, original.id, 'com.rezics.subject.created.v1', { id: original.id });
  writes.expectCheckpoint('0', original.id);
  expect(await relay.run(partition)).toMatchObject({ status: 'read', envelopes: 1 });
  const newest: IndexedSubject = {
    ...original,
    labels: [{ language: 'en', value: 'Newest anchor snapshot' }],
    statements: [{ property: 'schema:author', value: target.id, facet: { kind: 'item' } }],
    relationFacetOverflow: ['schema:author'],
  };
  source.put(newest);
  let previous = initialPosition;
  const costs: { reads: number; bulks: number; lines: number }[] = [];
  for (const size of [1, 4, 16]) {
    const readsBefore = source.reads.length;
    const bulksBefore = writes.bulks.length;
    for (let n = 0; n < size; n++) await append(partition, original.id);
    // Ordinary semantic metadata may mention both ids without requesting either document.
    await append(partition, target.id, 'com.rezics.semantic.links.projected.v1', {
      subjects: [original.id, target.id],
    });
    const position = await append(partition, target.id);
    writes.expectCheckpoint(String(previous), original.id);
    expect(await relay.run(partition)).toMatchObject({ status: 'read', envelopes: size + 2, position });
    costs.push({
      reads: source.reads.length - readsBefore,
      bulks: writes.bulks.length - bulksBefore,
      lines: writes.bulks.at(-1)!.lines.length,
    });
    expect(source.reads.at(-1)).toEqual({ partition, ids: [original.id] });
    expect(writes.bulks.at(-1)!.lines[0]).toEqual({
      index: { _index: index, _id: original.id, version: Number(position), version_type: 'external' },
    });
    const stored = await search.request<{ _version: number; _source: Record<string, unknown> }>(
      'GET',
      `/${index}/_doc/${original.id}`,
    );
    expect(stored.body._version).toBe(Number(position));
    expect(stored.body._source).toMatchObject({
      names: ['Newest anchor snapshot'],
      statements: [`schema:author=${target.id}`],
      facts: [{ property: 'schema:author', value: target.id, qualifiers: [] }],
      relation_facet_overflow: ['schema:author'],
    });
    expect(await checkpoint(consumer, partition)).toBe(String(position));
    previous = position;
  }
  expect(costs).toEqual(Array.from({ length: 3 }, () => ({ reads: 1, bulks: 1, lines: 2 })));
  const missing = await search.request<{ docs: { found: boolean }[] }>('POST', `/${index}/_mget`, { ids: [target.id] });
  expect(missing.body.docs).toMatchObject([{ found: false }]);
  // An irrelevant-only batch must not even open a snapshot or make an engine request.
  await append(partition, original.id, 'com.rezics.semantic.links.projected.v1', { subjects: [target.id] });
  const end = await append(partition, target.id);
  const counts = [source.reads.length, writes.bulks.length];
  expect(await relay.run(partition)).toMatchObject({ status: 'read', envelopes: 2, position: end });
  expect([source.reads.length, writes.bulks.length]).toEqual(counts);
  expect(await checkpoint(consumer, partition)).toBe(String(end));
});

test('registered relation facet invalidations retry failed writes and replay older snapshots through real external version conflicts', async () => {
  const { index, consumer } = await fixture();
  const partition = 143;
  const original = subject(partition, 1);
  const source = controlledSource(original);
  const writes = observeEngine(index, consumer, partition);
  const relay = createSubjectIndexer({ pool, search: writes.engine, source: source.source, listing, index, consumer });
  const first = await append(partition, original.id);
  // Fail at the actual engine, then retry the same durable envelope and checkpoint.
  await search.request('POST', `/${index}/_close`);
  try {
    await expect(relay.run(partition)).rejects.toThrow();
    expect(await checkpoint(consumer, partition)).toBe('0');
    expect(source.reads).toEqual([{ partition, ids: [original.id] }]);
  } finally {
    await search.request('POST', `/${index}/_open`);
  }
  writes.expectCheckpoint('0', original.id);
  expect(await relay.run(partition)).toMatchObject({ status: 'read', envelopes: 1, position: first });
  expect(await checkpoint(consumer, partition)).toBe(String(first));
  await admin.query(
    'UPDATE core.consumer_checkpoint SET position = 0, epoch = NULL WHERE consumer = $1 AND partition_no = $2',
    [consumer, partition],
  );
  // The same envelope and equal external version also reach the engine and conflict harmlessly.
  expect(await relay.run(partition)).toMatchObject({ status: 'read', envelopes: 1, position: first });
  expect(writes.bulks.at(-1)!.result.items).toMatchObject([
    { index: { status: 409, error: { type: 'version_conflict_engine_exception' } } },
  ]);
  expect(await checkpoint(consumer, partition)).toBe(String(first));
  source.put({ ...original, labels: [{ language: 'en', value: 'Newest state' }] });
  const newestPosition = await append(partition, original.id);
  writes.expectCheckpoint(String(first), original.id);
  expect(await relay.run(partition)).toMatchObject({ status: 'read', envelopes: 1, position: newestPosition });
  const newest = await search.request('GET', `/${index}/_doc/${original.id}`);
  // Reset only the consumer checkpoint: the actual persisted events are replayed, with an older source snapshot.
  source.replay({ partition, position: first, subjects: [original] });
  await admin.query(
    'UPDATE core.consumer_checkpoint SET position = 0, epoch = NULL WHERE consumer = $1 AND partition_no = $2',
    [consumer, partition],
  );
  const readsBefore = source.reads.length;
  const bulksBefore = writes.bulks.length;
  writes.expectCheckpoint('0', original.id);
  expect(await relay.run(partition)).toMatchObject({ status: 'read', envelopes: 2, position: newestPosition });
  expect(source.reads.length - readsBefore).toBe(1);
  expect(writes.bulks.length - bulksBefore).toBe(1);
  expect(writes.bulks.at(-1)!.result.items).toMatchObject([
    { index: { status: 409, error: { type: 'version_conflict_engine_exception' } } },
  ]);
  expect((await search.request('GET', `/${index}/_doc/${original.id}`)).body).toEqual(newest.body);
  expect(await checkpoint(consumer, partition)).toBe(String(newestPosition));
});
