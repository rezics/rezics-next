import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { releaseDigest, valueSchema, type Release } from '@rezics/definitions';
import { bundledRelease } from '@rezics/definitions/bundled';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { createPool } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { anchorRoute, newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { subjectPartition, type IndexedSubject } from '../../src/search/source.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { subjectSource } from '../../src/semantic/search-source.ts';
import { capture, openGrowthDatabase } from '../support/growth.ts';
import { createRealAccess } from './real-access.ts';
import { statementBindings } from './support/sql-guard.ts';

// Local expected port until Search lands the shared optional method. Missing support is an assertion failure.
type Probe = { subject: string; property: string; value: string; qualifiers?: { property: string; in: string[] }[] };
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
release.properties['ex:left'] = property('ex:left');
release.properties['ex:right'] = property('ex:right');
release.properties['ex:credit'] = property('ex:credit', {
  qualifiers: ['ex:key', 'ex:left', 'ex:right'],
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

test('a snapshot includes adopted outgoing relation facets but no nonfacet or incoming relations', async () => {
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
  const nextHead = await adopt(book.id, 'schema:author', nextAuthor.id, [next], null);
  expect(values(await snapshot(book.id), 'schema:author').map((row) => row.value)).toEqual([nextAuthor.id]);
  await post(`/v1/subjects/${book.id}/candidates/${next}:hide`, { reason: 'Selected relation moderated' });
  expect(values(await snapshot(book.id), 'schema:author')).toEqual([]);
  await post(`/v1/subjects/${book.id}/candidates/${next}:restore`, { reason: 'Selected relation restored' });
  expect(values(await snapshot(book.id), 'schema:author').map((row) => row.value)).toEqual([nextAuthor.id]);
  await adopt(book.id, 'schema:author', nextAuthor.id, [], nextHead);
  expect(values(await snapshot(book.id), 'schema:author')).toEqual([]);
});

test('a relation facet snapshot has at most 128 entries and reports overflow', async () => {
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

test('relation facet point reads match beyond the snapshot cap with same-statement qualifiers', async () => {
  const match = matcher();
  const [target, left, right, other] = await Promise.all(Array.from({ length: 4 }, () => create()));
  const book = await create('schema:Book');
  const keys: { id: string }[] = [];
  for (let index = 0; index < 130; index++) keys.push(await create());
  for (const [index, key] of keys.entries()) {
    const qualifiers = [
      snak('ex:key', key.id),
      snak(index % 2 ? 'ex:left' : 'ex:right', index % 2 ? left.id : right.id),
    ];
    const candidate = await propose(book.id, 'ex:credit', target.id, qualifiers);
    await accept(book.id, candidate);
    await adopt(book.id, 'ex:credit', target.id, [candidate], null, key.id);
  }
  const probe: Probe = {
    subject: book.id,
    property: 'ex:credit',
    value: target.id,
    qualifiers: [
      { property: 'ex:left', in: [other.id, left.id] },
      { property: 'ex:right', in: [right.id] },
    ],
  };
  expect(await match(subjectPartition(book.id), [probe])).toEqual([false]);
  const both = await propose(book.id, 'ex:credit', target.id, [
    snak('ex:key', other.id),
    snak('ex:left', left.id),
    snak('ex:right', right.id),
  ]);
  expect(await match(subjectPartition(book.id), [probe])).toEqual([false]); // Pending is not adopted.
  await accept(book.id, both);
  expect(await match(subjectPartition(book.id), [probe])).toEqual([false]); // Accepted alone is not adopted.
  await adopt(book.id, 'ex:credit', target.id, [both], null, other.id);
  expect(await match(subjectPartition(book.id), [probe, { ...probe, value: other.id }])).toEqual([true, false]);
  await post(`/v1/subjects/${book.id}/candidates/${both}:hide`, { reason: 'Final disclosure check' });
  expect(await match(subjectPartition(book.id), [probe])).toEqual([false]);
  // The unqualified membership still has other adopted witnesses after the qualified witness is hidden.
  expect(
    await match(subjectPartition(book.id), [{ subject: book.id, property: 'ex:credit', value: target.id }]),
  ).toEqual([true]);
}, 120_000);

test('relation facet point reads reject foreign anchors and more than 256 probes', async () => {
  const db = await openGrowthDatabase(url);
  try {
    const match = matcher(subjectSource(db.pool, routeKey) as ExpectedPort);
    const target = await create();
    const book = await create('schema:Book', { 'schema:author': [statement('schema:author', target.id)] });
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
    const probe: Probe = { subject, property: 'schema:author', value: target.id };
    for (const [part, probes] of [
      [-1, [probe]],
      [4096, [probe]],
      [0.5, [probe]],
      [NaN, [probe]],
      [partition, [{ ...probe, subject: 'malformed' }]],
      [partition, [probe, { ...probe, subject: foreign }]],
      [partition, Array.from({ length: 257 }, () => probe)],
    ] as [number, Probe[]][]) {
      const measured = await capture(db, async () => {
        await expect(match(part, probes)).rejects.toThrow();
      });
      expect(measured.capture.statements, 'invalid input must fail before any data SQL').toHaveLength(0);
    }
    expect(await match(partition, [])).toEqual([]);
    const probes = Array.from({ length: 256 }, (_, index) => ({ ...probe, subject: index % 2 ? neighbor : subject }));
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
