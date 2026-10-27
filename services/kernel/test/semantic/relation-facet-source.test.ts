import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import pg, { type Pool } from 'pg';
import { classifyUnavailability } from '../../src/access/unavailable.ts';
import { tupleRoute } from '../../src/content/imported-contract.ts';
import type { Relay } from '../../src/events/relays.ts';
import * as semanticSource from '../../src/semantic/search-source.ts';
import { releaseDigest, valueSchema, type Release } from '@rezics/definitions';
import { bundledRelease } from '@rezics/definitions/bundled';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { createPool } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { anchorRoute, newId, partitionOf, routeOf } from '../../src/route/route.ts';
import {
  MAX_RELATION_FACET_VALUES,
  MAX_RELATION_FACET_PROBES,
  subjectPartition,
  type IndexedSubject,
  type RelationFacetProbe as SharedRelationFacetProbe,
} from '../../src/search/source.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { subjectSource } from '../../src/semantic/search-source.ts';
import { capture, checkGrowth, openGrowthDatabase } from '../support/growth.ts';
import { createRealAccess } from './real-access.ts';
import { statementBindings } from './support/sql-guard.ts';

// Narrow the shared probe to the approved unqualified input while Search updates its declaration.
// Missing production support remains an assertion failure.
type RelationFacetProbe = Pick<SharedRelationFacetProbe, 'subject' | 'property' | 'value'>;
type Probe = RelationFacetProbe;
type ExpectedPort = { matchRelationFacets?: (partition: number, probes: readonly Probe[]) => Promise<boolean[]> };
type SnapshotSubject = IndexedSubject & { relationFacetOverflow?: string[] };
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(url);
const admin = new pg.Pool({ connectionString: url, max: 2 });
const routeKey = new Uint8Array(32).fill(81);
const source = subjectSource(pool, routeKey);
const actions = [
  'subject:create',
  'subject:read',
  'statement:propose',
  'context:accept',
  'context:adopt',
  'moderation:hide',
  'moderation:takedown',
  'subject:batch_write',
  'source_fence:takedown',
];
const editor = newId(30000);
const access = await createRealAccess(admin, { editor }, actions);
const kernel = createKernel({
  pool,
  routeKey,
  access: access.access,
  writeRate: createWriteRateLimiter({
    secret: 'semantic-relation-facet-source-test-secret',
    overrides: JSON.stringify(
      Object.fromEntries(
        ['anonymous', 'new-account', 'member', 'trusted', 'service'].map((principal) => [
          principal,
          { write: { maximum: 100000, seconds: 60 } },
        ]),
      ),
    ),
  }),
});
const property = (id: string, extra: object = {}) => ({
  iri: `https://example.test/${id.slice(3)}`,
  labels: { en: id },
  mappings: [],
  datatype: 'wikibase-item' as const,
  multivalued: true,
  qualifiers: [],
  targets: ['schema:Person'],
  value: valueSchema('wikibase-item'),
  ...extra,
});
// Keep Book author coverage, while isolating declarations from the bundled release and frozen Search tests.
const release: Release = structuredClone(bundledRelease);
release.catalogue = { id: 'https://example.test/relation-facets', version: '1' };
release.prefixes.ex = 'https://example.test/';
release.filters = {};
release.properties['ex:key'] = property('ex:key');
release.properties['ex:credit'] = property('ex:credit', {
  qualifiers: ['ex:key'],
  relation: { group: 'credit', inverse: 'none', order: 'name', slotKey: 'ex:key' },
});
release.properties['ex:related'] = property('ex:related', {
  relation: { group: 'association', inverse: 'none', order: 'name' },
});
release.types['schema:Book']!.properties = ['ex:credit', 'ex:related', 'schema:author', 'schema:inLanguage'];
release.types['schema:Book']!.facets = ['schema:author', 'ex:credit', 'schema:inLanguage'];
const digest = releaseDigest(release);
const snak = (property: string, content: string) => ({ property: { id: property }, value: { type: 'value', content } });
const statement = (property: string, target: string, qualifiers: ReturnType<typeof snak>[] = []) => ({
  ...snak(property, target),
  qualifiers,
});

