import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import pg, { type Pool } from 'pg';
import { lookupEventType } from '../../src/events/catalogue.ts';
import { classifyUnavailability } from '../../src/access/unavailable.ts';
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
import { activeRelease, bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { subjectSource } from '../../src/semantic/search-source.ts';
import { capture, costOf, withoutCatalogStatements, openGrowthDatabase } from '../support/growth.ts';
import { createRealAccess } from './real-access.ts';
import { statementBindings } from './support/sql-guard.ts';

// Missing production support fails availability assertions, never module loading or typechecking.
type RelationFacetProbe = Pick<SharedRelationFacetProbe, 'subject' | 'property' | 'value'>;
type Probe = RelationFacetProbe;
type RelationFacetMatch = boolean | 'not_proven';
type ExpectedPort = {
  matchRelationFacets?: (partition: number, probes: readonly Probe[]) => Promise<RelationFacetMatch[]>;
};
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
  'definitions:publish',
  'definitions:activate',
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
    path.endsWith('/subjects') || path.endsWith('/candidates') || path.endsWith('/definitions/releases') ? 201 : 200,
    undefined,
  ]);
  return result;
}
async function create(type = 'schema:Person', statements = {}) {
  return (await post('/v1/subjects', { type, labels: { en: 'Relation facet fixture' }, statements })).subject;
}
async function snapshot(id: string, rebuild = true): Promise<SnapshotSubject> {
  if (rebuild) await catchUp(rebuildRunner(pool), subjectPartition(id));
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
  ).toEqual([true, 'not_proven']);
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
    'not_proven',
  ]);
  await post(`/v1/subjects/${book.id}/candidates/${candidate}:hide`, { reason: 'Hide after indexing' });
  const hidden = await admin.query(
    'SELECT visibility FROM semantic.hidden_candidate WHERE route=$1 AND subject_id=$2 AND candidate_id=$3',
    [routeOf(book.id), book.id, candidate],
  );
  expect(hidden.rows).toEqual([{ visibility: 'hidden' }]);
  expect(await match(subjectPartition(book.id), [probe])).toEqual(['not_proven']);
  const hiddenSnapshot = await snapshot(book.id);
  expect(values(hiddenSnapshot, 'schema:author')).toHaveLength(MAX_RELATION_FACET_VALUES);
  expect(values(hiddenSnapshot, 'schema:author').map(({ value }) => value)).not.toContain(outside.id);
  expect(hiddenSnapshot.relationFacetOverflow).toEqual([]);
  await post(`/v1/subjects/${book.id}/candidates/${candidate}:takedown`, {
    notice: { complaint: 'Rights holder notice.', received_at: '2026-10-25T09:00:00Z' },
  });
  expect(await match(subjectPartition(book.id), [probe])).toEqual(['not_proven']);
  await post(`/v1/subjects/${book.id}/candidates/${candidate}:restore`, { reason: 'Restore after review' });
  expect(await match(subjectPartition(book.id), [probe])).toEqual([true]);
  // Positive hits inside the sample need exactly the same immediate suppression.
  await post(`/v1/subjects/${book.id}/candidates/${candidates.get(inside.value)!}:hide`, {
    reason: 'Sampled hit hidden',
  });
  expect(await match(subjectPartition(book.id), [inside])).toEqual(['not_proven']);
  await post(`/v1/subjects/${book.id}:hide`, { reason: 'Source hidden' });
  expect(await match(subjectPartition(book.id), [probe])).toEqual(['not_proven']);
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
  expect(await match(subjectPartition(book.id), [probe])).toEqual(['not_proven']);
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
    expect(await match(partition, probes)).toEqual(
      probes.map(({ subject: id }) => (id === subject ? true : 'not_proven')),
    );
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
  expect(await match(subjectPartition(book.id), [probe])).toEqual(['not_proven']);
  expect(values(await snapshot(book.id), 'schema:author')).toEqual([]);
  await post(`/v1/subjects/${target.id}:restore`, { reason: 'Target restored' });
  expect(await match(subjectPartition(book.id), [probe])).toEqual([true]);
  await post(`/v1/subjects/${target.id}:takedown`, {
    notice: { complaint: 'Target rights notice.', received_at: '2026-10-25T09:00:00Z' },
  });
  expect(await match(subjectPartition(book.id), [probe])).toEqual(['not_proven']);
  expect(values(await snapshot(book.id), 'schema:author')).toEqual([]);
  await post(`/v1/subjects/${target.id}:restore`, { reason: 'Target restored after takedown' });
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
  expect(await match(subjectPartition(book.id), [importedProbe])).toEqual(['not_proven']);
  await accept(book.id, candidate);
  expect(await match(subjectPartition(book.id), [importedProbe])).toEqual(['not_proven']);
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
  expect(await match(subjectPartition(book.id), [importedProbe])).toEqual(['not_proven']);
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
  expect(await match(subjectPartition(book.id), [importedProbe, probe])).toEqual(['not_proven', true]);
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
  expect(await match(subjectPartition(book.id), [probe])).toEqual(['not_proven']);
  await post(`/v1/subjects/${book.id}/candidates/${localCandidate}:restore`, { reason: 'Restore visible witness' });
  expect(await match(subjectPartition(book.id), [probe])).toEqual([true]);
});

