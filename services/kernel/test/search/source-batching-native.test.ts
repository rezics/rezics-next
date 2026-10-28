import { afterAll, beforeAll, expect, test } from 'bun:test';
import pg from 'pg';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { resourceAuthorization } from '../../src/access/resource-authorization.ts';
import { runCommand } from '../../src/command/command.ts';
import { createPool } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { subjectListingSource } from '../../src/library/listing-counts.ts';
import type { Access } from '../../src/request/access.ts';
import { deadlineFor } from '../../src/request/deadline.ts';
import { newId } from '../../src/route/route.ts';
import { bulkLines, documentActions, type SubjectDocument } from '../../src/search/document.ts';
import { discloseFacetValues } from '../../src/search/facets.ts';
import { createSubjectIndexer } from '../../src/search/indexer.ts';
import { createSubjectIndex, subjectIndexName } from '../../src/search/indices.ts';
import { createOpenSearch, type OpenSearch } from '../../src/search/opensearch.ts';
import { subjectPartition, type SubjectSnapshot, type SubjectSource } from '../../src/search/source.ts';
import { globalContextAnchor } from '../../src/semantic/context.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { subjectSource } from '../../src/semantic/search-source.ts';
import { createSubject } from '../../src/semantic/subject.ts';
import { createRealAccess } from '../semantic/real-access.ts';

const databaseUrl = process.env.DATABASE_URL;
const searchUrl = process.env.OPENSEARCH_URL;
if (!databaseUrl || !searchUrl)
  throw new Error('DATABASE_URL and OPENSEARCH_URL must name the check database and node');