beforeAll(async () => {
  for (const action of actions) await access.grant({ route: 0, id: GLOBAL_CONTEXT }, 'editor', action);
  await bootstrapRelease(pool, release);
});
afterAll(async () => {
  await pool.end();
  await admin.end();
});
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
  expect([response.status, result.code], `${path}: ${JSON.stringify(result)}`).toEqual([
    path.endsWith('/subjects') || path.endsWith('/candidates') ? 201 : 200,
    undefined,
  ]);
  return result;
}
async function create(type = 'schema:Person', statements = {}) {
  return (await post('/v1/subjects', { type, labels: { en: 'Relation facet fixture' }, statements })).subject;
}
async function snapshot(id: string): Promise<SnapshotSubject> {
  const result = await source.read(subjectPartition(id), [id]);
  expect(result.subjects).toHaveLength(1);
  return result.subjects[0]!;
}
function matcher(port: ExpectedPort = source as ExpectedPort) {
  expect(typeof port.matchRelationFacets, 'semantic source must provide matchRelationFacets').toBe('function');
  return port.matchRelationFacets!.bind(port);
}
const values = (subject: SnapshotSubject, property: string) =>
  subject.statements.filter((row) => row.property === property);
async function propose(subject: string, property: string, target: string, qualifiers: ReturnType<typeof snak>[] = []) {
  return (
    await post(`/v1/subjects/${subject}/candidates`, {
      statement: {
        ...statement(property, target, qualifiers),
        references: [{ parts: [snak('schema:url', 'https://example.test/evidence')] }],
      },
    })
  ).candidate as string;
}
async function accept(subject: string, candidate: string) {
  await post(`/v1/subjects/${subject}/candidates/${candidate}:accept`, {
    context: GLOBAL_CONTEXT,
    expected_head: null,
  });
}
async function adopt(
  subject: string,
  property: string,
  target: string,
  candidates: string[],
  expectedHead: number | null,
  key?: string,
) {
  return (
    await post(`/v1/subjects/${subject}:adopt`, {
      context: GLOBAL_CONTEXT,
      property,
      target,
      ...(key ? { key } : {}),
      mode: 'replace',
      selection: candidates.map((candidate) => ({ candidate, rank: 'normal' })),
      expected_head: expectedHead,
    })
  ).adoption.head as number;
}

test('a snapshot includes visible adopted outgoing relation facets but no nonfacet or incoming relations', async () => {
  const [author, role, pendingTarget, unrelated] = await Promise.all([
    create(),
    create('skos:Concept'),
    create('skos:Concept'),
    create(),
  ]);
  const book = await create('schema:Book', {
    'schema:author': [statement('schema:author', author.id, [snak('wdt:P3831', role.id)])],
    'ex:related': [statement('ex:related', unrelated.id)],
    'schema:inLanguage': [statement('schema:inLanguage', 'ja')],
  });
  const pending = await propose(book.id, 'schema:author', author.id, [snak('wdt:P3831', pendingTarget.id)]);
  const before = await snapshot(book.id);
  // Evaluate after expansion: the pending candidate must not displace the compact adoption.
  expect(values(before, 'schema:author')).toEqual([
    {
      property: 'schema:author',
      value: author.id,
      facet: { kind: 'item' },
      qualifiers: [{ property: 'wdt:P3831', value: role.id }],
    },
  ]);
  expect(before.relationFacetOverflow, 'production snapshots emit an empty overflow list').toEqual([]);
  expect(values(before, 'ex:related')).toEqual([]);
  expect(values(before, 'schema:inLanguage')).toEqual([
    { property: 'schema:inLanguage', value: 'ja', facet: { kind: 'code' } },
  ]);
  expect(values(await snapshot(author.id), 'schema:author')).toEqual([]);
  await accept(book.id, pending);
  const head = await adopt(book.id, 'schema:author', author.id, [pending], 1);
  expect(values(await snapshot(book.id), 'schema:author')[0]!.qualifiers).toEqual([
    { property: 'wdt:P3831', value: pendingTarget.id },
  ]);
  await adopt(book.id, 'schema:author', author.id, [], head); // Global suppression is an empty replace.
  expect(values(await snapshot(book.id), 'schema:author')).toEqual([]);
  // A selected candidate cannot be rejected until it has been removed from the adoption.
  await post(`/v1/subjects/${book.id}/candidates/${pending}:reject`, { context: GLOBAL_CONTEXT, expected_head: 1 });
  expect(values(await snapshot(book.id), 'schema:author')).toEqual([]);
  const nextAuthor = await create();
  const next = await propose(book.id, 'schema:author', nextAuthor.id);
  expect(values(await snapshot(book.id), 'schema:author')).toEqual([]);
  await accept(book.id, next);
  expect(values(await snapshot(book.id), 'schema:author')).toEqual([]);
  const nextHead = await adopt(book.id, 'schema:author', nextAuthor.id, [next], null);
  expect(values(await snapshot(book.id), 'schema:author').map((row) => row.value)).toEqual([nextAuthor.id]);
  await post(`/v1/subjects/${book.id}/candidates/${next}:hide`, { reason: 'Selected relation moderated' });
  expect(values(await snapshot(book.id), 'schema:author')).toEqual([]);
  await post(`/v1/subjects/${book.id}/candidates/${next}:takedown`, {
    notice: { complaint: 'Rights holder notice.', received_at: '2026-10-25T09:00:00Z' },
  });
  expect(values(await snapshot(book.id), 'schema:author')).toEqual([]);
  await post(`/v1/subjects/${book.id}/candidates/${next}:restore`, { reason: 'Selected relation restored' });
  expect(values(await snapshot(book.id), 'schema:author').map((row) => row.value)).toEqual([nextAuthor.id]);
  await adopt(book.id, 'schema:author', nextAuthor.id, [], nextHead);
  expect(values(await snapshot(book.id), 'schema:author')).toEqual([]);
  expect(values(await snapshot(book.id), 'schema:inLanguage')).toEqual([
    { property: 'schema:inLanguage', value: 'ja', facet: { kind: 'code' } },
  ]);
});