test('relation facet point probe I/O failure remains typed unavailable', async () => {
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
    expect(failure, 'real I/O failure must reject the whole call').toBeDefined();
    expect(classifyUnavailability(failure)).toBe('overloaded');
  } finally {
    held.release();
    await unavailablePool.end();
  }
});

// Approved production runner/relay surface, also composed by worker.ts. No test-only export.
const sourceConsumer = `facet_source_${randomUUID().replaceAll('-', '')}`;
type RebuildRunner = {
  run(partition: number): Promise<{ status: 'read' | 'busy'; examined: number; done: boolean }>;
};
type RebuildFactory = (options: {
  pool: Pool;
  routeKey: Uint8Array;
  consumer: string;
  pageSize: number;
}) => RebuildRunner;
function rebuildRunner(database: Pool, pageSize = 16, consumer = sourceConsumer) {
  const factory = (semanticSource as unknown as { relationFacetRebuilds?: RebuildFactory }).relationFacetRebuilds;
  expect(typeof factory, 'missing production relationFacetRebuilds bounded durable runner').toBe('function');
  return factory!({ pool: database, routeKey, consumer, pageSize });
}
async function catchUp(runner: RebuildRunner, partition: number, maximum = 10000) {
  for (let page = 0; page < maximum; page++) {
    const result = await runner.run(partition);
    expect(result.status).toBe('read');
    expect(result.examined).toBeLessThanOrEqual(16);
    if (result.done) return;
  }
  throw new Error('Finite quiescent witness rebuild did not converge');
}
const changedType = 'com.rezics.subject.relation_facet_changed.v1';
async function changedEvents(subject: string) {
  return (
    await admin.query(
      'SELECT partition_no, subject, data FROM core.outbox WHERE type=$1 AND subject=$2 ORDER BY position,event_seq',
      [changedType, subject],
    )
  ).rows;
}
test('a bounded witness probe suppresses hidden evidence and schedules finite rebuild convergence', async () => {
  const db = await openGrowthDatabase(url);
  try {
    const match = matcher(subjectSource(db.pool, routeKey) as ExpectedPort);
    expect(lookupEventType(changedType), 'changed event must be registered before any emitting command').toBeDefined();
    for (const overflow of [false, true]) {
      const [target, book] = await Promise.all([create(), create('schema:Book')]);
      const partition = subjectPartition(book.id);
      const imports = new Map<string, { source: string; external_id: string }>();
      // Independent imported tuples and adopted slots, not copies of a single evidence tuple.
      for (let index = 0; index < 40; index++) {
        const key = await create();
        const provenance = {
          source: 'openlibrary',
          external_id: randomUUID(),
          field_group: 'facts',
          record_revision: 'unversioned',
          digest: 'f'.repeat(64),
          converter_revision: 'openlibrary@1',
        };
        const result = await post('/v1/subjects:batchWrite', {
          commands: [
            {
              op: 'propose',
              key: 'witness',
              source: provenance,
              subject: book.id,
              statement: {
                ...statement('ex:credit', target.id, [snak('ex:key', key.id)]),
                references: [{ parts: [snak('schema:url', `https://example.test/witness/${index}`)] }],
              },
            },
          ],
        });
        expect(result.results[0].status).toBe(201);
        const candidate = result.results[0].value.candidate as string;
        imports.set(candidate, provenance);
        await accept(book.id, candidate);
        await adopt(book.id, 'ex:credit', target.id, [candidate], null, key.id);
      }
      // Overflow on the SAME property; multiplicity of slots alone must never produce overflow.
      if (overflow)
        for (let index = 0; index < 128; index++) {
          const [other, key] = await Promise.all([create(), create()]);
          const candidate = await propose(book.id, 'ex:credit', other.id, [snak('ex:key', key.id)]);
          await accept(book.id, candidate);
          await adopt(book.id, 'ex:credit', other.id, [candidate], null, key.id);
        }
      const runner = rebuildRunner(db.pool);
      await catchUp(runner, partition);
      const built = await snapshot(book.id, false);
      expect(built.relationFacetOverflow).toEqual(overflow ? ['ex:credit'] : []);
      expect(values(built, 'ex:credit')).toHaveLength(overflow ? 128 : 1);
      // Inspect real internal rebuild metadata; no prefilled hints or diagnostic source substitutes.
      const hint = await admin.query(
        `SELECT witness_id FROM semantic.relation_facet_value
         WHERE route=$1 AND subject_id=$2 AND property=$3 AND value=$4`,
        [routeOf(book.id), book.id, 'ex:credit', target.id],
      );
      expect(hint.rows).toHaveLength(1);
      const initial = hint.rows[0].witness_id as string;
      expect(imports.has(initial)).toBe(true);
      const ordered = [...imports.keys()].filter((id) => id !== initial).sort();
      const fenced = [initial, ...ordered.slice(0, 32)];
      const survivors = ordered.slice(32);
      expect(survivors.length).toBeGreaterThan(0);
      const fence = async (id: string) => {
        const provenance = imports.get(id)!;
        await post('/v1/sourceFences:takedown', {
          source: provenance.source,
          externalId: provenance.external_id,
          fieldGroup: 'facts',
          reason: 'Fence witness',
        });
      };
      for (const id of fenced) await fence(id);
      const probe: Probe = { subject: book.id, property: 'ex:credit', value: target.id };
      const before = (await changedEvents(book.id)).length;
      const targetBefore = (await changedEvents(target.id)).length;
      // Runner is paused: this call cannot discover any of the later visible witnesses.
      const measured = await capture(db, () => match(partition, [probe]));
      expect(measured.value).toEqual(['not_proven']);
      const examined = costOf(measured.capture).relations.relation_facet_statement;
      expect(examined, 'capture must include the real indexed witness examinations').toBeDefined();
      expect(examined!.rows).toBeGreaterThan(0);
      expect(examined!.rows).toBeLessThanOrEqual(33);
      expect(examined!.sequentialScans).toBe(0);
      const events = (await changedEvents(book.id)).slice(before);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ partition_no: partition, subject: book.id });
      expect((await changedEvents(target.id)).length).toBe(targetBefore);
      expect(await match(partition, [probe, probe])).toEqual(['not_proven', 'not_proven']);
      expect((await changedEvents(book.id)).length).toBe(before + 1); // one outstanding logical rebuild
      expect(values(await snapshot(book.id, false), 'ex:credit').map(({ value }) => value)).not.toContain(target.id);
      // Recreate the runner between EVERY page: progress must be durable, not an in-memory cursor.
      for (let page = 0; ; page++) {
        expect(page).toBeLessThan(2000);
        const step = await capture(db, () => rebuildRunner(db.pool, 16, runnerConsumer).run(partition));
        expect(step.value.status).toBe('read');
        expect(step.value.examined).toBeLessThanOrEqual(16);
        const cost = costOf(withoutCatalogStatements('restarted witness page', step.capture));
        expect(cost.relations.relation_facet_statement?.rows ?? 0).toBeLessThanOrEqual(17);
        if (step.value.done) break;
      }
      const repaired = await admin.query(
        `SELECT witness_id FROM semantic.relation_facet_value
         WHERE route=$1 AND subject_id=$2 AND property=$3 AND value=$4`,
        [routeOf(book.id), book.id, 'ex:credit', target.id],
      );
      expect(survivors).toContain(repaired.rows[0]?.witness_id);
      expect(await match(partition, [probe])).toEqual([true]);
      const last = repaired.rows[0].witness_id as string;
      for (const id of survivors.filter((id) => id !== last)) await fence(id);
      expect(await match(partition, [probe])).toEqual([true]);
      await fence(last);
      expect(await match(partition, [probe])).toEqual(['not_proven']);
      await catchUp(runner, partition);
      const removed = await snapshot(book.id, false);
      expect(values(removed, 'ex:credit').map(({ value }) => value)).not.toContain(target.id);
      const metadata = await admin.query(
        `SELECT witness_id FROM semantic.relation_facet_value
         WHERE route=$1 AND subject_id=$2 AND property=$3 AND value=$4`,
        [routeOf(book.id), book.id, 'ex:credit', target.id],
      );
      expect(metadata.rows).toEqual([]);
      // Losing the pair crosses 129 -> 128 values. A finite rebuild clears overflow, so the
      // complete snapshot suppresses the positive and admits the negative without inventing probe false.
      expect(values(removed, 'ex:credit')).toHaveLength(overflow ? 128 : 0);
      expect(removed.relationFacetOverflow).toEqual([]);
      expect(await match(partition, [probe])).toEqual(['not_proven']);
    }
  } finally {
    await db.close();
  }
}, 300_000);
const runnerConsumer = `facet_restart_${randomUUID().replaceAll('-', '')}`;

