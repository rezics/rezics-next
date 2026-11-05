// Keep the original native checkpoint and bounded-source scenarios in this entry point.
import './indexing.test.ts';
import './indexer-source-batches.test.ts';
import { afterAll, expect, test } from 'bun:test';
import pg from 'pg';
import { runCommand, type CommandEvent } from '../../src/command/command.ts';
import { createPool } from '../../src/database/pool.ts';
import { newId } from '../../src/route/route.ts';
import { documentActions, type SubjectDocument } from '../../src/search/document.ts';
import { createSubjectIndexer, IndexWriteError } from '../../src/search/indexer.ts';
import { createSubjectIndex, subjectIndexName } from '../../src/search/indices.ts';
import { createOpenSearch, type OpenSearch } from '../../src/search/opensearch.ts';
import type { IndexedSubject, SubjectSource } from '../../src/search/source.ts';

const databaseUrl = process.env.DATABASE_URL;
const searchUrl = process.env.OPENSEARCH_URL;
if (!databaseUrl || !searchUrl) throw new Error('Native checkpoint proof requires the check database and node');
const pool = createPool(databaseUrl);
const admin = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const native = createOpenSearch(searchUrl);
afterAll(async () => {
  await pool.end();
  await admin.end();
});

type Receipt = { errors: boolean; items: Record<string, Record<string, unknown>>[] };
type Hit = { _id: string; _version: number; _source: SubjectDocument };
async function visible(index: string) {
  return (
    await native.request<{ hits: { hits: Hit[] } }>('POST', `/${index}/_search`, {
      size: 10,
      version: true,
    })
  ).body.hits.hits;
}
async function checkpoint(consumer: string, partition: number) {
  const { rows } = await admin.query<{ position: string }>(
    'SELECT position::text FROM core.consumer_checkpoint WHERE consumer = $1 AND partition_no = $2',
    [consumer, partition],
  );
  return rows[0]?.position ?? null;
}

