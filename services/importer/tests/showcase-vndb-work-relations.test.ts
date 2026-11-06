import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { BatchCommand } from '@rezics/definitions/bulk';
import { vndbLimits } from '@rezics/conversion/vndb';
import type { ReviewedSubjectRead } from '../src/import-client.ts';
import {
  buildVndbWorkRelationOutcomes,
  crossMediaAliases,
  planCrossMediaSeed,
  type CrossMediaTables,
} from '../src/cross-media-seed.ts';
import {
  CrossMediaGraph,
  graphEdgeCommandKey,
  graphEdgeSource,
  type GraphEdgeEvidence,
} from '../src/cross-media-bindings.ts';

const uuid = (tail: string) => `00000000-0000-4000-8000-${tail.padStart(12, '0')}`;
const reading = (externalId: string, id: string) => ({
  source: 'vndb' as const,
  externalId,
  route: `/subjects/${id}/work`,
  selection: 'selected' as const,
  subject: {
    subject: { id, type: 'wd:Q689445', statements: {} },
  } as unknown as ReviewedSubjectRead,
});

test('selected VNDB relation handoff keeps mapped direction, cited source and exact current endpoint identities', async () => {
  const tables: CrossMediaTables = {
    async *rows(provider, table) {
      if (provider === 'bangumi' && table === 'subject') yield { id: 51, name: 'CLANNAD', type: 2 };
      if (provider !== 'vndb') return;
      if (table === 'vn_titles') {
        yield { id: 'v4', lang: 'en', official: 't', title: 'CLANNAD', latin: null };
        yield { id: 'v7983', lang: 'en', official: 't', title: 'Clannad -The Past Path-', latin: null };
        yield {
          id: 'v2002',
          lang: 'en',
          official: 't',
          title: 'Selected title outside the franchise catalogue',
          latin: null,
        };
        yield { id: 'v17102', lang: 'en', official: 't', title: 'STEINS;GATE side story', latin: null };
      }
      if (table === 'vn') {
        for (const id of ['v4', 'v7983', 'v2002', 'v17102']) yield { id, olang: 'ja', alias: null };
      }
      if (table === 'entry_meta') {
        for (const id of ['v4', 'v7983', 'v2002', 'v17102']) yield { id, revision: '1' };
      }
      if (table === 'vn_relations') {
        yield { id: 'v4', vid: 'v7983', relation: 'preq', official: 't' };
        yield { id: 'v4', vid: 'v9000', relation: 'side', official: 't' };
        yield { id: 'v4', vid: 'v7983', relation: 'ser', official: 't' };
        yield { id: 'v2002', vid: 'v17102', relation: 'side', official: 't' };
        yield { id: 'v17102', vid: 'v2002', relation: 'par', official: 't' };
      }
    },
  };
  const plan = await planCrossMediaSeed(tables, {
    selection: { bangumi: [51], vndb: ['v4', 'v7983', 'v2002', 'v17102'], includeReleases: false },
  });
  expect(plan.records.vndb.map((record) => record.key)).toContain('v2002');
  expect(plan.franchises['steins-gate'].vndb).not.toContain('v2002');
  const edges = plan.edges.filter((edge) => edge.source === 'vndb' && edge.table === 'vn_relations');
  expect(edges).toHaveLength(2);
  const edge = edges[0]!;
  expect(edge).toMatchObject({
    alias: crossMediaAliases.vndb,
    holder: 'v7983',
    target: 'v4',
    property: 'wdt:P155',
    url: 'https://vndb.org/v7983',
    record: { id: 'v4', vid: 'v7983', relation: 'preq', official: 't' },
  });
  expect(edge.fields).toContain('vn_relations.official');
  expect(plan.gaps).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ record: expect.objectContaining({ relation: 'ser' }), code: 'ser' }),
      expect.objectContaining({ record: expect.objectContaining({ relation: 'side' }), endpoint: 'v9000' }),
    ]),
  );
  const typedEdge = edges.find((candidate) => candidate.vndbRelation)!;
  expect(typedEdge).toMatchObject({
    holder: 'v2002',
    target: 'v17102',
    property: 'wdt:P144',
    vndbRelation: {
      evidence: [
        {
          sourceSubject: 'v17102',
          sourceEndpoint: 'v2002',
          sourceUrl: 'https://vndb.org/v17102',
          recordRevision: '1',
          code: 'par',
        },
        {
          sourceSubject: 'v2002',
          sourceEndpoint: 'v17102',
          sourceUrl: 'https://vndb.org/v2002',
          recordRevision: '1',
          code: 'side',
        },
      ],
    },
  });
  expect(typedEdge.vndbRelation?.evidence).toHaveLength(2);
  const bounded = await planCrossMediaSeed(
    {
      async *rows(provider, table) {
        if (provider === 'vndb' && table === 'vn_relations') {
          for (let order = 0; order <= vndbLimits.maxLinks; order++)
            yield { id: 'v4', vid: 'v7983', relation: 'preq', official: 't', order };
          return;
        }
        yield* tables.rows(provider, table);
      },
    },
    { selection: { bangumi: [51], vndb: ['v4', 'v7983'], includeReleases: false } },
  );
  expect(
    bounded.edges.filter((candidate) => candidate.source === 'vndb' && candidate.table === 'vn_relations'),
  ).toHaveLength(vndbLimits.maxLinks);
  expect(bounded.gaps.filter((gap) => gap.reason === 'Selected VNDB relation limit exceeded')).toHaveLength(1);
  const sideHolderId = uuid('2002');
  const sideTargetId = uuid('17102');
  const sideCandidateId = uuid('11');
  const sideCommand: BatchCommand = {
    op: 'propose',
    key: graphEdgeCommandKey(typedEdge),
    source: graphEdgeSource(typedEdge),
    subject: sideHolderId,
    statement: {
      property: { id: typedEdge.property },
      value: { type: 'value', content: sideTargetId },
      references: typedEdge.vndbRelation!.evidence.map((source) => ({
        parts: [
          {
            property: { id: 'schema:url' },
            value: { type: 'value', content: source.sourceUrl },
          },
        ],
      })),
    },
  };
  const sideEvidence: GraphEdgeEvidence = {
    draft: typedEdge,
    status: 'proposed',
    command: sideCommand,
    candidate: sideCandidateId,
  };
  const sideOutcomes = buildVndbWorkRelationOutcomes({
    plan: { edges: [typedEdge] },
    evidence: [sideEvidence],
    readings: [reading('v2002', sideHolderId), reading('v17102', sideTargetId)],
    unresolved: [],
  });
  expect(sideOutcomes).toMatchObject([
    {
      sourceRecordKey: 'v17102',
      relatedRecordKey: 'v2002',
      relation: 'par',
      holderKey: 'v2002',
      targetKey: 'v17102',
      property: 'wdt:P144',
      holderSubjectId: sideHolderId,
      targetSubjectId: sideTargetId,
      citation: 'https://vndb.org/v17102',
      delivery: 'acknowledged',
      candidateId: sideCandidateId,
    },
    {
      sourceRecordKey: 'v2002',
      relatedRecordKey: 'v17102',
      relation: 'side',
      holderKey: 'v2002',
      targetKey: 'v17102',
      property: 'wdt:P144',
      holderSubjectId: sideHolderId,
      targetSubjectId: sideTargetId,
      citation: 'https://vndb.org/v2002',
      delivery: 'acknowledged',
      candidateId: sideCandidateId,
    },
  ]);

  const temporary = join(process.cwd(), '.temp');
  await mkdir(temporary, { recursive: true });
  const directory = await mkdtemp(join(temporary, 'vndb-work-relations-'));
  const path = join(directory, 'graph.sqlite');
  let typedDatabase = new Database(path);
  try {
    let typedGraph = new CrossMediaGraph(typedDatabase);
    typedGraph.remember([typedEdge]);
    const identities = new Map([
      ['v2002', sideHolderId],
      ['v17102', uuid('17103')],
    ]);
    const currentIdentities = new Map([
      ['v2002', sideHolderId],
      ['v17102', sideTargetId],
    ]);
    const currentCalls: string[] = [];
    const fenceCalls: string[] = [];
    const journalCommands: BatchCommand[] = [];
    const journalAcknowledgements: BatchCommand[] = [];
    let sends = 0;
    const deliver = () =>
      typedGraph.deliver({
        claim: ({ external_id }) => ({ state: 'bound', subject: identities.get(external_id)! }),
        nativeType: () => 'wd:Q689445',
        currentRelationEndpoint: async (externalId, nativeId, type) => {
          currentCalls.push(externalId);
          return currentIdentities.get(externalId) === nativeId && type === 'wd:Q689445'
            ? 'current'
            : 'identity_mismatch';
        },
        fence: async ({ externalId }) => {
          fenceCalls.push(externalId);
          return { fenced: false, securityRevision: null };
        },
        journal: {
          prepare(command) {
            journalCommands.push(command);
            return { bytes: JSON.stringify({ commands: [command] }) };
          },
          acknowledge(command) {
            journalAcknowledgements.push(command);
          },
        },
        batch: async ({ commands }) => {
          sends++;
          return {
            results: commands.map((command) => ({
              key: command.key,
              status: 201 as const,
              value: { candidate: sideCandidateId, revision: 1 },
            })),
          };
        },
      });

    const changed = await deliver();
    expect(changed.unresolved.map(({ reason }) => reason)).toEqual([
      'current_relation_endpoint_identity_mismatch:v17102',
    ]);
    expect(sends).toBe(0);
    typedDatabase.close();
    typedDatabase = new Database(path);
    typedGraph = new CrossMediaGraph(typedDatabase);
    identities.set('v17102', sideTargetId);
    const recovered = await deliver();
    expect(recovered.proposed).toHaveLength(1);
    expect(sends).toBe(1);
    expect(journalCommands).toHaveLength(1);
    expect(journalAcknowledgements).toEqual(journalCommands);
    expect(currentCalls.sort()).toEqual(['v17102', 'v17102', 'v2002', 'v2002']);
    expect(fenceCalls.sort()).toEqual(['v17102', 'v17102', 'v2002', 'v2002']);
    const recoveredCommand = typedGraph.evidence([typedEdge])[0]!.command!;
    if (recoveredCommand.op !== 'propose') throw new TypeError('Expected a proposed VNDB relation');
    expect(recoveredCommand.statement).toMatchObject({
      property: { id: 'wdt:P144' },
      value: { type: 'value', content: sideTargetId },
      references: [
        { parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: 'https://vndb.org/v17102' } }] },
        { parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: 'https://vndb.org/v2002' } }] },
      ],
    });
    typedDatabase.close();
    typedDatabase = new Database(path);
    typedGraph = new CrossMediaGraph(typedDatabase);
    const reopened = await deliver();
    expect(reopened.proposed).toHaveLength(0);
    expect(sends).toBe(1);
    expect(journalCommands).toHaveLength(1);
  } finally {
    typedDatabase.close();
    await rm(directory, { recursive: true, force: true });
  }

  const holderId = uuid('7983');
  const targetId = uuid('4');
  const candidateId = uuid('10');
  const command: BatchCommand = {
    op: 'propose',
    key: 'vndb:relation:candidate',
    source: graphEdgeSource(edge),
    subject: holderId,
    statement: {
      property: { id: edge.property },
      value: { type: 'value', content: targetId },
      references: [
        {
          parts: [
            {
              property: { id: 'schema:url' },
              value: { type: 'value', content: edge.url },
            },
          ],
        },
      ],
    },
  };
  const evidence: GraphEdgeEvidence = { draft: edge, status: 'proposed', command, candidate: candidateId };
  expect(
    buildVndbWorkRelationOutcomes({
      plan: { edges: [edge] },
      evidence: [evidence],
      readings: [reading('v7983', holderId), reading('v4', targetId)],
      unresolved: [],
    }),
  ).toEqual([
    {
      sourceRecordKey: 'v4',
      relatedRecordKey: 'v7983',
      relation: 'preq',
      holderKey: 'v7983',
      targetKey: 'v4',
      property: 'wdt:P155',
      holderSubjectId: holderId,
      targetSubjectId: targetId,
      fields: edge.fields,
      citation: 'https://vndb.org/v7983',
      delivery: 'acknowledged',
      publication: 'pending',
      candidateId,
    },
  ]);
  expect(
    buildVndbWorkRelationOutcomes({
      plan: { edges: [edge] },
      evidence: [{ draft: edge, status: 'unresolved' }],
      readings: [reading('v7983', holderId)],
      unresolved: [{ ...edge, reason: 'missing_endpoint:v4' }],
    }),
  ).toMatchObject([
    {
      holderSubjectId: holderId,
      targetSubjectId: null,
      citation: 'https://vndb.org/v7983',
      delivery: 'unavailable',
      publication: 'pending',
      reason: 'missing_endpoint:v4',
    },
  ]);

  const database = new Database(':memory:');
  try {
    const graph = new CrossMediaGraph(database);
    graph.remember([edge]);
    const fencedTuples: string[] = [];
    let sent = false;
    const delivered = await graph.deliver({
      claim: ({ external_id }) => ({ state: 'bound', subject: external_id === 'v7983' ? holderId : targetId }),
      nativeType: () => 'wd:Q689445',
      currentRelationEndpoint: async () => 'current',
      fence: async ({ externalId }) => {
        fencedTuples.push(externalId);
        return { fenced: externalId === 'v4', securityRevision: '1' };
      },
      batch: async ({ commands }) => {
        sent = true;
        return {
          results: commands.map((command) => ({
            key: command.key,
            status: 201,
            value: { candidate: candidateId, revision: 1 },
          })),
        };
      },
    });
    expect(fencedTuples).toEqual(['v4']);
    expect(sent).toBe(false);
    expect(delivered.unresolved.map(({ reason }) => reason)).toEqual(['fenced_source_facts']);
    expect(
      buildVndbWorkRelationOutcomes({
        plan: { edges: [edge] },
        evidence: graph.evidence([edge]),
        readings: [],
        unresolved: delivered.unresolved,
      }),
    ).toMatchObject([{ delivery: 'unavailable', publication: 'pending', reason: 'fenced_source_facts' }]);
  } finally {
    database.close();
  }
});