test('a relation facet snapshot has at most 128 values and reports overflow', async () => {
  const targets: { id: string }[] = [];
  for (let index = 0; index < 129; index++) targets.push(await create());
  const book = await create('schema:Book');
  const samples: SnapshotSubject[] = [];
  for (let index = 0; index < targets.length; index++) {
    const candidate = await propose(book.id, 'schema:author', targets[index]!.id);
    await accept(book.id, candidate);
    await adopt(book.id, 'schema:author', targets[index]!.id, [candidate], null);
    if ([0, 127, 128].includes(index)) samples.push(await snapshot(book.id));
  }
  expect(values(samples[0]!, 'schema:author')).toHaveLength(1);
  expect(samples[0]!.relationFacetOverflow).toEqual([]);
  expect(values(samples[1]!, 'schema:author')).toHaveLength(128);
  expect(samples[1]!.relationFacetOverflow).toEqual([]);
  const last = samples[2]!;
  expect(values(last, 'schema:author')).toHaveLength(128);
  expect(last.relationFacetOverflow).toEqual(['schema:author']);
  expect((await snapshot(book.id)).statements).toEqual(last.statements);
  const sampled = new Set(values(last, 'schema:author').map((row) => row.value));
  const omitted = targets.find((target) => !sampled.has(target.id))!;
  expect(omitted).toBeDefined();
  expect(
    await matcher()(subjectPartition(book.id), [
      { subject: book.id, property: 'schema:author', value: omitted.id },
      { subject: book.id, property: 'schema:author', value: newId(routeOf(book.id)!) },
    ]),
  ).toEqual([true, false]);
}, 120_000);