test('active facet and qualifier retirement suppress historical selected credits until restored', async () => {
  const [person, role] = await Promise.all([create(), create('skos:Concept')]);
  const book = await create('schema:Book', {
    'schema:author': [statement('schema:author', person.id, [snak('wdt:P3831', role.id)])],
  });
  await snapshot(book.id);
  const probe: SharedRelationFacetProbe = {
    subject: book.id,
    property: 'schema:author',
    value: person.id,
    qualifiers: [{ property: 'wdt:P3831', in: [role.id] }],
  };
  const match = source.matchRelationFacets!;
  const partition = subjectPartition(book.id);
  expect(await match(partition, [probe])).toEqual([true]);
  const original = (await activeRelease(pool))!;
  for (const change of ['facet', 'qualifier']) {
    const replacement = structuredClone(original.release);
    replacement.catalogue.version += `-${change}`;
    if (change === 'facet') {
      replacement.types['schema:Book']!.facets = replacement.types['schema:Book']!.facets!.filter(
        (property) => property !== probe.property,
      );
    } else {
      const property = replacement.properties[probe.property]!;
      const qualifiers = typeof property.qualifiers === 'string' ? [property.qualifiers] : property.qualifiers;
      property.qualifiers = qualifiers.filter((property) => property !== 'wdt:P3831');
      if (property.relation?.filter)
        property.relation.filter = property.relation.filter.filter((property) => property !== 'wdt:P3831');
    }
    const published = await post('/v1/definitions/releases', { release: replacement });
    try {
      await post(`/v1/definitions/releases/${published.digest}:activate`, {
        expected_head: (await activeRelease(pool))!.head,
      });
      expect(await match(partition, [probe])).toEqual(['not_proven']);
      const current = await source.read(partition, [book.id]);
      expect(values(current.subjects[0]!, probe.property)).toEqual([]);
    } finally {
      await post(`/v1/definitions/releases/${original.digest}:activate`, {
        expected_head: (await activeRelease(pool))!.head,
      });
    }
    // A retained native seek may first finish its previous sweep; EOF is not absence.
    expect([await match(partition, [probe]), await match(partition, [probe])]).toContainEqual([true]);
  }
});

