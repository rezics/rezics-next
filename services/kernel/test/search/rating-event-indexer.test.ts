import { afterAll, expect, test } from 'bun:test';
import pg from 'pg';
import { Compile } from 'typebox/compile';
import { GLOBAL_CONTEXT } from '../../src/access/gates/catalogue.ts';
import { runCommand, type CommandEvent } from '../../src/command/command.ts';
import { createPool } from '../../src/database/pool.ts';
import { EVENT_TYPES } from '../../src/events/log.ts';
import { STANDARD_QUESTION_ID } from '../../src/rating/votes.ts';
import { newId } from '../../src/route/route.ts';
import { createSubjectIndexer } from '../../src/search/indexer.ts';
import { createSubjectIndex, subjectIndexName } from '../../src/search/indices.ts';
import { createOpenSearch, type OpenSearch } from '../../src/search/opensearch.ts';
import type { IndexedSubject, SubjectSource } from '../../src/search/source.ts';

const databaseUrl = process.env.DATABASE_URL;
const searchUrl = process.env.OPENSEARCH_URL;
if (!databaseUrl || !searchUrl)
  throw new Error('DATABASE_URL and OPENSEARCH_URL must name the check database and node');
const pool = createPool(databaseUrl);
const admin = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const search = createOpenSearch(searchUrl);
// This proposed native event must be registered by its producer, never by this fixture.
const changed = 'com.rezics.rating.public_figure.changed.v1';
const indices: string[] = [];
const consumers: { consumer: string; partition: number }[] = [];
const commits: { partition: number; position: bigint }[] = [];

afterAll(async () => {
  try {
    for (const index of indices) await search.request('DELETE', `/${index}`);
    for (const { consumer, partition } of consumers)
      await admin.query('DELETE FROM core.consumer_checkpoint WHERE consumer = $1 AND partition_no = $2', [
        consumer,
        partition,
      ]);
    for (const { partition, position } of commits)
      await admin.query('DELETE FROM core.outbox WHERE partition_no = $1 AND position = $2', [
        partition,
        String(position),
      ]);
  } finally {
    await pool.end();
    await admin.end();
  }
});

function figure(subjectId: string) {
  return {
    questionId: STANDARD_QUESTION_ID,
    populationId: GLOBAL_CONTEXT.id,
    subjectId,
    count: 2,
    mean: 8,
    score: 7.5,
    priorEpoch: 1,
    revision: '9007199254740993',
    asOf: '2026-10-28T00:00:00.000Z',
  };
}

async function append(partition: number, events: CommandEvent[]) {
  const result = await runCommand(pool, { partition }, async () => ({ value: null, events }));
  commits.push({ partition, position: result.position });
  return result.position;
}

async function checkpoint(consumer: string, partition: number) {
  const { rows } = await admin.query<{ position: string }>(
    'SELECT position::text FROM core.consumer_checkpoint WHERE consumer = $1 AND partition_no = $2',
    [consumer, partition],
  );
  return rows[0]?.position ?? null;
}

async function visible(index: string, id: string) {
  const result = await search.request<{ hits: { hits: { _id: string; _source: { names: string[] } }[] } }>(
    'POST',
    `/${index}/_search`,
    { query: { ids: { values: [id] } } },
  );
  return result.body.hits.hits.map(({ _id, _source }) => ({ _id, _source }));
}

test('the public figure proposal uses the registered production schema, including nullable figures', () => {
  const schema = EVENT_TYPES[changed];
  expect(schema).toBeDefined();
  const validator = Compile(schema!);
  const data = figure(newId(151 * 16));
  expect(validator.Check(data)).toBe(true);
  expect(validator.Check({ ...data, count: 0, mean: null, score: null, priorEpoch: null })).toBe(true);
  expect(validator.Check({ ...data, revision: 1 })).toBe(false);
});

