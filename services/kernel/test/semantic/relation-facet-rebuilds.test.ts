import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Value } from 'typebox/value';
import { bundledRelease } from '@rezics/definitions/bundled';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { tupleRoute } from '../../src/content/imported-contract.ts';
import { readFences } from '../../src/content/source-fences.ts';
import { withConnection } from '../../src/database/pool.ts';
import type { Relay } from '../../src/events/relays.ts';
import { projectBatch } from '../../src/events/log.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { SEMANTIC_EVENTS } from '../../src/events/contracts/semantic.ts';
import { openGrowthDatabase } from '../support/growth.ts';
import { createRealAccess } from './real-access.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
const db = await openGrowthDatabase(url);
const routeKey = new Uint8Array(32).fill(83);
const actions = [
  'subject:create',
  'subject:read',
  'subject:batch_write',
  'statement:propose',
  'context:accept',
  'context:adopt',
  'source_fence:takedown',
  'subject:merge',
  'moderation:takedown',
];
const access = await createRealAccess(db.admin, { editor: newId(30000) }, actions);
const kernel = createKernel({
  pool: db.pool,
  routeKey,
  access: access.access,
  writeRate: createWriteRateLimiter({
    secret: 'facet-rebuild-acceptance-secret-32',
    overrides: JSON.stringify(
      Object.fromEntries(
        ['anonymous', 'new-account', 'member', 'trusted', 'service'].map((p) => [
          p,
          { write: { maximum: 100000, seconds: 60 } },
        ]),
      ),
    ),
  }),
});
const changed = 'com.rezics.subject.relation_facet_changed.v1';
const dependency = 'com.rezics.semantic.facet_dependency.changed.v1';
const continuation = 'com.rezics.semantic.facet_rebuild.continued.v1';
const consumer = 'semantic_relation_facet_rebuilds';
const release = structuredClone(bundledRelease);
release.catalogue = { id: 'https://example.test/facet-rebuilds', version: '1' };
release.types['schema:Book']!.facets = ['schema:author'];
release.filters = {};
release.types['schema:Book']!.properties = ['schema:author', 'schema:contributor'];
const snak = (property: string, content: string) => ({ property: { id: property }, value: { type: 'value', content } });
const references = [{ parts: [snak('schema:url', 'https://example.test/evidence')] }];
const part = (id: string) => partitionOf(routeOf(id)!);

beforeAll(async () => {
  for (const action of actions) await access.grant({ route: 0, id: GLOBAL_CONTEXT }, 'editor', action);
  await bootstrapRelease(db.pool, release);
});
afterAll(() => db.close());