test('unqualified relation facet point probes enforce immediate visibility beyond the sample', async () => {
  const [target, absent] = await Promise.all([create(), create()]);
  const targets = [target];
  for (let index = 0; index < MAX_RELATION_FACET_VALUES; index++) targets.push(await create());
  const book = await create('schema:Book');
  const candidates = new Map<string, string>();
  for (const value of targets) {
    const candidate = await propose(book.id, 'schema:author', value.id);
    await accept(book.id, candidate);
    await adopt(book.id, 'schema:author', value.id, [candidate], null);
    candidates.set(value.id, candidate);
  }
  const match = matcher();
  const indexed = await snapshot(book.id);
  const sampled = new Set(values(indexed, 'schema:author').map(({ value }) => value));
  const outside = targets.find(({ id }) => !sampled.has(id))!;
  expect(outside).toBeDefined();
  const probe: Probe = { subject: book.id, property: 'schema:author', value: outside.id };
  const inside: Probe = { ...probe, value: values(indexed, 'schema:author')[0]!.value };
  const candidate = candidates.get(outside.id)!;
  // No projection/rebuild worker is running: committed writes must suppress disclosure immediately.
  expect(await match(subjectPartition(book.id), [probe, inside, { ...probe, value: absent.id }])).toEqual([
    true,
    true,
    false,
  ]);
  await post(`/v1/subjects/${book.id}/candidates/${candidate}:hide`, { reason: 'Hide after indexing' });
  const hidden = await admin.query(
    'SELECT visibility FROM semantic.hidden_candidate WHERE route=$1 AND subject_id=$2 AND candidate_id=$3',
    [routeOf(book.id), book.id, candidate],
  );
  expect(hidden.rows).toEqual([{ visibility: 'hidden' }]);
  expect(await match(subjectPartition(book.id), [probe])).toEqual([false]);
  const hiddenSnapshot = await snapshot(book.id);
  expect(values(hiddenSnapshot, 'schema:author')).toHaveLength(MAX_RELATION_FACET_VALUES);
  expect(values(hiddenSnapshot, 'schema:author').map(({ value }) => value)).not.toContain(outside.id);
  expect(hiddenSnapshot.relationFacetOverflow).toEqual([]);
  await post(`/v1/subjects/${book.id}/candidates/${candidate}:takedown`, {
    notice: { complaint: 'Rights holder notice.', received_at: '2026-10-25T09:00:00Z' },
  });
  expect(await match(subjectPartition(book.id), [probe])).toEqual([false]);
  await post(`/v1/subjects/${book.id}/candidates/${candidate}:restore`, { reason: 'Restore after review' });
  expect(await match(subjectPartition(book.id), [probe])).toEqual([true]);
  // Positive hits inside the sample need exactly the same immediate suppression.
  await post(`/v1/subjects/${book.id}/candidates/${candidates.get(inside.value)!}:hide`, {
    reason: 'Sampled hit hidden',
  });
  expect(await match(subjectPartition(book.id), [inside])).toEqual([false]);
  await post(`/v1/subjects/${book.id}:hide`, { reason: 'Source hidden' });
  expect(await match(subjectPartition(book.id), [probe])).toEqual([false]);
  await post(`/v1/subjects/${book.id}:restore`, { reason: 'Source restored' });
  expect(await match(subjectPartition(book.id), [probe])).toEqual([true]);
}, 120_000);

test('unqualified same-target slotKey probes keep surviving visible statements', async () => {
  const [target, firstKey, secondKey] = await Promise.all([create(), create(), create()]);
  const book = await create('schema:Book');
  const first = await propose(book.id, 'ex:credit', target.id, [snak('ex:key', firstKey.id)]);
  const second = await propose(book.id, 'ex:credit', target.id, [snak('ex:key', secondKey.id)]);
  for (const [candidate, key] of [
    [first, firstKey.id],
    [second, secondKey.id],
  ]) {
    await accept(book.id, candidate!);
    await adopt(book.id, 'ex:credit', target.id, [candidate!], null, key!);
  }
  const stored = await admin.query(
    'SELECT candidate_id FROM semantic.candidate WHERE route=$1 AND subject_id=$2 AND property=$3',
    [routeOf(book.id), book.id, 'ex:credit'],
  );
  expect(stored.rows).toHaveLength(2);
  const match = matcher();
  const probe: Probe = { subject: book.id, property: 'ex:credit', value: target.id };
  expect(await match(subjectPartition(book.id), [probe])).toEqual([true]);
  expect(values(await snapshot(book.id), 'ex:credit').map(({ value }) => value)).toEqual([target.id]);
  await post(`/v1/subjects/${book.id}/candidates/${first}:hide`, { reason: 'One witness hidden' });
  expect(await match(subjectPartition(book.id), [probe, probe])).toEqual([true, true]);
  await post(`/v1/subjects/${book.id}/candidates/${second}:hide`, { reason: 'Last witness hidden' });
  expect(await match(subjectPartition(book.id), [probe])).toEqual([false]);
  await post(`/v1/subjects/${book.id}/candidates/${first}:restore`, { reason: 'Witness restored' });
  expect(await match(subjectPartition(book.id), [probe])).toEqual([true]);
});