const corruptions: [string, ((body: Receipt) => void) | undefined][] = [
  [
    'wrong key',
    (body) => {
      body.items[1]!.index!._id = newId(0);
    },
  ],
  [
    'wrong physical target',
    (body) => {
      body.items[1]!.index!._index = 'foreign-index';
    },
  ],
  [
    'wrong external version',
    (body) => {
      body.items[1]!.index!._version = 1;
    },
  ],
  [
    'duplicated receipt',
    (body) => {
      body.items[1] = structuredClone(body.items[0]!);
    },
  ],
  [
    'reordered receipt',
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
    'partial shard success',
    (body) => {
      body.items[1]!.index!._shards = { total: 2, successful: 1, failed: 0 };
    },
  ],
  ['partial native item failure', undefined],
  ['response lost after native write', undefined],
];
for (const [caseNumber, [name, corrupt]] of corruptions.entries()) {
  test(`real projectBatch retains its checkpoint after ${name} and genuine replay converges once`, async () => {
    const partition = 176 + caseNumber;
    const consumer = `keyed_${crypto.randomUUID().replaceAll('-', '')}`;
    const prefix = `test-keyed-checkpoint-${crypto.randomUUID().slice(0, 8)}-`;
    const index = subjectIndexName(prefix, 1);
    const positions: bigint[] = [];
    const receipts: { lines: readonly unknown[]; options: unknown; native: Receipt; returned: Receipt }[] = [];
    const refreshes: string[] = [];
    const facts: Record<string, unknown> = { name, partition, consumer, index };
    async function append(events: CommandEvent[]) {
      const result = await runCommand(pool, { partition }, async () => ({ value: null, events }));
      positions.push(result.position);
      return result.position;
    }
    await createSubjectIndex(native, prefix, 1);
    try {
      const subjects: IndexedSubject[] = [0, 1].map((n) => ({
        id: newId(partition * 16),
        type: 'schema:Book',
        visibility: 'visible',
        redirect: null,
        securityRevision: 3,
        labels: [{ language: 'en', value: `receipt book ${n}` }],
        aliases: [{ language: 'en', value: `Complete alias ${n}` }],
        descriptions: [{ language: 'en', value: `Complete description ${n}` }],
        statements: [],
      }));
      let injecting = true;
      let sourceReads = 0;
      let sourcePosition = 0n;
      // Deliberately isolate the sink: these are provider-boundary fixtures, not Auth,
      // Access, Semantic Source completeness or disclosure evidence.
      const source: SubjectSource = {
        async read(requestedPartition, ids) {
          expect(requestedPartition).toBe(partition);
          expect(ids).toEqual(subjects.map((subject) => subject.id));
          sourceReads++;
          const { rows } = await admin.query<{ position: string }>(
            'SELECT position::text FROM core.partition WHERE partition_no = $1',
            [partition],
          );
          sourcePosition = BigInt(rows[0]!.position);
          const snapshot = structuredClone(subjects);
          // A real mapper failure on only the second native item; the first write survives.
          if (injecting && name === 'partial native item failure') snapshot[1]!.securityRevision = Number.MAX_VALUE;
          return { partition, position: sourcePosition, subjects: snapshot };
        },
        async count(): Promise<never> {
          throw new Error('The sink must not scan Source');
        },
      };
      let baseline = '';
      const engine: OpenSearch = {
        async bulk<T>(lines: readonly unknown[], options?: Parameters<OpenSearch['bulk']>[1]) {
          expect(await checkpoint(consumer, partition)).toBe(baseline);
          expect(options).toEqual({ query: { refresh: 'wait_for' } });
          const body = await native.bulk<Receipt>(lines, options);
          const returned = structuredClone(body);
          if (injecting) corrupt?.(returned);
          receipts.push({ lines: structuredClone(lines), options, native: body, returned });
          expect(await checkpoint(consumer, partition)).toBe(baseline);
          if (injecting && name === 'response lost after native write')
            throw new Error('native response lost after write');
          return returned as T;
        },
        async request<T>(...args: Parameters<OpenSearch['request']>) {
          if (args[1] === `/${index}/_refresh`) {
            expect(await checkpoint(consumer, partition)).toBe(baseline);
            refreshes.push(args[1]);
          }
          const response = await native.request<T>(...args);
          if (args[1] === `/${index}/_refresh`) {
            expect(await checkpoint(consumer, partition)).toBe(baseline);
            expect(await visible(index)).toHaveLength(2);
          }
          return response;
        },
      };
      const relay = createSubjectIndexer({
        pool,
        search: engine,
        source,
        index,
        consumer,
        listing: {
          async read() {
            return new Map<string, number>();
          },
        },
      });
      // First prove an existing nonzero checkpoint, then fail the next real envelope.
      baseline = String(await append([{ type: 'com.rezics.fixture.created.v1', data: {} }]));
      await relay.run(partition);
      expect(await checkpoint(consumer, partition)).toBe(baseline);
      const end = await append(
        subjects.map(({ id }) => ({
          type: 'com.rezics.subject.created.v1',
          subject: id,
          data: { id },
        })),
      );
      if (name === 'response lost after native write')
        await expect(relay.run(partition)).rejects.toThrow('native response lost after write');
      else await expect(relay.run(partition)).rejects.toBeInstanceOf(IndexWriteError);
      const unchanged = await checkpoint(consumer, partition);
      expect(unchanged).toBe(baseline);
      expect(sourcePosition).toBe(end);
      expect(receipts).toHaveLength(1);
      expect(receipts[0]!.native.items.map((item) => item.index!._id)).toEqual(subjects.map(({ id }) => id));
      const partial = name === 'partial native item failure';
      expect(receipts[0]!.native.items.map((item) => item.index!.status)).toEqual(partial ? [201, 400] : [201, 201]);
      if (partial)
        expect(receipts[0]!.native.items[1]!.index!.error).toMatchObject({ type: 'mapper_parsing_exception' });
      const beforeReplay = await visible(index);
      expect(beforeReplay).toHaveLength(partial ? 1 : 2);
      const expected = documentActions(
        { partition, position: end, subjects },
        subjects.map(({ id }) => id),
        new Map(),
      );
      for (const hit of beforeReplay) {
        const item = expected.find((item) => item.id === hit._id)!;
        expect(hit).toMatchObject({ _version: Number(end), _source: item.op === 'index' ? item.document : null });
      }
      expect(refreshes).toEqual([]);
      injecting = false;
      expect(await relay.run(partition)).toMatchObject({ status: 'read', envelopes: 1, position: end });
      expect(await checkpoint(consumer, partition)).toBe(String(end));
      expect(receipts).toHaveLength(2);
      expect(receipts[1]!.native.items.map((item) => item.index!.status)).toEqual(partial ? [409, 201] : [409, 409]);
      expect(refreshes).toEqual([`/${index}/_refresh`]);
      const afterReplay = await visible(index);
      expect(afterReplay).toHaveLength(2);
      for (const item of expected) {
        expect(afterReplay.find((hit) => hit._id === item.id)).toMatchObject({
          _version: Number(end),
          _source: item.op === 'index' ? item.document : null,
        });
      }
      expect(await relay.run(partition)).toMatchObject({ status: 'read', envelopes: 0, position: end });
      expect(receipts).toHaveLength(2);
      expect(sourceReads).toBe(2);
      facts.checkpoints = { baseline, unchanged, replay: String(end), idle: await checkpoint(consumer, partition) };
      facts.visible = { beforeReplay, afterReplay };
    } finally {
      console.info('native checkpoint receipt recovery', JSON.stringify({ ...facts, receipts, refreshes }));
      await native.request('DELETE', `/${index}`);
      await admin.query('DELETE FROM core.consumer_checkpoint WHERE consumer = $1 AND partition_no = $2', [
        consumer,
        partition,
      ]);
      for (const position of positions)
        await admin.query('DELETE FROM core.outbox WHERE partition_no = $1 AND position = $2', [
          partition,
          String(position),
        ]);
    }
  }, 60_000);
}
