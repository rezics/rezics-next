import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { BatchCommand } from '@rezics/definitions/bulk';
import type { ReviewedSubjectRead } from '../src/import-client.ts';
import { CrossMediaGraph, graphEdgeCommandKey, graphEdgeKey, graphEdgeSource } from '../src/cross-media-bindings.ts';
import {
  planCrossMediaSeed,
  crossMediaAliases,
  currentWorkRelationEndpoint,
  type CrossMediaReading,
  type CrossMediaTables,
} from '../src/cross-media-seed.ts';
import {
  showcaseFranchiseAssertions,
  showcaseFranchiseFence,
  showcaseFranchiseSelection,
} from '../src/showcase-franchise.ts';
import { buildShowcaseManifest, showcaseDigest, type ShowcaseAcknowledgement } from '../src/showcase-manifest.ts';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const roots = { bangumi: [10380, 84148, 51], vndb: ['v2002', 'v4'], includeReleases: false };
// Authored minimal records around observed Archive relation pairs. This is a mapper control, not seeded acceptance.
const subjects = [
  { id: 10380, type: 2, name: 'STEINS;GATE' },
  { id: 84148, type: 1, name: 'STEINS;GATE' },
  { id: 3154, type: 4, name: 'STEINS;GATE' },
  { id: 129807, type: 2, name: 'STEINS;GATE 0' },
  { id: 247445, type: 1, name: 'STEINS;GATE side story' },
  { id: 51, type: 2, name: 'CLANNAD' },
];
const relations = [
  { subject_id: 10380, related_subject_id: 3154, relation_type: 1 },
  { subject_id: 3154, related_subject_id: 10380, relation_type: 1 },
  { subject_id: 3154, related_subject_id: 84148, relation_type: 1 },
  { subject_id: 84148, related_subject_id: 3154, relation_type: 1 },
  { subject_id: 10380, related_subject_id: 129807, relation_type: 3 },
  { subject_id: 129807, related_subject_id: 10380, relation_type: 2 },
  { subject_id: 3154, related_subject_id: 247445, relation_type: 4006 },
  { subject_id: 247445, related_subject_id: 3154, relation_type: 4012 },
];
function tables(rows = relations, unrelated = 0): CrossMediaTables {
  return {
    async *rows(provider, table) {
      if (provider === 'bangumi' && table === 'subject') {
        yield* subjects;
        for (let i = 0; i < unrelated; i++) yield { id: 900000 + i, type: 2, name: 'STEINS;GATE unrelated' };
      }
      if (provider === 'bangumi' && table === 'subject-relations') {
        yield* rows;
        for (let i = 0; i < unrelated; i++)
          yield { subject_id: 10380, related_subject_id: 900000 + i, relation_type: 3 };
      }
      if (provider === 'vndb' && table === 'vn_titles')
        for (const key of ['v2002', 'v4', 'v17102'])
          yield { id: key, lang: 'ja', official: 't', title: key === 'v4' ? 'CLANNAD' : 'STEINS;GATE', latin: null };
      if (provider === 'vndb' && table === 'vn')
        for (const key of ['v2002', 'v4', 'v17102']) yield { id: key, olang: 'ja', alias: null };
      if (provider === 'vndb' && table === 'entry_meta')
        for (const key of ['v2002', 'v4', 'v17102'])
          yield { id: key, revision: '1', lastmod: '2026-11-04 00:00:00+00' };
      if (provider === 'vndb' && table === 'vn_relations') {
        yield { id: 'v2002', vid: 'v17102', relation: 'side', official: 't' };
        yield { id: 'v17102', vid: 'v2002', relation: 'par', official: 't' };
      }
    },
  };
}