test('relation facet point reads reject foreign anchors and more than 256 probes', async () => {
  const db = await openGrowthDatabase(url);
  try {
    const match = matcher(subjectSource(db.pool, routeKey) as ExpectedPort);
    const target = await create();
    let bookKey = randomUUID();
    while (partitionOf(anchorRoute(routeKey, `${editor}\nsubject.create\n${bookKey}`)) === subjectPartition(target.id))
      bookKey = randomUUID();
    const book = (
      await post(
        '/v1/subjects',
        {
          type: 'schema:Book',
          labels: { en: 'Cross partition target' },
          statements: { 'schema:author': [statement('schema:author', target.id)] },
        },
        bookKey,
      )
    ).subject;
    const subject = book.id as string;
    const partition = subjectPartition(subject);
    let neighborKey = randomUUID();
    while (partitionOf(anchorRoute(routeKey, `${editor}\nsubject.create\n${neighborKey}`)) !== partition)
      neighborKey = randomUUID();
    const neighbor = (
      await post('/v1/subjects', { type: 'schema:Book', labels: { en: 'Same partition neighbor' } }, neighborKey)
    ).subject.id as string;
    expect(subjectPartition(neighbor)).toBe(partition);
    const foreign = newId(((partition + 1) % 4096) * 16);
    expect(subjectPartition(target.id)).not.toBe(partition);
    const probe: Probe = { subject, property: 'schema:author', value: target.id };
    for (const [part, probes] of [
      [-1, [probe]],
      [4096, [probe]],
      [0.5, [probe]],
      [NaN, [probe]],
      [partition, [{ ...probe, subject: 'malformed' }]],
      [partition, [probe, { ...probe, subject: foreign }]],
      [partition, Array.from({ length: MAX_RELATION_FACET_PROBES + 1 }, () => probe)],
      // Qualifiers are not part of this port; never silently strip an unsupported predicate.
      [partition, [{ ...probe, qualifiers: [{ property: 'ex:key', in: [target.id] }] } as Probe]],
    ] as [number, Probe[]][]) {
      const measured = await capture(db, async () => {
        await expect(match(part, probes)).rejects.toThrow();
      });
      expect(measured.capture.statements, 'invalid input must fail before any data SQL').toHaveLength(0);
    }
    expect(await match(partition, [])).toEqual([]);
    const probes = Array.from({ length: MAX_RELATION_FACET_PROBES }, (_, index) => ({
      ...probe,
      subject: index % 2 ? neighbor : subject,
    }));
    expect(await match(partition, probes)).toEqual(probes.map(({ subject: id }) => id === subject));
    for (const { file, binding } of await statementBindings(db.admin, 'search-source.ts'))
      expect(binding, `${file} must bind exactly one partition`).toMatchObject({ bound: true });
  } finally {
    await db.close();
  }
});

test('relation facet final disclosure denies hidden targets and fenced or retracted adopted imports', async () => {
  const match = matcher();
  const target = await create();
  const book = await create('schema:Book', { 'schema:author': [statement('schema:author', target.id)] });
  const probe: Probe = { subject: book.id, property: 'schema:author', value: target.id };
  expect(await match(subjectPartition(book.id), [probe])).toEqual([true]);
  await snapshot(book.id);
  await post(`/v1/subjects/${target.id}:hide`, { reason: 'Target hidden after indexing' });
  expect(await match(subjectPartition(book.id), [probe])).toEqual([false]);
  expect(values(await snapshot(book.id), 'schema:author')).toEqual([]);
  await post(`/v1/subjects/${target.id}:restore`, { reason: 'Target restored' });
  expect(await match(subjectPartition(book.id), [probe])).toEqual([true]);
  const imported = {
    source: 'openlibrary',
    external_id: randomUUID(),
    record_revision: 'unversioned',
    digest: 'c'.repeat(64),
    converter_revision: 'openlibrary@1',
    field_group: 'facts',
  };
  const importedTarget = await create();
  const batch = async (commands: unknown[]) => post('/v1/subjects:batchWrite', { commands });
  const proposed = await batch([
    {
      op: 'propose',
      key: 'relation',
      source: imported,
      subject: book.id,
      statement: {
        ...statement('schema:author', importedTarget.id),
        references: [{ parts: [snak('schema:url', 'https://example.test/record')] }],
      },
    },
  ]);
  expect(proposed.results[0].status).toBe(201);
  const candidate = proposed.results[0].value.candidate as string;
  const importedProbe = { ...probe, value: importedTarget.id };
  expect(await match(subjectPartition(book.id), [importedProbe])).toEqual([false]);
  await accept(book.id, candidate);
  expect(await match(subjectPartition(book.id), [importedProbe])).toEqual([false]);
  const importedHead = await adopt(book.id, 'schema:author', importedTarget.id, [candidate], null);
  expect(await match(subjectPartition(book.id), [importedProbe])).toEqual([true]);
  const retracted = await batch([
    {
      op: 'retract',
      key: 'remove-relation',
      source: imported,
      subject: book.id,
      candidate,
      references: [{ parts: [snak('schema:url', 'https://example.test/retraction')] }],
    },
  ]);
  expect(retracted.results[0].status).toBe(200);
  expect(await match(subjectPartition(book.id), [importedProbe])).toEqual([false]);
  expect(values(await snapshot(book.id), 'schema:author').map((row) => row.value)).toEqual([target.id]);
  const replacement = await batch([
    {
      op: 'propose',
      key: 'new-relation',
      source: imported,
      subject: book.id,
      statement: {
        ...statement('schema:author', importedTarget.id),
        references: [{ parts: [snak('schema:url', 'https://example.test/new-record')] }],
      },
    },
  ]);
  expect(replacement.results[0].status).toBe(201);
  const replacementId = replacement.results[0].value.candidate as string;
  await accept(book.id, replacementId);
  await adopt(book.id, 'schema:author', importedTarget.id, [replacementId], importedHead);
  expect(await match(subjectPartition(book.id), [importedProbe])).toEqual([true]);
  const indexed = await snapshot(book.id);
  await post('/v1/sourceFences:takedown', {
    source: imported.source,
    externalId: imported.external_id,
    fieldGroup: 'facts',
    reason: 'Fence after indexing',
  });
  expect(await match(subjectPartition(book.id), [importedProbe, probe])).toEqual([false, true]);
  expect(values(await snapshot(book.id), 'schema:author').map((row) => row.value)).toEqual([target.id]);
  // Release identity and old sampled evidence cannot authorize disclosure.
  expect(indexed.statements).toContainEqual(
    expect.objectContaining({ property: 'schema:author', value: importedTarget.id }),
  );
  const current = await admin.query('SELECT current_release FROM semantic.subject WHERE route=$1 AND subject_id=$2', [
    routeOf(book.id),
    book.id,
  ]);
  expect(current.rows[0].current_release).toBe(digest);
});