test('registered rating events invalidate only the anchor once per batch, retry durably and replay harmlessly', async () => {
  const partition = 151;
  const id = newId(partition * 16);
  const foreignId = newId((partition + 1) * 16);
  const prefix = `test-${crypto.randomUUID().slice(0, 8)}-`;
  const index = subjectIndexName(prefix, 1);
  await createSubjectIndex(search, prefix, 1);
  indices.push(index);
  const consumer = `rating_${crypto.randomUUID().replaceAll('-', '')}`;
  const replayConsumer = `${consumer}_replay`;
  consumers.push({ consumer, partition }, { consumer: replayConsumer, partition });
  let current: IndexedSubject = {
    id,
    type: 'schema:Book',
    visibility: 'visible',
    redirect: null,
    securityRevision: 1,
    labels: [{ language: 'en', value: 'Stale indexed name' }],
    aliases: [],
    descriptions: [],
    statements: [],
  };
  const reads: { partition: number; ids: string[] }[] = [];
  const source: SubjectSource = {
    async read(requestedPartition, ids) {
      reads.push({ partition: requestedPartition, ids: [...ids] });
      expect(requestedPartition).toBe(partition);
      expect(ids).toEqual([id]);
      const { rows } = await admin.query<{ position: string }>(
        'SELECT position::text FROM core.partition WHERE partition_no = $1',
        [requestedPartition],
      );
      return { partition: requestedPartition, position: BigInt(rows[0]!.position), subjects: [current] };
    },
    async count() {
      throw new Error('Event consumption must not scan subjects');
    },
  };
  type BulkResult = { items: { index: { status: number; error?: { type: string } } }[] };
  const bulks: { lines: readonly unknown[]; result: BulkResult }[] = [];
  let failNext = false;
  let activeConsumer = consumer;
  let before = '0';
  const engine: OpenSearch = {
    request: search.request,
    async bulk<T>(lines: readonly unknown[], options?: Parameters<OpenSearch['bulk']>[1]): Promise<T> {
      expect(options?.query?.refresh).toBe('wait_for');
      expect(await checkpoint(activeConsumer, partition)).toBe(before);
      if (failNext) {
        failNext = false;
        throw new Error('Injected rating bulk failure');
      }
      const result = await search.bulk<BulkResult>(lines, options);
      bulks.push({ lines, result });
      // The actual engine response remains withheld until search visibility is checked.
      const hits = await visible(index, id);
      expect(hits.map((hit) => hit._id)).toEqual([id]);
      expect(lines[1]).toEqual(hits[0]!._source);
      expect(await checkpoint(activeConsumer, partition)).toBe(before);
      return result as T;
    },
  };
  const options = { pool, search: engine, source, listing: { read: async () => new Map<string, number>() }, index };
  const relay = createSubjectIndexer({ ...options, consumer });
  const initial = await append(partition, [{ type: 'com.rezics.subject.created.v1', subject: id, data: { id } }]);
  expect(await relay.run(partition)).toMatchObject({ status: 'read', envelopes: 1, position: initial });
  expect((await visible(index, id))[0]!._source.names).toEqual(['Stale indexed name']);
  expect(await checkpoint(consumer, partition)).toBe(String(initial));

  current = { ...current, labels: [{ language: 'en', value: 'Current source name' }] };
  const position = await append(partition, [
    { type: changed, subject: id, data: figure(id) },
    { type: changed, subject: id, data: figure(id) },
    // Valid data and subject anchor, but not in this envelope's partition.
    { type: changed, subject: foreignId, data: figure(foreignId) },
  ]);
  before = String(initial);
  failNext = true;
  await expect(relay.run(partition)).rejects.toThrow('Injected rating bulk failure');
  expect(await checkpoint(consumer, partition)).toBe(String(initial));
  expect((await visible(index, id))[0]!._source.names).toEqual(['Stale indexed name']);
  expect(reads).toEqual(Array.from({ length: 2 }, () => ({ partition, ids: [id] })));
  expect(bulks).toHaveLength(1);

  expect(await relay.run(partition)).toMatchObject({ status: 'read', envelopes: 1, position });
  expect(reads).toEqual(Array.from({ length: 3 }, () => ({ partition, ids: [id] })));
  expect(bulks).toHaveLength(2);
  expect(bulks.at(-1)!.lines).toHaveLength(2);
  expect(bulks.at(-1)!.lines[0]).toEqual({
    index: { _index: index, _id: id, version: Number(position), version_type: 'external' },
  });
  const stored = await search.request<{ _version: number; _source: { names: string[] } }>(
    'GET',
    `/${index}/_doc/${id}`,
  );
  expect(stored.body._version).toBe(Number(position));
  expect(stored.body._source.names).toEqual(['Current source name']);
  expect(await checkpoint(consumer, partition)).toBe(String(position));
  expect(await visible(index, foreignId)).toEqual([]);

  // A fresh real consumer replays durable envelopes without forcing a checkpoint backwards.
  activeConsumer = replayConsumer;
  before = '0';
  const replay = createSubjectIndexer({ ...options, consumer: replayConsumer });
  expect(await replay.run(partition)).toMatchObject({ status: 'read', envelopes: 2, position });
  expect(reads).toEqual(Array.from({ length: 4 }, () => ({ partition, ids: [id] })));
  expect(bulks).toHaveLength(3);
  expect(bulks.at(-1)!.result.items).toMatchObject([
    { index: { status: 409, error: { type: 'version_conflict_engine_exception' } } },
  ]);
  expect((await search.request('GET', `/${index}/_doc/${id}`)).body).toEqual(stored.body);
  expect(await checkpoint(replayConsumer, partition)).toBe(String(position));
  expect(await replay.run(partition)).toMatchObject({ status: 'read', envelopes: 0, position });
  expect(reads).toHaveLength(4);
  expect(bulks).toHaveLength(3);
});