test('finite observed members use existing mapper semantics and ignore unrelated high-degree growth', async () => {
  const selection = showcaseFranchiseSelection(roots);
  const small = await planCrossMediaSeed(tables(), { selection });
  const large = await planCrossMediaSeed(tables([...relations].reverse(), 1000), { selection });
  expect(roots.bangumi).toEqual([10380, 84148, 51]);
  expect(showcaseFranchiseSelection(selection)).toEqual(selection);
  expect(showcaseFranchiseSelection({ bangumi: [51], vndb: ['v4'] })).toEqual({ bangumi: [51], vndb: ['v4'] });
  expect(large.edges.map(graphEdgeKey)).toEqual(small.edges.map(graphEdgeKey));
  expect(small.edges.filter((edge) => edge.table === 'subject-relations')).toHaveLength(4);
  expect(
    small.edges
      .filter((edge) => edge.table === 'subject-relations')
      .map((edge) => edge.property)
      .sort(),
  ).toEqual(['rezics:crossMediaCounterpart', 'rezics:crossMediaCounterpart', 'rezics:sideStoryOf', 'wdt:P155']);
  expect(
    small.gaps.filter((row) => row.source === 'vndb' && ['side', 'par'].includes(String(row.record.relation))),
  ).toHaveLength(0);
  expect(small.edges.filter((edge) => edge.source === 'vndb' && edge.table === 'vn_relations')).toMatchObject([
    {
      holder: 'v2002',
      target: 'v17102',
      property: 'wdt:P144',
      vndbRelation: {
        sourceSubject: 'v2002',
        sourceEndpoint: 'v17102',
        evidence: [
          { sourceSubject: 'v17102', sourceEndpoint: 'v2002', code: 'par' },
          { sourceSubject: 'v2002', sourceEndpoint: 'v17102', code: 'side' },
        ],
      },
    },
  ]);
  const sideEdge = small.edges.find((edge) => edge.vndbRelation)!;
  const sideHolder = id(800001);
  const sideTarget = id(800002);
  const sideCandidate = id(800003);
  const sideCommand: BatchCommand = {
    op: 'propose',
    key: graphEdgeCommandKey(sideEdge),
    source: graphEdgeSource(sideEdge),
    subject: sideHolder,
    statement: {
      property: { id: sideEdge.property },
      value: { type: 'value', content: sideTarget },
      references: sideEdge.vndbRelation!.evidence.map((source) => ({
        parts: [
          {
            property: { id: 'schema:url' },
            value: { type: 'value', content: source.sourceUrl },
          },
        ],
      })),
    },
  };
  const sideReadings: CrossMediaReading[] = (
    [
      ['v2002', sideHolder],
      ['v17102', sideTarget],
    ] as const
  ).map(([externalId, subjectId]) => ({
    source: 'vndb' as const,
    externalId,
    route: `/subjects/${subjectId}/work`,
    selection: 'selected' as const,
    subject: {
      subject: { id: subjectId, type: 'wd:Q689445', statements: {} },
    } as unknown as ReviewedSubjectRead,
  }));
  const sideManifest = buildShowcaseManifest({
    plan: small,
    readings: sideReadings,
    acknowledgements: [
      { command: sideCommand, candidateId: sideCandidate, commandDigest: showcaseDigest(sideCommand) },
    ],
    aliases: crossMediaAliases,
  });
  const sideAssertion = sideManifest.records
    .find((record) => record.provider === 'vndb' && record.sourceKey === 'v2002')
    ?.assertions.find((assertion) => assertion.candidateId === sideCandidate);
  expect(sideAssertion).toMatchObject({
    property: 'wdt:P144',
    citations: ['https://vndb.org/v17102', 'https://vndb.org/v2002'],
    graphTarget: { provider: 'vndb', sourceKey: 'v17102', subjectId: sideTarget, factsFence: true },
  });
});