test('a fenced same-target statement does not conceal a surviving adopted slotKey statement', async () => {
  const [target, importedKey, localKey] = await Promise.all([create(), create(), create()]);
  const book = await create('schema:Book');
  const imported = {
    source: 'openlibrary',
    external_id: randomUUID(),
    record_revision: 'unversioned',
    digest: 'd'.repeat(64),
    converter_revision: 'openlibrary@1',
    field_group: 'facts',
  };
  const result = await post('/v1/subjects:batchWrite', {
    commands: [
      {
        op: 'propose',
        key: 'import',
        source: imported,
        subject: book.id,
        statement: {
          ...statement('ex:credit', target.id, [snak('ex:key', importedKey.id)]),
          references: [{ parts: [snak('schema:url', 'https://example.test/record')] }],
        },
      },
    ],
  });
  expect(result.results[0].status).toBe(201);
  const importedCandidate = result.results[0].value.candidate as string;
  const localCandidate = await propose(book.id, 'ex:credit', target.id, [snak('ex:key', localKey.id)]);
  for (const [candidate, key] of [
    [importedCandidate, importedKey.id],
    [localCandidate, localKey.id],
  ]) {
    await accept(book.id, candidate!);
    await adopt(book.id, 'ex:credit', target.id, [candidate!], null, key!);
  }
  const match = matcher();
  const probe: Probe = { subject: book.id, property: 'ex:credit', value: target.id };
  expect(await match(subjectPartition(book.id), [probe])).toEqual([true]);
  await snapshot(book.id);
  await post('/v1/sourceFences:takedown', {
    source: imported.source,
    externalId: imported.external_id,
    fieldGroup: 'facts',
    reason: 'Fence one witness',
  });
  // No consumer has run since indexing. Both truth and the alternative witness must be current.
  expect(await match(subjectPartition(book.id), [probe])).toEqual([true]);
  await post(`/v1/subjects/${book.id}/candidates/${localCandidate}:hide`, { reason: 'Remove last visible witness' });
  expect(await match(subjectPartition(book.id), [probe])).toEqual([false]);
  await post(`/v1/subjects/${book.id}/candidates/${localCandidate}:restore`, { reason: 'Restore visible witness' });
  expect(await match(subjectPartition(book.id), [probe])).toEqual([true]);
});

test('relation facet point probe uncertainty fails the whole request as unavailable', async () => {
  const target = await create();
  const book = await create('schema:Book', { 'schema:author': [statement('schema:author', target.id)] });
  // Exhaust a real pool, leaving the real source unable to acquire current evidence.
  const unavailablePool = new pg.Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 1000 });
  const held = await unavailablePool.connect();
  try {
    const match = matcher(subjectSource(unavailablePool, routeKey) as ExpectedPort);
    const probes: Probe[] = [
      { subject: book.id, property: 'schema:author', value: target.id },
      { subject: book.id, property: 'schema:author', value: newId(30000) },
    ];
    let failure: unknown;
    try {
      await match(subjectPartition(book.id), probes);
    } catch (error) {
      failure = error;
    }
    expect(failure, 'uncertainty must reject, never return partial or invented booleans').toBeDefined();
    expect(classifyUnavailability(failure)).toBe('overloaded');
  } finally {
    held.release();
    await unavailablePool.end();
  }
});