const pool = createPool(databaseUrl);
const admin = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const search = createOpenSearch(searchUrl);
const routeKey = new Uint8Array(32).fill(74);
const native = subjectSource(pool, routeKey);
const nativeListing = subjectListingSource(pool);
const partition = 173;
const route = partition * 16;
const ids = Array.from({ length: 320 }, () => newId(route)).sort();
const missing = newId(route);
const excluded = [ids[253]!, ids[254]!, ids[255]!, missing];
const labels = ids.map((_, i) => (i === 0 ? '\uFDFA'.repeat(250) : i === 1 ? '漢'.repeat(250) : `Native target ${i}`));
const original: SubjectSnapshot[] = [];
const indices: string[] = [];
const consumers: string[] = [];
const actions = ['subject:create', 'subject:merge', 'moderation:hide', 'moderation:takedown'];
const real = await createRealAccess(admin, { editor: newId(0) }, actions);
let access: Access;
const kernel = createKernel({
  pool,
  access(config) {
    return (access = real.access(config));
  },
  tokens: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(3)]]) },
  routeKey,
  writeRate: real.writeRate,
});
async function post(path: string, body: unknown) {
  const response = await kernel.handle(
    new Request(`http://kernel.test${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${real.bearer('editor')}`,
        'content-type': 'application/json',
        'idempotency-key': `"${crypto.randomUUID()}"`,
      },
      body: JSON.stringify(body),
    }),
  );
  expect([path, response.status, await response.json()]).toEqual([path, 200, expect.anything()]);
}
beforeAll(async () => {
  await bootstrapRelease(pool, bundledRelease);
  for (const action of actions) await real.grant({ route: 0, id: GLOBAL_CONTEXT }, 'editor', action);
  // Kernel composition registers this very Access instance and its command/write-rate bridge.
  await kernel.handle(new Request(`http://kernel.test/v1/definitions/releases/${bundledDigest}`));
  for (const [i, id] of ids.entries()) {
    const deadline = deadlineFor(5000);
    const actor = await access.authenticate(real.bearer('editor'), { pool, deadline });
    if (actor.kind !== 'account') throw new Error('Expected authenticated editor');
    const created = await createSubject(pool, {
      actor,
      target: { route, id },
      idempotencyKey: crypto.randomUUID(),
      digest: new Uint8Array(32).fill(i % 256),
      item: { type: 'schema:Book', labels: { en: labels[i]! } },
      release: { digest: bundledDigest, release: bundledRelease },
      deadline,
      // createSubject retains authoredAuthorization around this parent-anchor authorization.
      authorization: resourceAuthorization({
        access,
        actor,
        action: 'subject:create',
        anchor: globalContextAnchor,
        context: { pool, deadline, partition },
      }),
    });
    expect(created.subject.id).toBe(id);
    expect(created.component.partition).toBe(partition);
  }
  for (let offset = 0; offset < ids.length; offset += 256)
    original.push(await native.read(partition, ids.slice(offset, offset + 256)));
  await post(`/v1/subjects/${ids[253]}:hide`, { reason: 'spam' });
  await post(`/v1/subjects/${ids[254]}:takedown`, {
    notice: { complaint: 'Rights holder notice.', received_at: '2026-10-25T09:00:00Z' },
  });
  await post('/v1/subjects:merge', { subjects: [ids[252], ids[255]] });
  expect(real.checks.filter((check) => check.action === 'subject:create')).toHaveLength(320);
}, 120_000);
afterAll(async () => {
  try {
    for (const index of indices) await search.request('DELETE', `/${index}`);
    for (const consumer of consumers)
      await admin.query('DELETE FROM core.consumer_checkpoint WHERE consumer=$1 AND partition_no=$2', [
        consumer,
        partition,
      ]);
  } finally {
    await pool.end();
    await admin.end();
  }
});
async function checkpoint(consumer: string) {
  return (
    (
      await admin.query<{ position: string }>(
        'SELECT position::text FROM core.consumer_checkpoint WHERE consumer=$1 AND partition_no=$2',
        [consumer, partition],
      )
    ).rows[0]?.position ?? null
  );
}
async function invalidate(selected: string[]) {
  return (
    await runCommand(pool, { partition }, async () => ({
      value: null,
      events: selected.map((id) => ({ type: 'com.rezics.subject.created.v1', subject: id, data: { id } })),
    }))
  ).position;
}
type Read = { partition: number; ids: string[]; snapshot: SubjectSnapshot };
function observed(after?: (read: Read, ordinal: number) => Promise<void>) {
  const reads: Read[] = [];
  const source: SubjectSource = {
    async read(home, selected) {
      // Forward first: a red must be the real native limit, not this observer's imitation.
      const snapshot = await native.read(home, selected);
      expect(selected.every((id) => subjectPartition(id) === home)).toBe(true);
      expect(new Set(selected).size).toBe(selected.length);
      expect(selected.length).toBeLessThanOrEqual(256);
      const read = { partition: home, ids: [...selected], snapshot };
      reads.push(read);
      await after?.(read, reads.length);
      return snapshot;
    },
    async count() {
      throw new Error('Selected-anchor work must not scan partitions');
    },
  };
  return { source, reads };
}
type Metadata = { _id: string; _index: string; version: number; version_type: string };
function bulkActions(lines: readonly unknown[]) {
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
async function visible(index: string) {
  const { body } = await search.request<{
    hits: { hits: { _id: string; _version: number; _source: SubjectDocument; fields?: { name_sort?: string[] } }[] };
  }>('POST', `/${index}/_search`, {
    size: 1000,
    version: true,
    docvalue_fields: ['name_sort'],
    query: { match_all: {} },
  });
  return new Map(body.hits.hits.map((hit) => [hit._id, hit]));
}

for (const failure of [true])
  test(`native event anchors use exact chunk snapshots${failure ? ' through later transport failure and replay' : ''}`, async () => {
    const prefix = `native-${crypto.randomUUID().slice(0, 8)}-`;
    const index = subjectIndexName(prefix, 1);
    indices.push(index);
    await createSubjectIndex(search, prefix, 1);
    const consumer = `native_${crypto.randomUUID().replaceAll('-', '')}`;
    consumers.push(consumer);
    const setupPrefix = `drain-${crypto.randomUUID().slice(0, 8)}-`;
    const setupIndex = subjectIndexName(setupPrefix, 1);
    indices.push(setupIndex);
    await createSubjectIndex(search, setupPrefix, 1);
    const drain = createSubjectIndexer({
      pool,
      search,
      source: native,
      listing: nativeListing,
      index: setupIndex,
      consumer,
    });
    // Position only through genuine relays; setup envelopes contain bounded individual native commands.
    for (;;) {
      const result = await drain.run(partition);
      if (result.status === 'read' && result.envelopes === 0) break;
    }
    const before = await checkpoint(consumer);
    // Seed stale documents from actual pre-moderation facts, including a native row now redirected.
    for (const snapshot of original.filter((snapshot) =>
      snapshot.subjects.some((subject) => excluded.includes(subject.id)),
    ))
      await search.bulk(
        bulkLines(
          index,
          documentActions(
            snapshot,
            snapshot.subjects
              .filter((subject) => ids.slice(253, 256).includes(subject.id))
              .map((subject) => subject.id),
          ),
        ),
        {
          query: { refresh: 'wait_for' },
        },
      );
    const selected = [...ids.slice(0, 256), missing, ...ids.slice(256)];
    const end = await invalidate([...selected, ids[0]!, ids[319]!]);
    let advanced: bigint | undefined;
    const probe = observed(async (_, ordinal) => {
      if (ordinal === 1)
        advanced = (
          await runCommand(pool, { partition }, async () => ({
            value: null,
            events: [{ type: 'com.rezics.fixture.created.v1', data: {} }],
          }))
        ).position;
    });
    const listingReads: string[][] = [];
    const writes: ReturnType<typeof bulkActions>[] = [];
    let attempts = 0;
    const engine: OpenSearch = {
      request: search.request,
      bulk: (async (lines, options) => {
        expect(await checkpoint(consumer)).toBe(before);
        expect(options?.query?.refresh).toBe('wait_for');
        if (++attempts === 2 && failure) throw new Error('Injected later native chunk transport failure');
        const result = await search.bulk(lines, options);
        const chunk = bulkActions(lines);
        for (const action of chunk) {
          const read = probe.reads.findLast((read) => read.ids.includes(action.metadata._id))!;
          expect(action.metadata.version).toBe(Number(read.snapshot.position));
        }
        writes.push(chunk);
        const hits = await visible(index);
        for (const action of chunk) {
          if (action.op === 'delete') expect(hits.has(action.metadata._id)).toBe(false);
          else {
            expect(hits.get(action.metadata._id)!._version).toBe(action.metadata.version);
            expect(hits.get(action.metadata._id)!._source).toEqual(action.document!);
          }
        }
        expect(await checkpoint(consumer)).toBe(before);
        return result;
      }) as OpenSearch['bulk'],
    };
    const relay = createSubjectIndexer({
      pool,
      search: engine,
      source: probe.source,
      listing: {
        async read(home, selectedIds) {
          expect(home).toBe(partition);
          expect(selectedIds.length).toBeLessThanOrEqual(256);
          expect(selectedIds.some((id) => excluded.includes(id))).toBe(false);
          listingReads.push([...selectedIds]);
          return nativeListing.read(home, selectedIds);
        },
      },
      index,
      consumer,
    });
    let start = 0;
    if (failure) {
      await expect(relay.run(partition)).rejects.toThrow('Injected later native chunk transport failure');
      expect(await checkpoint(consumer)).toBe(before);
      expect(writes).toHaveLength(1);
      expect((await visible(index)).has(ids[319]!)).toBe(false);
      start = probe.reads.length;
    }
    const replayEnd = failure ? advanced! : end;
    await relay.run(partition);
    expect(await checkpoint(consumer)).toBe(String(replayEnd));
    expect(probe.reads[0]!.snapshot.position).toBe(end);
    expect(probe.reads[1]!.snapshot.position).toBe(advanced!);
    expect(advanced!).toBeGreaterThan(end);
    const reads = probe.reads.slice(start);
    expect(reads.map((read) => read.ids.length)).toEqual([256, 65]);
    expect(reads.flatMap((read) => read.ids)).toEqual(selected);
    expect(listingReads.slice(start)).toEqual(reads.map((read) => read.ids.filter((id) => !excluded.includes(id))));
    const successful = writes.slice(failure ? 1 : 0);
    expect(successful.map((chunk) => chunk.map((action) => action.metadata._id))).toEqual(
      reads.map((read) => read.ids),
    );
    for (const [i, chunk] of successful.entries())
      for (const action of chunk) {
        expect(action.metadata).toEqual({
          _index: index,
          _id: action.metadata._id,
          version: Number(reads[i]!.snapshot.position),
          version_type: 'external',
        });
        expect(action.op).toBe(excluded.includes(action.metadata._id) ? 'delete' : 'index');
      }
    const hits = await visible(index);
    expect([...hits.keys()].sort()).toEqual(ids.filter((id) => !excluded.includes(id)).sort());
    for (const read of reads)
      for (const subject of read.snapshot.subjects) {
        if (excluded.includes(subject.id)) continue;
        expect(hits.get(subject.id)!._source.names).toEqual(subject.labels.map((label) => label.value));
        expect(hits.get(subject.id)!._version).toBe(Number(read.snapshot.position));
      }
    for (const [id, label] of [
      [ids[0]!, labels[0]!],
      [ids[1]!, labels[1]!],
    ] as const) {
      const { body } = await search.request<{ tokens: { token: string }[] }>('POST', `/${index}/_analyze`, {
        normalizer: 'name_key',
        text: label,
      });
      const key = body.tokens[0]!.token;
      expect(hits.get(id)!._source.name_sort).toBe(key.length > 512 ? null : key);
      expect(hits.get(id)!.fields?.name_sort ?? []).toEqual(key.length > 512 ? [] : [key]);
    }
    const calls = [probe.reads.length, listingReads.length, writes.length];
    await relay.run(partition);
    await relay.run(partition);
    expect([probe.reads.length, listingReads.length, writes.length]).toEqual(calls);
  }, 120_000);

for (const size of [0, 255, 256, 257, 320, 1200])
  test(`native facet disclosure chunks ${size} distinct targets and excludes current private targets`, async () => {
    const selected =
      size <= 320 ? ids.slice(0, size) : [...ids, ...Array.from({ length: size - 320 }, () => newId(route))];
    if (size === 257) selected[256] = missing;
    if (size === 320) {
      selected.splice(252, 0, missing);
      selected.push(newId(route));
    }
    const probe = observed();
    const result = await discloseFacetValues(probe.source, [...selected, ...selected, 'invalid', '', 'schema:Book']);
    expect(probe.reads).toHaveLength(Math.ceil(selected.length / 256));
    expect(probe.reads.flatMap((read) => read.ids)).toEqual(selected);
    const readable = selected.filter((id) => ids.includes(id) && !excluded.includes(id));
    expect([...result.keys()].sort()).toEqual([...readable].sort());
    for (const read of probe.reads)
      for (const subject of read.snapshot.subjects) {
        if (!readable.includes(subject.id)) continue;
        // No stitched common snapshot or cached authority: retain each chunk's actual current native result.
        expect(result.get(subject.id)).toEqual(subject);
      }
    for (const id of readable.filter((id) => ids.indexOf(id) >= 257))
      expect(result.get(id)!.labels).toEqual([{ language: 'en', value: labels[ids.indexOf(id)]! }]);
  });

test('native facet disclosure bounds partition concurrency, serializes home chunks and rejects a later read failure', async () => {
  const otherHomes = Array.from({ length: 12 }, (_, n) => newId((partition + 1 + n) * 16));
  let active = 0;
  let peak = 0;
  const homes = new Set<number>();
  const probe = observed();
  const source: SubjectSource = {
    ...probe.source,
    async read(home, selected) {
      expect(homes.has(home)).toBe(false);
      homes.add(home);
      peak = Math.max(peak, ++active);
      try {
        return await probe.source.read(home, selected);
      } finally {
        --active;
        homes.delete(home);
      }
    },
  };
  await discloseFacetValues(source, [...ids, ...otherHomes]);
  expect(peak).toBeGreaterThan(1);
  expect(peak).toBeLessThanOrEqual(8);
  expect(probe.reads).toHaveLength(14);
  expect(probe.reads.filter((read) => read.partition === partition).map((read) => read.ids.length)).toEqual([256, 64]);
  const fault = new Error('Injected later native source transport failure');
  let calls = 0;
  const rejecting: SubjectSource = {
    ...native,
    async read(home, selected) {
      if (++calls === 2) throw fault;
      return native.read(home, selected);
    },
  };
  await expect(discloseFacetValues(rejecting, ids)).rejects.toThrow(fault.message);
  expect(calls).toBe(2);
});
