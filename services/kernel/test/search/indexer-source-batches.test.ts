import { afterAll, expect, test } from 'bun:test';
import pg from 'pg';
import { runCommand, type CommandEvent } from '../../src/command/command.ts';
import { createPool } from '../../src/database/pool.ts';
import { newId } from '../../src/route/route.ts';
import { bulkLines, documentActions, type SubjectDocument } from '../../src/search/document.ts';
import { createSubjectIndexer } from '../../src/search/indexer.ts';
import { createSubjectIndex, subjectIndexName } from '../../src/search/indices.ts';
import { createOpenSearch, type OpenSearch } from '../../src/search/opensearch.ts';
import {
  subjectPartition,
  type IndexedSubject,
  type SubjectListingSource,
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

// Provider-boundary subjects, not nativeAuth, source authority or end-user write evidence.
// The real command fence admits registered events; the consumer must accommodate their legal envelope size.
class ControlledSource implements SubjectSource {
  readonly reads: { partition: number; ids: string[]; snapshot: SubjectSnapshot }[] = [];
  constructor(
    readonly subjects: Map<string, IndexedSubject>,
    readonly afterFirstRead: () => Promise<void>,
  ) {}

  async read(partition: number, ids: readonly string[]): Promise<SubjectSnapshot> {
    // Match semantic/search-source.ts's actual bound, including its rejection boundary.
    if (ids.length > 256) throw new TypeError('A subject snapshot accepts at most 256 ids');
    for (const id of ids) expect(subjectPartition(id)).toBe(partition);
    const { rows } = await admin.query<{ position: string }>(
      'SELECT position::text FROM core.partition WHERE partition_no = $1',
      [partition],
    );
    const snapshot = {
      partition,
      position: BigInt(rows[0]!.position),
      subjects: ids.flatMap((id) => {
        const subject = this.subjects.get(id);
        return subject ? [structuredClone(subject)] : [];
      }),
    };
    this.reads.push({ partition, ids: [...ids], snapshot });
    if (this.reads.length === 1) await this.afterFirstRead();
    return snapshot;
  }

  async count(): Promise<never> {
    throw new Error('Event consumption must not scan subjects');
  }
}

type Hit = { _id: string; _version: number; _source: SubjectDocument; fields?: { name_sort?: string[] } };
async function visible(index: string): Promise<Hit[]> {
  const { body } = await search.request<{ hits: { hits: Hit[] } }>('POST', `/${index}/_search`, {
    size: 1000,
    version: true,
    docvalue_fields: ['name_sort'],
    query: { match_all: {} },
  });
  return body.hits.hits;
}

type Metadata = { _index: string; _id: string; version: number; version_type: string };
type BulkResult = { items: Record<string, { status: number; error?: { type: string } }>[] };
function actions(lines: readonly unknown[]) {
  const result: { op: string; metadata: Metadata; document?: SubjectDocument }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as { index?: Metadata; delete?: Metadata };
    if (line.index) result.push({ op: 'index', metadata: line.index, document: lines[++i] as SubjectDocument });
    else {
      expect(line.delete).toBeDefined();
      result.push({ op: 'delete', metadata: line.delete! });
    }
  }
  return result;
}

const title =
  'one admitted event envelope with more than256 subjects converges through bounded source chunks and checkpoints only after every visible write';