// Direct semantic peer proposal. Until it exists this fails at the owned missing hook, not an import/type error.
// enqueue's cause is a stable idempotency key; the durable Search queue must upsert it.
type RebuildFactory = (options: {
  pool: Pool;
  consumer: string;
  pageSize: number;
  enqueue: (partition: number, subjects: readonly string[], cause: string) => Promise<void>;
}) => Relay;
function rebuildFactory(): RebuildFactory {
  const factory = (semanticSource as unknown as { relationFacetRebuilds?: RebuildFactory }).relationFacetRebuilds;
  expect(typeof factory, 'missing semantic source-only relationFacetRebuilds outbox hook').toBe('function');
  return factory!;
}
async function drain(relay: Relay, partitions: number[]) {
  for (const partition of new Set(partitions)) {
    for (let page = 0; ; page++) {
      expect(page, 'consumer must make bounded forward progress').toBeLessThan(10000);
      const result = await relay.run(partition);
      expect(result.status).toBe('read');
      if (result.status !== 'read' || result.envelopes === 0) break;
    }
  }
}

test('relation facet changes and visibility changes rebuild only their source subject', async () => {
  const factory = rebuildFactory();
  const target = await create();
  const book = await create('schema:Book');
  const queued = new Map<string, { partition: number; subjects: readonly string[] }>();
  const relay = factory({
    pool,
    consumer: `facet_test_${randomUUID().replaceAll('-', '')}`,
    pageSize: 1,
    enqueue: async (partition, subjects, cause) => {
      expect(subjects.length).toBeLessThanOrEqual(1);
      const request = { partition, subjects };
      if (queued.has(cause)) expect(queued.get(cause)).toEqual(request);
      queued.set(cause, request);
    },
  });
  const partitions = [subjectPartition(book.id), subjectPartition(target.id)];
  await drain(relay, partitions);
  queued.clear();
  const changed = async (operation: () => Promise<unknown>, expected: string[]) => {
    queued.clear();
    const before = await admin.query(
      'SELECT partition_no, epoch, position FROM core.consumer_checkpoint WHERE consumer=$1 AND partition_no=ANY($2::int[])',
      [relay.consumer, partitions],
    );
    await operation();
    await drain(relay, partitions);
    const requests = [...queued.values()];
    expect([...new Set(requests.flatMap(({ subjects }) => subjects))].sort()).toEqual(expected.slice().sort());
    for (const request of requests) {
      expect(request.partition).toBe(subjectPartition(book.id));
      expect(request.subjects).not.toContain(target.id);
    }
    const previous = [...queued];
    // Re-deliver the real envelopes by rewinding only this test's owned consumer.
    for (const checkpoint of before.rows)
      await admin.query(
        'UPDATE core.consumer_checkpoint SET epoch=$1, position=$2 WHERE consumer=$3 AND partition_no=$4',
        [checkpoint.epoch, checkpoint.position, relay.consumer, checkpoint.partition_no],
      );
    await drain(relay, partitions);
    expect([...queued], 'replaying the consumer has no new logical rebuild requests').toEqual(previous);
  };
  let candidate = '';
  await changed(async () => {
    candidate = await propose(book.id, 'schema:author', target.id);
  }, [book.id]);
  await changed(() => accept(book.id, candidate), [book.id]);
  let head = 0;
  await changed(async () => {
    head = await adopt(book.id, 'schema:author', target.id, [candidate], null);
  }, [book.id]);
  await changed(
    () => post(`/v1/subjects/${book.id}/candidates/${candidate}:hide`, { reason: 'Hide facet' }),
    [book.id],
  );
  await changed(
    () => post(`/v1/subjects/${book.id}/candidates/${candidate}:restore`, { reason: 'Restore facet' }),
    [book.id],
  );
  await changed(
    () =>
      post(`/v1/subjects/${book.id}/candidates/${candidate}:takedown`, {
        notice: { complaint: 'Rights holder notice.', received_at: '2026-10-25T09:00:00Z' },
      }),
    [book.id],
  );
  await changed(
    () => post(`/v1/subjects/${book.id}/candidates/${candidate}:restore`, { reason: 'Restore facet' }),
    [book.id],
  );
  await changed(() => adopt(book.id, 'schema:author', target.id, [], head), [book.id]);
  await changed(() => propose(book.id, 'ex:related', target.id), []);
  await changed(() => propose(target.id, 'schema:name', 'Updated author name'), []);
  const imported = {
    source: 'openlibrary',
    external_id: randomUUID(),
    record_revision: 'unversioned',
    digest: 'e'.repeat(64),
    converter_revision: 'openlibrary@1',
    field_group: 'facts',
  };
  // Select a remote tuple home to exercise cross-partition fanout rather than accidental local delivery.
  while (partitionOf(tupleRoute(routeKey, imported.source, imported.external_id)) === subjectPartition(book.id))
    imported.external_id = randomUUID();
  partitions.push(partitionOf(tupleRoute(routeKey, imported.source, imported.external_id)));
  await changed(async () => {
    const result = await post('/v1/subjects:batchWrite', {
      commands: [
        {
          op: 'propose',
          key: 'import',
          source: imported,
          subject: book.id,
          statement: {
            ...statement('schema:author', target.id),
            references: [{ parts: [snak('schema:url', 'https://example.test/record')] }],
          },
        },
      ],
    });
    expect(result.results[0].status).toBe(201);
    candidate = result.results[0].value.candidate;
  }, [book.id]);
  await changed(() => accept(book.id, candidate), [book.id]);
  await changed(() => adopt(book.id, 'schema:author', target.id, [candidate], head + 1), [book.id]);
  await changed(
    () =>
      post('/v1/subjects:batchWrite', {
        commands: [
          {
            op: 'retract',
            key: 'remove',
            source: imported,
            subject: book.id,
            candidate,
            references: [{ parts: [snak('schema:url', 'https://example.test/retraction')] }],
          },
        ],
      }),
    [book.id],
  );
  // Retraction removed the old tuple dependency. Propose a fresh relation under a live remote tuple before fencing.
  imported.external_id = randomUUID();
  while (partitionOf(tupleRoute(routeKey, imported.source, imported.external_id)) === subjectPartition(book.id))
    imported.external_id = randomUUID();
  partitions.push(partitionOf(tupleRoute(routeKey, imported.source, imported.external_id)));
  await drain(relay, partitions);
  await changed(async () => {
    const result = await post('/v1/subjects:batchWrite', {
      commands: [
        {
          op: 'propose',
          key: 'new-import',
          source: imported,
          subject: book.id,
          statement: {
            ...statement('schema:author', target.id),
            references: [{ parts: [snak('schema:url', 'https://example.test/new-record')] }],
          },
        },
      ],
    });
    expect(result.results[0].status).toBe(201);
  }, [book.id]);
  await changed(
    () =>
      post('/v1/sourceFences:takedown', {
        source: imported.source,
        externalId: imported.external_id,
        fieldGroup: 'facts',
        reason: 'Remote tuple fence',
      }),
    [book.id],
  );
}, 120_000);