test('current graph results gate publication on exact reopen, changed source and endpoint identities', async () => {
  const temporary = join(process.cwd(), '.temp');
  await mkdir(temporary, { recursive: true });
  const directory = await mkdtemp(join(temporary, 'showcase-franchise-'));
  const path = join(directory, 'graph.sqlite');
  let db = new Database(path);
  try {
    const plan = await planCrossMediaSeed(tables(), { selection: showcaseFranchiseSelection(roots) });
    const workEdges = plan.edges.filter((edge) => edge.relation);
    let graph = new CrossMediaGraph(db);
    graph.remember(workEdges);
    const acknowledgements: ShowcaseAcknowledgement[] = [];
    let sends = 0;
    const nativeType = (key: string) =>
      key === '3154' ? 'schema:VideoGame' : ['84148', '247445'].includes(key) ? 'schema:Book' : 'schema:TVSeries';
    const deliver = () =>
      graph.deliver({
        claim: ({ external_id }) => ({ state: 'bound', subject: id(Number(external_id)) }),
        nativeType,
        currentRelationEndpoint: async () => 'current',
        fence: async () => ({ fenced: false, securityRevision: null }),
        batch: async ({ commands }) => {
          sends++;
          return {
            results: commands.map((command: BatchCommand, index) => {
              const candidate = id(700000 + index);
              acknowledgements.push({ command, candidateId: candidate, commandDigest: showcaseDigest(command) });
              return { key: command.key, status: 201 as const, value: { candidate, revision: 1 } };
            }),
          };
        },
      });
    await deliver();
    const readings = subjects.map((row) => ({
      source: 'bangumi',
      externalId: String(row.id),
      subject: {
        subject: { id: id(row.id), type: nativeType(String(row.id)), statements: {}, labels: {} },
      },
      route: `/subjects/${id(row.id)}/work`,
      selection: 'selected',
    })) as unknown as CrossMediaReading[];
    const compose = (current = plan, reads = readings, evidence = graph.evidence(workEdges)) =>
      showcaseFranchiseAssertions({ plan: current, readings: reads, evidence, acknowledgements });
    expect(compose().targets.size).toBe(4);
    const fenceCalls: string[] = [];
    const review = {
      fence: async ({ externalId }: { externalId: string }) => {
        fenceCalls.push(externalId);
        return { fenced: externalId === '3154', securityRevision: externalId === '3154' ? 'current-fence' : null };
      },
    };
    expect(await showcaseFranchiseFence(review, crossMediaAliases.bangumi, ['10380', '3154'])).toBe('fenced');
    expect(fenceCalls).toEqual(['10380', '3154']);
    expect(await showcaseFranchiseFence({}, crossMediaAliases.bangumi, ['10380', '3154'])).toBe('unavailable');
    await expect(
      showcaseFranchiseFence(
        {
          fence: async () => {
            throw new Error('current authority unavailable');
          },
        },
        crossMediaAliases.bangumi,
        ['10380'],
      ),
    ).rejects.toThrow('current authority unavailable');
    const manifest = buildShowcaseManifest({
      plan,
      readings,
      acknowledgements,
      aliases: crossMediaAliases,
      workRelations: graph.evidence(workEdges),
    });
    expect(manifest.records.flatMap((row) => row.assertions).filter((row) => row.graphTarget?.factsFence)).toHaveLength(
      4,
    );
    db.close();
    db = new Database(path);
    graph = new CrossMediaGraph(db);
    await deliver();
    expect(sends).toBe(1);
    expect(compose().targets.size).toBe(4);
    const missing = compose(
      plan,
      readings.filter((row) => row.externalId !== '3154'),
    );
    expect(missing.targets.size).toBe(1);
    expect(missing.omissions.every((row) => row.code === 'graph-endpoint-unavailable')).toBe(true);
    const changedReads = readings.map((row) =>
      row.externalId === '3154'
        ? { ...row, subject: { ...row.subject, subject: { ...row.subject.subject, id: id(999999) } } }
        : row,
    );
    expect(compose(plan, changedReads).targets.size).toBe(1);
    const changed = await planCrossMediaSeed(
      tables(
        relations.map((row) =>
          row.subject_id === 3154 && row.related_subject_id === 247445 ? { ...row, relation_type: 99999 } : row,
        ),
      ),
      { selection: showcaseFranchiseSelection(roots) },
    );
    expect(changed.gaps.some((row) => row.reason === 'Unknown Bangumi relation code')).toBe(true);
    expect(compose(changed).targets.size).toBe(3);
  } finally {
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

function readWith(subject: string, type: string, statements: Record<string, string>): ReviewedSubjectRead {
  return {
    subject: {
      id: subject,
      type,
      statements: Object.fromEntries(
        Object.entries(statements).map(([property, content]) => [property, [{ value: { type: 'value', content } }]]),
      ),
    },
  } as unknown as ReviewedSubjectRead;
}

test('work-relation endpoints certify VNDB work and Bangumi identities separately before delivery', async () => {
  // Production relation reads must accept a visual novel by its wdt:P3180 identity, not a Bangumi property.
  expect(
    currentWorkRelationEndpoint(
      readWith(id(2002), 'wd:Q689445', { 'wdt:P3180': 'v2002' }),
      'v2002',
      id(2002),
      'wd:Q689445',
    ),
  ).toBe('current');
  expect(
    currentWorkRelationEndpoint(
      readWith(id(2002), 'wd:Q689445', { 'wdt:P3180': 'v3' }),
      'v2002',
      id(2002),
      'wd:Q689445',
    ),
  ).toBe('identity_mismatch');
  expect(
    currentWorkRelationEndpoint(
      readWith(id(2002), 'wd:Q689445', { 'wdt:P3180': 'v2002' }),
      'v2002',
      id(2002),
      'wd:Q20631656',
    ),
  ).toBe('wrong_type');
  expect(currentWorkRelationEndpoint(null, 'v2002', id(2002), 'wd:Q689445')).toBe('unavailable');
  expect(
    currentWorkRelationEndpoint(
      readWith(id(3154), 'schema:VideoGame', { 'wdt:P5732': '3154' }),
      '3154',
      id(3154),
      'schema:VideoGame',
    ),
  ).toBe('current');
  expect(
    currentWorkRelationEndpoint(
      readWith(id(3154), 'schema:VideoGame', { 'wdt:P5732': '999' }),
      '3154',
      id(3154),
      'schema:VideoGame',
    ),
  ).toBe('identity_mismatch');
  // A VNDB visual-novel identity is never a Bangumi subject identity, even when the Bangumi key is numeric.
  expect(
    currentWorkRelationEndpoint(
      readWith(id(3154), 'schema:VideoGame', { 'wdt:P3180': '3154' }),
      '3154',
      id(3154),
      'schema:VideoGame',
    ),
  ).toBe('unknown');
});

test('a VNDB side edge is proposed only while both work endpoints still name their own identities', async () => {
  const temporary = join(process.cwd(), '.temp');
  await mkdir(temporary, { recursive: true });
  const directory = await mkdtemp(join(temporary, 'showcase-franchise-vndb-'));
  const uuids: Record<string, string> = { v2002: id(2002), v17102: id(17102) };
  try {
    const plan = await planCrossMediaSeed(tables(), { selection: showcaseFranchiseSelection(roots) });
    const sides = plan.edges.filter((edge) => edge.vndbRelation);
    expect(sides).toHaveLength(1);
    const deliver = (path: string, endpoints: Record<string, string>) => {
      const db = new Database(path);
      const graph = new CrossMediaGraph(db);
      graph.remember(sides);
      const reads = new Map(
        Object.entries(uuids).map(([externalId, uuid]) => [
          uuid,
          readWith(uuid, 'wd:Q689445', { 'wdt:P3180': endpoints[externalId] ?? externalId }),
        ]),
      );
      return graph
        .deliver({
          claim: ({ external_id }) => ({ state: 'bound', subject: uuids[external_id]! }),
          nativeType: () => 'wd:Q689445',
          currentRelationEndpoint: async (externalId, nativeSubjectId, expectedType) =>
            currentWorkRelationEndpoint(reads.get(nativeSubjectId) ?? null, externalId, nativeSubjectId, expectedType),
          fence: async () => ({ fenced: false, securityRevision: null }),
          batch: async ({ commands }) => ({
            results: commands.map((command, index) => ({
              key: command.key,
              status: 201 as const,
              value: { candidate: id(700000 + index), revision: 1 },
            })),
          }),
        })
        .finally(() => db.close());
    };
    const current = await deliver(join(directory, 'current.sqlite'), {});
    expect(current.unresolved).toEqual([]);
    expect(current.proposed).toEqual([
      expect.objectContaining({ holder: 'v2002', target: 'v17102', property: 'wdt:P144', subject: uuids.v2002 }),
    ]);
    const stale = await deliver(join(directory, 'stale.sqlite'), { v17102: 'v17103' });
    expect(stale.proposed).toEqual([]);
    expect(stale.unresolved).toEqual([
      expect.objectContaining({ reason: 'current_relation_endpoint_identity_mismatch:v17102' }),
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