for (const failLaterBulk of [false, true]) {
  test(failLaterBulk ? `${title}: later transport failure and genuine retry` : title, async () => {
    const partition = failLaterBulk ? 162 : 161;
    const prefix = `test-${crypto.randomUUID().slice(0, 8)}-`;
    const index = subjectIndexName(prefix, 1);
    indices.push(index);
    await createSubjectIndex(search, prefix, 1);
    const consumer = `chunks_${crypto.randomUUID().replaceAll('-', '')}`;
    consumers.push({ consumer, partition });
    const expanded = '\uFDFA'.repeat(250);
    const cjk = '漢'.repeat(250);
    const subjects: IndexedSubject[] = Array.from({ length: 260 }, (_, n) => ({
      id: newId(partition * 16),
      type: 'schema:Book',
      visibility: 'visible',
      redirect: null,
      securityRevision: 1,
      labels: [{ language: 'en', value: n === 0 ? expanded : n === 1 ? cjk : 'Ａ' }],
      aliases: [],
      descriptions: [],
      statements: [],
    }));
    const ids = subjects.map(({ id }) => id);
    const excluded = ids.slice(253, 257);
    // Seed real stale documents so delete actions must remove data, including an absent source row.
    const seed = subjects.slice(253, 257).map((subject) => ({
      ...subject,
      labels: [{ language: 'en', value: `private excluded ${subject.id}` }],
    }));
    expect(
      (
        await search.bulk<BulkResult>(
          bulkLines(index, documentActions({ partition, position: 1n, subjects: seed }, excluded)),
          { query: { refresh: 'wait_for' } },
        )
      ).items.every((item) => Object.values(item)[0]!.status === 201),
    ).toBe(true);
    let advanced: bigint | undefined;
    const source = new ControlledSource(new Map(subjects.map((subject) => [subject.id, subject])), async () => {
      // A genuine unrelated commit between snapshots distinguishes source versions from the captured batch end.
      // This event is registered by the shared fixture-event-types preload and does not invalidate subjects.
      advanced = await append(partition, [{ type: 'com.rezics.fixture.created.v1', data: {} }]);
    });
    source.subjects.set(excluded[0]!, { ...seed[0]!, visibility: 'hidden' });
    source.subjects.set(excluded[1]!, { ...seed[1]!, visibility: 'taken_down' });
    source.subjects.set(excluded[2]!, { ...seed[2]!, redirect: ids[0]! });
    source.subjects.delete(excluded[3]!);
    const event = (id: string): CommandEvent => ({ type: 'com.rezics.subject.created.v1', subject: id, data: { id } });
    await append(partition, ids.map(event));
    const position = await append(partition, [event(ids[0]!), event(ids[259]!)]);
    const listingReads: { partition: number; ids: string[] }[] = [];
    const listing: SubjectListingSource = {
      async read(requestedPartition, requestedIds) {
        expect(requestedPartition).toBe(partition);
        expect(requestedIds.length).toBeLessThanOrEqual(256);
        expect(requestedIds.every((id) => !excluded.includes(id))).toBe(true);
        listingReads.push({ partition: requestedPartition, ids: [...requestedIds] });
        return new Map(requestedIds.map((id) => [id, 7]));
      },
    };
    const analysisInputs: string[] = [];
    const writes: { lines: readonly unknown[]; result: BulkResult }[] = [];
    let attempts = 0;
    let injected = 0;
    const engine: OpenSearch = {
      request: (async (...args: Parameters<OpenSearch['request']>) => {
        if (args[1].endsWith('/_analyze')) analysisInputs.push(JSON.stringify(args[2]));
        return search.request(...args);
      }) as OpenSearch['request'],
      bulk: (async (lines: readonly unknown[], options?: Parameters<OpenSearch['bulk']>[1]) => {
        expect(options?.query?.refresh).toBe('wait_for');
        expect(await checkpoint(consumer, partition)).toBe('0');
        attempts++;
        if (failLaterBulk && attempts === 2) {
          injected++;
          throw new Error('Injected later chunk transport failure');
        }
        const result = await search.bulk<BulkResult>(lines, options);
        writes.push({ lines: structuredClone(lines), result });
        // Withhold the genuine engine response until every action's search visibility is observed.
        const hits = new Map((await visible(index)).map((hit) => [hit._id, hit]));
        for (const action of actions(lines)) {
          if (action.op === 'delete') expect(hits.has(action.metadata._id)).toBe(false);
          else {
            const hit = hits.get(action.metadata._id)!;
            expect(hit._source).toEqual(action.document!);
            expect(hit._version).toBe(action.metadata.version);
          }
        }
        expect(await checkpoint(consumer, partition)).toBe('0');
        return result;
      }) as OpenSearch['bulk'],
    };
    const relay = createSubjectIndexer({ pool, search: engine, source, listing, index, consumer });
    let retryStart = 0;
    let retryReads = 0;
    let retryListings = 0;
    if (failLaterBulk) {
      await expect(relay.run(partition)).rejects.toThrow('Injected later chunk transport failure');
      expect(injected).toBe(1);
      expect(await checkpoint(consumer, partition)).toBe('0');
      expect(writes.length).toBe(1);
      expect((await visible(index)).some((hit) => hit._id === ids[0])).toBe(true);
      expect((await visible(index)).some((hit) => hit._id === ids[259])).toBe(false);
      retryStart = writes.length;
      retryReads = source.reads.length;
      retryListings = listingReads.length;
    }
    const end = failLaterBulk ? advanced! : position;
    expect(await relay.run(partition)).toMatchObject({
      status: 'read',
      envelopes: failLaterBulk ? 3 : 2,
      position: end,
    });
    expect(await checkpoint(consumer, partition)).toBe(String(end));
    expect(source.reads[0]!.snapshot.position).toBe(position);
    expect(source.reads[1]!.snapshot.position).toBe(advanced!);
    expect(advanced!).toBeGreaterThan(position);
    const reads = source.reads.slice(retryReads);
    expect(reads).toHaveLength(2);
    expect(reads.flatMap((read) => read.ids)).toEqual(ids);
    expect(reads.every((read) => read.ids.length > 0 && read.ids.length <= 256)).toBe(true);
    expect(listingReads.slice(retryListings)).toEqual(
      reads.map((read) => ({ partition, ids: read.ids.filter((id) => !excluded.includes(id)) })),
    );
    expect(listingReads.slice(retryListings).flatMap((read) => read.ids)).toEqual(
      ids.filter((id) => !excluded.includes(id)),
    );
    const chunks = writes.slice(retryStart).map(({ lines }) => actions(lines));
    expect(chunks.map((chunk) => chunk.map(({ metadata }) => metadata._id))).toEqual(reads.map((read) => read.ids));
    const successful = chunks.flat();
    expect(successful.map(({ metadata }) => metadata._id)).toEqual(ids);
    for (const action of successful) {
      const snapshot = reads.find((read) => read.ids.includes(action.metadata._id))!.snapshot;
      expect(action.metadata).toEqual({
        _index: index,
        _id: action.metadata._id,
        version: Number(snapshot.position),
        version_type: 'external',
      });
      expect(action.op).toBe(excluded.includes(action.metadata._id) ? 'delete' : 'index');
    }
    if (failLaterBulk)
      expect(
        writes
          .slice(retryStart)
          .some(({ result }) => result.items.some((item) => Object.values(item)[0]?.status === 200)),
      ).toBe(true);
    const hits = new Map((await visible(index)).map((hit) => [hit._id, hit]));
    expect([...hits.keys()].sort()).toEqual(ids.filter((id) => !excluded.includes(id)).sort());
    const keys = new Map<string, string | null>();
    for (const label of [expanded, cjk, 'Ａ']) {
      const { body } = await search.request<{ tokens: { token: string }[] }>('POST', `/${index}/_analyze`, {
        normalizer: 'name_key',
        text: label,
      });
      expect(body.tokens).toHaveLength(1);
      const key = body.tokens[0]!.token;
      keys.set(label, key.length > 512 ? null : key);
    }
    expect(keys.get(expanded)).toBeNull();
    expect(keys.get(cjk)).toBe(cjk);
    for (const read of reads) {
      for (const action of documentActions(read.snapshot, read.ids, new Map(read.ids.map((id) => [id, 7])))) {
        if (action.op !== 'index') continue;
        const expected = { ...action.document, name_sort: keys.get(action.document.names[0]!)! };
        expect(hits.get(action.id)!._source).toEqual(expected);
        expect(hits.get(action.id)!._version).toBe(Number(read.snapshot.position));
        expect(hits.get(action.id)!.fields?.name_sort ?? []).toEqual(
          expected.name_sort === null ? [] : [expected.name_sort],
        );
      }
    }
    expect(analysisInputs.length).toBeGreaterThan(0);
    for (const subject of seed)
      expect(analysisInputs.some((input) => input.includes(subject.labels[0]!.value))).toBe(false);
    const calls = { reads: source.reads.length, writes: writes.length, listings: listingReads.length };
    expect(await relay.run(partition)).toMatchObject({
      status: 'read',
      envelopes: failLaterBulk ? 0 : 1,
      position: advanced!,
    });
    expect(await checkpoint(consumer, partition)).toBe(String(advanced));
    expect(await relay.run(partition)).toMatchObject({ status: 'read', envelopes: 0, position: advanced! });
    expect({ reads: source.reads.length, writes: writes.length, listings: listingReads.length }).toEqual(calls);
  });
}