test('relation facet rebuild consumption stays bounded per page as queued changes grow', async () => {
  const factory = rebuildFactory();
  const db = await openGrowthDatabase(url);
  try {
    const book = await create('schema:Book');
    const target = await create();
    const partition = subjectPartition(book.id);
    let measuring = false;
    const relay = factory({
      pool: db.pool,
      consumer: `facet_page_${randomUUID().replaceAll('-', '')}`,
      pageSize: 1,
      enqueue: async (part, subjects) => {
        if (!measuring) return;
        expect(part).toBe(partition);
        expect(subjects).toEqual([book.id]);
      },
    });
    await drain(relay, [partition]);
    measuring = true;
    const report = await checkGrowth(db, {
      name: 'relation facet rebuild page',
      scales: [8, 32, 128],
      warmups: 1,
      repetitions: 3,
      bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
      grow: async (_database, scale, previous) => {
        // Different references create historical candidates in the same relation slot.
        for (let index = previous; index < scale; index++)
          await post(`/v1/subjects/${book.id}/candidates`, {
            statement: {
              ...statement('schema:author', target.id),
              references: [{ parts: [snak('schema:url', `https://example.test/history/${index}`)] }],
            },
          });
      },
      operation: async () => {
        const result = await relay.run(partition);
        expect(result.status).toBe('read');
        if (result.status === 'read') expect(result.envelopes).toBe(1);
        return result;
      },
    });
    expect(report.samples).toHaveLength(3);
  } finally {
    await db.close();
  }
}, 120_000);
