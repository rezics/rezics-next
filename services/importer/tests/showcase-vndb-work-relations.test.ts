import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { BatchCommand } from '@rezics/definitions/bulk';
import type { ReviewedSubjectRead } from '../src/import-client.ts';
import {
  buildVndbWorkRelationOutcomes,
  crossMediaAliases,
  planCrossMediaSeed,
  type CrossMediaTables,
} from '../src/cross-media-seed.ts';
import { CrossMediaGraph, graphEdgeSource, type GraphEdgeEvidence } from '../src/cross-media-bindings.ts';

const uuid = (tail: string) => `00000000-0000-4000-8000-${tail.padStart(12, '0')}`;

test('selected VNDB relation handoff keeps mapped direction, cited source and exact current endpoint identities', async () => {
  const tables: CrossMediaTables = {
    async *rows(provider, table) {
      if (provider === 'bangumi' && table === 'subject') yield { id: 51, name: 'CLANNAD', type: 2 };
      if (provider !== 'vndb') return;
      if (table === 'vn_titles') {
        yield { id: 'v4', lang: 'en', official: 't', title: 'CLANNAD', latin: null };
        yield { id: 'v7983', lang: 'en', official: 't', title: 'Clannad -The Past Path-', latin: null };
        yield { id: 'v2002', lang: 'en', official: 't', title: 'STEINS;GATE', latin: null };
      }
      if (table === 'vn') {
        for (const id of ['v4', 'v7983']) yield { id, olang: 'ja', alias: null };
      }
      if (table === 'entry_meta') {
        for (const id of ['v4', 'v7983']) yield { id, revision: '1' };
      }
      if (table === 'vn_relations') {
        yield { id: 'v4', vid: 'v7983', relation: 'preq', official: 't' };
        yield { id: 'v4', vid: 'v2002', relation: 'seq', official: 't' };
        yield { id: 'v4', vid: 'v7983', relation: 'ser', official: 't' };
      }
    },
  };
  const plan = await planCrossMediaSeed(tables, {
    selection: { bangumi: [51], vndb: ['v4', 'v7983'], includeReleases: false },
  });
  const edges = plan.edges.filter((edge) => edge.source === 'vndb' && edge.table === 'vn_relations');
  expect(edges).toHaveLength(1);
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
  expect(plan.gaps.some((gap) => gap.record.relation === 'ser' && gap.fields.includes('vn_relations.relation'))).toBe(
    true,
  );
  expect(edges.some((candidate) => candidate.target === 'v2002')).toBe(false);

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
  const reading = (externalId: string, id: string) => ({
    source: 'vndb' as const,
    externalId,
    route: `/subjects/${id}/work`,
    selection: 'selected' as const,
    subject: {
      subject: { id, type: 'wd:Q689445', statements: {} },
    } as unknown as ReviewedSubjectRead,
  });
  expect(
    buildVndbWorkRelationOutcomes({
      plan,
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
      plan,
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
    graph.remember(edges);
    const fencedTuples: string[] = [];
    let sent = false;
    const delivered = await graph.deliver({
      claim: ({ external_id }) => ({ state: 'bound', subject: external_id === 'v7983' ? holderId : targetId }),
      nativeType: () => 'wd:Q689445',
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
        plan,
        evidence: graph.evidence(edges),
        readings: [],
        unresolved: delivered.unresolved,
      }),
    ).toMatchObject([{ delivery: 'unavailable', publication: 'pending', reason: 'fenced_source_facts' }]);
  } finally {
    database.close();
  }
});
