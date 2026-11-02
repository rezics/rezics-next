import { afterAll, expect, test } from 'bun:test';
import pg from 'pg';
import { bundledRelease } from '@rezics/definitions/bundled';
import { runCommand, type CommandEvent } from '../../src/command/command.ts';
import { createPool } from '../../src/database/pool.ts';
import { newId } from '../../src/route/route.ts';
import { createDiscoveryProjection, type DiscoveryTarget } from '../../src/search/account-discovery.ts';
import { discoveryDocumentId, parseDiscoveryDocumentId } from '../../src/search/discovery-documents.ts';
import { createDiscoveryRegistry } from '../../src/search/discovery-registry.ts';
import type { DiscoveryKey, IndexedAccount } from '../../src/search/discovery.ts';
import { createDiscoveryIndexer } from '../../src/search/indexer.ts';
import { discoveryIndexName } from '../../src/search/indices.ts';
import {
  allocateDiscovery,
  advanceDiscovery,
  discoveryConsumer,
  discoveryGenerations,
} from '../../src/search/generations.ts';
import { createOpenSearch, type OpenSearch } from '../../src/search/opensearch.ts';
import type { IndexedSubject } from '../../src/search/source.ts';

const databaseUrl = process.env.DATABASE_URL;
const searchUrl = process.env.OPENSEARCH_URL;
if (!databaseUrl || !searchUrl) throw new Error('DATABASE_URL and OPENSEARCH_URL must name the check services');

const pool = createPool(databaseUrl);
const admin = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const native = createOpenSearch(searchUrl);
afterAll(async () => {
  await pool.end();
  await admin.end();
});

const noRead = async (): Promise<never> => {
  throw new Error('Projection must not hydrate summaries');
};

function bulkKeys(registry: ReturnType<typeof createDiscoveryRegistry>, body: string) {
  const actions: { op: 'index' | 'delete'; key: DiscoveryKey }[] = [];
  for (const line of body.trim().split('\n')) {
    const parsed = JSON.parse(line) as Record<string, { _id?: string }>;
    const op = 'index' in parsed ? 'index' : 'delete' in parsed ? 'delete' : null;
    if (!op) continue;
    const id = parsed[op]?._id;
    if (typeof id !== 'string') throw new Error('Discovery bulk line is missing _id');
    actions.push({ op, key: parseDiscoveryDocumentId(registry, id) });
  }
  return actions;
}