test('absence and overflow negation converge and removed hints recover on local restore and new adoption', async () => {
  const match = matcher();
  const target = await create();
  const book = await create('schema:Book');
  const runner = rebuildRunner(pool);
  const partition = subjectPartition(book.id);
  const probe: Probe = { subject: book.id, property: 'schema:author', value: target.id };
  expect(await match(partition, [probe])).toEqual(['not_proven']);
  await catchUp(runner, partition);
  expect(values(await snapshot(book.id, false), 'schema:author')).toEqual([]);
  let candidate = await propose(book.id, 'schema:author', target.id);
  await accept(book.id, candidate);
  let head = await adopt(book.id, 'schema:author', target.id, [candidate], null);
  await catchUp(runner, partition);
  expect(await match(partition, [probe])).toEqual([true]);
  await post(`/v1/subjects/${book.id}/candidates/${candidate}:hide`, { reason: 'Remove hint' });
  expect(await match(partition, [probe])).toEqual(['not_proven']);
  await catchUp(runner, partition);
  expect(values(await snapshot(book.id, false), 'schema:author')).toEqual([]);
  await post(`/v1/subjects/${book.id}/candidates/${candidate}:restore`, { reason: 'Restore removed hint' });
  await catchUp(runner, partition);
  expect(await match(partition, [probe])).toEqual([true]);
  head = await adopt(book.id, 'schema:author', target.id, [], head);
  await catchUp(runner, partition);
  expect(values(await snapshot(book.id, false), 'schema:author')).toEqual([]);
  candidate = await propose(book.id, 'schema:author', target.id);
  await accept(book.id, candidate);
  await adopt(book.id, 'schema:author', target.id, [candidate], head);
  await catchUp(runner, partition);
  expect(await match(partition, [probe])).toEqual([true]);
});