async function post(path: string, body: unknown, key = randomUUID()) {
  const response = await kernel.handle(
    new Request(`http://kernel.test${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${access.bearer('editor')}`,
        'idempotency-key': `"${key}"`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    }),
  );
  const result = (await response.json()) as any;
  expect(response.status, `${path}: ${JSON.stringify(result)}`).toBe(path === '/v1/subjects' ? 201 : 200);
  return result;
}
async function create(type = 'schema:Book') {
  return (await post('/v1/subjects', { type, labels: { en: 'Facet rebuild source' } })).subject.id as string;
}
async function batch(command: unknown) {
  const result = (await post('/v1/subjects:batchWrite', { commands: [command] })).results[0];
  expect([200, 201]).toContain(result.status);
  return result.value;
}
async function fixture(count = 2) {
  const source = {
    source: 'openlibrary',
    external_id: randomUUID(),
    field_group: 'facts' as const,
    record_revision: 'unversioned',
    digest: 'd'.repeat(64),
    converter_revision: 'openlibrary@1',
  };
  const route = tupleRoute(routeKey, source.source, source.external_id);
  const claim = await batch({
    op: 'create',
    key: randomUUID(),
    source,
    subject: { type: 'schema:Book', labels: { en: 'Original tuple claim' } },
  });
  const target = await create('schema:Person');
  const sources: string[] = [];
  while (sources.length < count) {
    const id = await create();
    if (part(id) !== partitionOf(route)) sources.push(id);
  }
  const candidates: string[] = [];
  for (const subject of sources) {
    const proposed = await batch({
      op: 'propose',
      key: randomUUID(),
      source,
      subject,
      statement: { ...snak('schema:author', target), qualifiers: [], references },
    });
    candidates.push(proposed.candidate);
    await post(`/v1/subjects/${subject}/candidates/${proposed.candidate}:accept`, {
      context: GLOBAL_CONTEXT,
      expected_head: null,
    });
    await post(`/v1/subjects/${subject}:adopt`, {
      context: GLOBAL_CONTEXT,
      property: 'schema:author',
      target,
      mode: 'replace',
      selection: [{ candidate: proposed.candidate, rank: 'normal' }],
      expected_head: null,
    });
  }
  const partitions = [...new Set([partitionOf(route), part(claim.id), part(target), ...sources.map(part)])];
  return { source, route, claim: claim.id as string, target, sources, candidates, partitions };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function relay(pageSize = 2): Promise<Relay> {
  // Variable import is deliberate: this specification typechecks before the implementation exists.
  const path = '../../src/semantic/relation-facet-rebuilds.ts';
  expect(
    await Bun.file(new URL(path, import.meta.url)).exists(),
    'SEMANTIC must provide the independent relationFacetRebuilds Relay',
  ).toBe(true);
  const module = (await import(path)) as {
    relationFacetRebuilds(options: { pool: typeof db.pool; routeKey: Uint8Array; pageSize: number }): Relay;
  };
  expect(typeof module.relationFacetRebuilds).toBe('function');
  const worker = module.relationFacetRebuilds({ pool: db.pool, routeKey, pageSize });
  expect(worker.consumer).toBe(consumer);
  return worker;
}
async function drain(worker: Relay, partitions: number[]) {
  for (let round = 0; round < 1000; round++) {
    let work = 0;
    for (const partition of partitions) {
      const result = await worker.run(partition);
      expect(result.status).toBe('read');
      if (result.status === 'read') work += result.envelopes;
    }
    if (!work) return;
  }
  throw new Error('Facet rebuild relay did not converge');
}
async function fence(f: Fixture, key = randomUUID()) {
  return post(
    '/v1/sourceFences:takedown',
    {
      source: f.source.source,
      externalId: f.source.external_id,
      fieldGroup: 'facts',
      reason: 'Imported relation disclosure withdrawn',
    },
    key,
  );
}
async function events(f: Fixture) {
  const result = await db.admin.query<{ partition_no: number; subject: string; data: any }>(
    `SELECT partition_no,subject,data FROM core.outbox WHERE type=$1 AND data->>'external_id'=$2
     ORDER BY subject,data->>'securityRevision'`,
    [changed, f.source.external_id],
  );
  return result.rows;
}
async function assertSources(f: Fixture, expected = f.sources, revision = '1') {
  const rows = await events(f);
  expect(rows.map((row) => row.subject).sort()).toEqual([...expected].sort());
  const schema = (SEMANTIC_EVENTS as Record<string, unknown>)[changed];
  expect(schema, 'The emitting module registers the additive subject event').toBeDefined();
  for (const row of rows) {
    expect(row.partition_no).toBe(part(row.subject));
    expect(row.subject).not.toBe(f.target);
    expect(Value.Check(schema as Parameters<typeof Value.Check>[0], row.data)).toBe(true);
    expect(row.data).toEqual({
      route: f.route,
      source: f.source.source,
      external_id: f.source.external_id,
      field_group: 'facts',
      securityRevision: revision,
      cause: JSON.stringify([f.route, f.source.source, f.source.external_id, 'facts', revision, row.subject]),
    });
  }
}
async function rewind(partitions: number[]) {
  // A lost checkpoint after downstream commits is a real projectBatch replay, not a fake apply callback.
  await db.admin.query(
    'UPDATE core.consumer_checkpoint SET epoch=NULL,position=0 WHERE consumer=$1 AND partition_no=ANY($2)',
    [consumer, partitions],
  );
}

test('fencing an imported facet rebuilds every affected source and never its target', async () => {
  const f = await fixture(9); // More than four dependency pages, including arbitrary OTHER subjects.
  expect(f.sources).not.toContain(f.claim);
  const claim = await db.admin.query(
    'SELECT subject_id FROM semantic.external_claim WHERE route=$1 AND source=$2 AND external_id=$3',
    [f.route, f.source.source, f.source.external_id],
  );
  expect(claim.rows[0].subject_id).toBe(f.claim);
  const worker = await relay();
  await drain(worker, f.partitions);
  expect(await events(f)).toEqual([]);
  await fence(f);
  await drain(worker, f.partitions);
  await assertSources(f);
  // Independent log consumer validates registered event schemas and complete real envelopes.
  for (const partition of f.partitions) {
    for (;;) {
      const result = await projectBatch(db.pool, {
        consumer: 'facet_acceptance_audit',
        partition,
        apply: async () => {},
      });
      expect(result.status).toBe('read');
      if (result.status === 'read' && !result.envelopes) break;
    }
  }
});

test('late dependency registration observes an already committed fence', async () => {
  const f = await fixture();
  await fence(f);
  // No asynchronous worker has run. Immediate Content disclosure remains authoritative independently.
  const fences = await withConnection(db.pool, (client) =>
    readFences(client, [
      { route: f.route, source: f.source.source, external_id: f.source.external_id, field_group: 'facts' },
    ]),
  );
  expect(fences[0]).toMatchObject({ takenDown: true, securityRevision: '1' });
  expect(await events(f)).toEqual([]);
  const worker = await relay();
  await drain(worker, [partitionOf(f.route)]); // Fence reaches tuple home before source registration.
  expect(await events(f)).toEqual([]);
  await drain(worker, f.partitions);
  await assertSources(f);
});

test('dependency and fence event replay coalesce source rebuild work', async () => {
  const f = await fixture(7);
  const worker = await relay();
  await drain(worker, f.partitions);
  const key = randomUUID();
  await fence(f, key);
  await fence(f, key); // Content receipt replay must not increment the fence.
  await worker.run(partitionOf(f.route)); // Commit one page and leave its durable continuation pending.
  await rewind(f.partitions);
  await drain(worker, f.partitions);
  await assertSources(f);
  const beforeReplay = await db.admin.query(
    "SELECT type,count(*)::integer AS count FROM core.outbox WHERE data->>'external_id'=$1 GROUP BY type ORDER BY type",
    [f.source.external_id],
  );
  expect(beforeReplay.rows.find((row) => row.type === continuation)?.count).toBe(3);
  await rewind(f.partitions);
  await drain(worker, f.partitions);
  await assertSources(f);
  const afterReplay = await db.admin.query(
    "SELECT type,count(*)::integer AS count FROM core.outbox WHERE data->>'external_id'=$1 GROUP BY type ORDER BY type",
    [f.source.external_id],
  );
  expect(afterReplay.rows).toEqual(beforeReplay.rows);
  // A genuinely new monotonic fence cause is allowed once per source, even when old envelopes replay later.
  await fence(f);
  await drain(worker, f.partitions);
  await rewind(f.partitions);
  await drain(worker, f.partitions);
  const rows = await events(f);
  expect(rows).toHaveLength(f.sources.length * 2);
  for (const subject of f.sources)
    expect(
      rows
        .filter((row) => row.subject === subject)
        .map((row) => row.data.securityRevision)
        .sort(),
    ).toEqual(['1', '2']);
  const checkpoints = await db.admin.query(
    `SELECT c.position=p.position AS caught_up
    FROM core.consumer_checkpoint c JOIN core.partition p USING(partition_no)
    WHERE c.consumer=$1 AND c.partition_no=ANY($2)`,
    [consumer, f.partitions],
  );
  expect(checkpoints.rows).toHaveLength(f.partitions.length);
  expect(checkpoints.rows.every((row) => row.caught_up)).toBe(true);
  const work = await db.admin.query("SELECT type FROM core.outbox WHERE type=ANY($1) AND data->>'external_id'=$2", [
    [dependency, continuation],
    f.source.external_id,
  ]);
  expect(work.rows.some((row) => row.type === continuation)).toBe(true);
});

test('nonfacet and retracted dependencies do not enqueue facet source rebuilds', async () => {
  const survivor = await create();
  const f = await fixture(4);
  f.partitions.push(part(survivor));
  const merged = await post('/v1/subjects:merge', { subjects: [f.sources[2], survivor] });
  expect(merged.redirected).toBe(f.sources[2]);
  await post(`/v1/subjects/${f.sources[3]}:takedown`, {
    notice: { complaint: 'Source removed', received_at: '2026-10-25T09:00:00Z' },
  });
  const nonfacet = await create();
  f.partitions.push(part(nonfacet));
  await batch({
    op: 'propose',
    key: randomUUID(),
    source: f.source,
    subject: nonfacet,
    statement: { ...snak('schema:contributor', f.target), qualifiers: [], references },
  });
  await batch({
    op: 'retract',
    key: randomUUID(),
    source: f.source,
    subject: f.sources[0],
    candidate: f.candidates[0],
    references,
  });
  const worker = await relay();
  await drain(worker, f.partitions);
  // Deliver old source registrations after the retraction was already applied at tuple home.
  await rewind(f.sources.map(part));
  await drain(worker, f.partitions);
  await fence(f);
  await drain(worker, f.partitions);
  await assertSources(f, [f.sources[1]!]);
  await rewind(f.partitions);
  await drain(worker, f.partitions);
  await assertSources(f, [f.sources[1]!]);
});