test('replay of a Subject changing between released Types deletes its old kind and indexes the current kind', async () => {
  const partition = 394;
  const route = partition * 16;
  const id = newId(route);
  const prefix = `typechg-${crypto.randomUUID().slice(0, 8)}-`;
  const subject: IndexedSubject = {
    id,
    type: 'schema:Person',
    visibility: 'visible',
    redirect: null,
    securityRevision: 1,
    labels: [{ language: 'en', value: 'Released type change' }],
    aliases: [],
    descriptions: [],
    statements: [],
  };
  const account: IndexedAccount = {
    id,
    accountKind: 'actor',
    handle: null,
    displayName: 'Same UUID account',
    revision: 1n,
  };
  async function position() {
    const { rows } = await admin.query<{ position: string }>(
      'SELECT position::text FROM core.partition WHERE partition_no=$1',
      [partition],
    );
    return BigInt(rows[0]!.position);
  }
  const registry = createDiscoveryRegistry({
    release: bundledRelease,
    semantic: {
      source: {
        async read(requested, ids) {
          expect(requested).toBe(partition);
          expect([...ids]).toEqual([id]);
          return { partition, position: await position(), subjects: ids.includes(id) ? [{ ...subject }] : [] };
        },
        async count(): Promise<never> {
          throw new Error('Ordinary projection must not census Source');
        },
      },
      hydrate: noRead,
      icons: Object.fromEntries(Object.keys(bundledRelease.types).map((kind) => [kind, 'catalogue'])),
    },
    accounts: {
      source: {
        async read(requested, ids) {
          expect(requested).toBe(partition);
          return {
            partition,
            position: await position(),
            accounts: ids.includes(id) ? [account] : [],
          };
        },
        async count(): Promise<never> {
          throw new Error('Ordinary projection must not census Source');
        },
        async page(): Promise<never> {
          throw new Error('Ordinary replay must not page Accounts');
        },
      },
      hydrate: noRead,
      labels: { en: 'Accounts' },
      icon: 'account',
    },
  });
  const listing = {
    async read() {
      return new Map<string, number>();
    },
  };
  const bodies: string[] = [];
  let failWrite = false;
  const search: OpenSearch = {
    ...native,
    async bulkRaw(body, options) {
      bodies.push(body);
      if (failWrite) throw new Error('injected discovery write failure');
      return native.bulkRaw!(body, options);
    },
  };
  const personKey: DiscoveryKey = { owner: 'semantic', kind: 'schema:Person', route, id };
  const bookKey: DiscoveryKey = { owner: 'semantic', kind: 'schema:Book', route, id };
  const accountKey: DiscoveryKey = { owner: 'accounts', kind: 'account', route, id };
  const positions: bigint[] = [];
  async function append(events: CommandEvent[]) {
    const result = await runCommand(pool, { partition }, async () => ({ value: null, events }));
    positions.push(result.position);
    return result.position;
  }
  await allocateDiscovery(pool, prefix, registry);
  await advanceDiscovery({ pool, search, prefix, registry, listing });
  const target = (await discoveryGenerations(pool, prefix))[0] as DiscoveryTarget | undefined;
  if (!target?.uuid) throw new Error('Native generation was not allocated');
  const index = discoveryIndexName(prefix, target.generation);
  const consumer = discoveryConsumer(prefix, target.generation);
  const projection = createDiscoveryProjection({ pool, search, registry, listing, target });
  const relay = createDiscoveryIndexer(pool, projection, consumer);
  async function checkpoint() {
    const { rows } = await admin.query<{ position: string }>(
      'SELECT position::text FROM core.consumer_checkpoint WHERE consumer=$1 AND partition_no=$2',
      [consumer, partition],
    );
    return rows[0]?.position ?? null;
  }
  async function copies() {
    const { rows } = await admin.query<{ kind: string; deleted: boolean; settled: boolean }>(
      `SELECT kind,deleted,settled FROM search.discovery_copy
       WHERE source_id=$1 AND prefix=$2 AND generation=$3 ORDER BY kind`,
      [id, prefix, target.generation],
    );
    return rows;
  }
  async function hit(documentId: string) {
    const { body } = await native.request<{ hits: { hits: { _id: string; _source: { kind: string } }[] } }>(
      'POST',
      `/${index}/_search`,
      { size: 1, query: { ids: { values: [documentId] } } },
    );
    return body.hits.hits.find((row) => row._id === documentId);
  }
  try {
    const baseline = await append([{ type: 'com.rezics.fixture.created.v1', data: {} }]);
    expect(await relay.run(partition)).toMatchObject({ status: 'read', envelopes: 1, position: baseline });
    await projection.project(partition, [personKey]);
    const personId = discoveryDocumentId(registry, personKey);
    const bookId = discoveryDocumentId(registry, bookKey);
    const accountId = discoveryDocumentId(registry, accountKey);
    expect(new Set([personId, bookId, accountId]).size).toBe(3);
    expect(await hit(personId)).toMatchObject({ _id: personId });
    subject.type = 'schema:Book';
    await admin.query(
      `INSERT INTO search.discovery_copy(route,source_id,prefix,generation,kind)
       VALUES ($1,$2,$3,$4,'schema:Book') ON CONFLICT DO NOTHING`,
      [route, id, prefix, target.generation],
    );
    failWrite = true;
    const end = await append([
      { type: 'com.rezics.subject.created.v1', subject: id, data: { id } },
      { type: 'com.rezics.access.account-updated.v1', subject: id, data: { accountId: id } },
    ]);
    await expect(relay.run(partition)).rejects.toThrow('injected discovery write failure');
    expect(await checkpoint()).toBe(String(baseline));
    expect(await hit(personId)).toMatchObject({ _id: personId });
    failWrite = false;
    expect(await relay.run(partition)).toMatchObject({ status: 'read', envelopes: 1, position: end });
    expect(await checkpoint()).toBe(String(end));
    const changed = bulkKeys(registry, bodies.at(-2)!);
    expect(changed).toEqual(
      expect.arrayContaining([
        { op: 'delete', key: personKey },
        { op: 'index', key: bookKey },
      ]),
    );
    expect(bulkKeys(registry, bodies.at(-1)!)).toEqual([{ op: 'index', key: accountKey }]);
    expect(await hit(personId)).toBeUndefined();
    expect(await hit(bookId)).toMatchObject({ _source: { kind: 'schema:Book' } });
    expect(await hit(accountId)).toMatchObject({ _source: { kind: 'account' } });
    expect(await copies()).toEqual([
      { kind: 'account', deleted: false, settled: true },
      { kind: 'schema:Book', deleted: false, settled: true },
      { kind: 'schema:Person', deleted: true, settled: true },
    ]);
    const beforeRetry = bodies.length;
    expect(await relay.run(partition)).toMatchObject({ status: 'read', envelopes: 0, position: end });
    expect(bodies.length).toBe(beforeRetry);
    const repaired = await projection.prepareRepair(id, end);
    expect(repaired.map(({ op, id: documentId }) => ({ op, id: documentId }))).toEqual(
      expect.arrayContaining([
        { op: 'delete', id: personId },
        { op: 'index', id: bookId },
      ]),
    );
    await projection.applyRepair(repaired);
    expect(await hit(personId)).toBeUndefined();
    expect(await hit(bookId)).toMatchObject({ _id: bookId });
  } finally {
    await native.request('DELETE', `/${index}`).catch(() => undefined);
    await admin.query('DELETE FROM search.discovery_copy WHERE prefix=$1', [prefix]);
    await admin.query('DELETE FROM search.discovery_population WHERE prefix=$1', [prefix]);
    await admin.query('DELETE FROM search.discovery_generation WHERE prefix=$1', [prefix]);
    await admin.query('DELETE FROM core.consumer_checkpoint WHERE consumer=$1', [consumer]);
    for (const value of positions)
      await admin.query('DELETE FROM core.outbox WHERE partition_no=$1 AND position=$2', [partition, String(value)]);
  }
}, 60_000);
