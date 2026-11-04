import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BatchCommand } from '@rezics/definitions/bulk';
import { CrossMediaGraph, graphEdgeKey, type GraphEdgeDraft } from '../src/cross-media-bindings.ts';
import { planCrossMediaSeed, type CrossMediaTables } from '../src/cross-media-seed.ts';

test('the production seed coalesces reciprocal subject relation rows into one canonical statement', async () => {
  const rows: CrossMediaTables = {
    async *rows(_provider, table) {
      if (table === 'subject') {
        yield { id: 1, type: 2, name: 'STEINS;GATE' };
        yield { id: 2, type: 2, name: 'STEINS;GATE 0' };
        yield { id: 3, type: 2, name: 'CLANNAD' };
        yield { id: 4, type: 2, name: 'Fate/stay night' };
        yield { id: 5, type: 6, platform: 6002, name: 'CLANNAD live action' };
      }
      if (table === 'vn_titles') {
        yield { id: 'v1', title: 'STEINS;GATE', official: 't', lang: 'en', latin: null };
        yield { id: 'v2', title: 'CLANNAD', official: 't', lang: 'en', latin: null };
        yield { id: 'v3', title: 'Fate/stay night', official: 't', lang: 'en', latin: null };
      }
      if (table === 'vn') {
        yield { id: 'v1', olang: 'en' };
        yield { id: 'v2', olang: 'en' };
        yield { id: 'v3', olang: 'en' };
      }
      if (table === 'entry_meta') {
        yield { id: 'v1', revision: '1' };
        yield { id: 'v2', revision: '1' };
        yield { id: 'v3', revision: '1' };
      }
      if (table === 'subject-relations') {
        yield { subject_id: 1, related_subject_id: 2, relation_type: 2 };
        yield { subject_id: 2, related_subject_id: 1, relation_type: 3 };
        yield { subject_id: 5, related_subject_id: 3, relation_type: 1 };
      }
    },
  };

  const plan = await planCrossMediaSeed(rows);
  const relations = plan.edges.filter((edge) => edge.table === 'subject-relations');
  expect(relations.find((edge) => edge.holder === '1')).toMatchObject({
    holder: '1',
    target: '2',
    property: 'wdt:P155',
    relation: { family: 2, code: 2, reciprocalCode: 3, evidence: [{ code: 2 }, { code: 3 }] },
  });
  expect(relations.find((edge) => edge.relation?.family === 6)).toMatchObject({
    holder: '3',
    target: '5',
    property: 'rezics:crossMediaCounterpart',
    relation: { family: 6, code: 1, sourceSubject: '5', sourceEndpoint: '3', evidence: [{ code: 1 }] },
  });
  expect(plan.entities.bangumi.some((record) => record.key === '5')).toBe(true);
});

test('production graph journals immutable relation commands and retries without duplicate delivery', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bangumi-relations-'));
  const path = join(directory, 'state.sqlite');
  const database = new Database(path, { create: true, strict: true });
  const graph = new CrossMediaGraph(database);
  const draft: GraphEdgeDraft = {
    source: 'bangumi',
    alias: 'bangumi_cross_media',
    table: 'subject-relations',
    holder: '10',
    target: '11',
    property: 'rezics:sideStoryOf',
    url: 'https://bgm.tv/subject/10',
    membership: 'referenced',
    record: { subject_id: 10, related_subject_id: 11, relation_type: 12 },
    fields: ['subject-relations.relation_type', 'subject-relations.related_subject_id', 'subject-relations.subject_id'],
    relation: {
      family: 2,
      code: 12,
      reciprocalCode: 6,
      path: '/subject-relations/10/11',
      sourceSubject: '10',
      sourceEndpoint: '11',
      mappingRevision: 'bangumi-relation-2@2:12:6',
      evidence: [
        { path: '/subject-relations/10/11', code: 12, sourceSubject: '10', sourceEndpoint: '11', digest: 'a'.repeat(64) },
        { path: '/subject-relations/11/10', code: 6, sourceSubject: '11', sourceEndpoint: '10', digest: 'b'.repeat(64) },
      ],
    },
  };
  const uuid = (id: string) => `00000000-0000-4000-8000-${id.padStart(12, '0')}`;
  const claim = ({ external_id }: { external_id: string }) => ({ state: 'bound' as const, subject: uuid(external_id) });
  const sent: { commands: BatchCommand[] }[] = [];
  const candidateByKey = new Map<string, string>();
  let nextCandidate = 100;
  const activeJournal = new Map<string, string>();
  const journal = {
    prepare(command: BatchCommand) {
      const bytes = JSON.stringify({ commands: [command] });
      const prior = activeJournal.get(command.key);
      if (prior && prior !== bytes) throw new Error('Journal body changed');
      activeJournal.set(command.key, bytes);
      return { bytes };
    },
    acknowledge() {},
  };
  let activeGraph = graph;
  const deliver = (relationSnapshot: { currentKeys: string[]; scope: string[]; digest: string; complete: boolean }) =>
    activeGraph.deliver({
      claim,
      nativeType: () => 'schema:TVSeries',
      fence: async () => ({ fenced: false, securityRevision: null }),
      batch: async (request) => {
        sent.push(request);
        return {
          results: request.commands.map((command) => {
            const existed = candidateByKey.has(command.key);
            let candidate = candidateByKey.get(command.key);
            if (command.op === 'propose' && !candidate) {
              candidate = uuid(String(nextCandidate++));
              candidateByKey.set(command.key, candidate);
            }
            return {
              key: command.key,
              status: command.op === 'propose' && existed ? 200 : 201,
              value: command.op === 'propose' ? { candidate: candidate!, revision: 1 } : { revision: 1 },
            };
          }),
        };
      },
      journal,
      relationSnapshot,
    });

  graph.remember([draft]);
  const initialSnapshot = { currentKeys: [graphEdgeKey(draft)], scope: ['10', '11'], digest: 'd'.repeat(64), complete: true };
  const first = await deliver(initialSnapshot);
  const firstRow = database
    .query('SELECT status, command_payload FROM cross_media_graph WHERE edge_key=?')
    .get(graphEdgeKey(draft)) as { status: string; command_payload: string };
  const firstCommand = JSON.parse(firstRow.command_payload).commands[0];
  expect(first.proposed).toHaveLength(1);
  expect(firstCommand).toMatchObject({
    source: { record_revision: 'unversioned', converter_revision: 'bangumi-vocabulary@2:relation-2@2:12:6' },
    statement: { property: { id: 'rezics:sideStoryOf' } },
  });
  expect(firstCommand.source.digest).toMatch(/^[a-f0-9]{64}$/);
  expect(firstRow.status).toBe('proposed');

  database.close();
  const reopenedDatabase = new Database(path, { strict: true });
  const reopened = new CrossMediaGraph(reopenedDatabase);
  activeGraph = reopened;
  reopened.remember([draft]);
  expect((await deliver(initialSnapshot)).proposed).toHaveLength(0);
  expect(sent).toHaveLength(1);

  const changedRelation = { ...draft.relation! };
  delete changedRelation.reciprocalCode;
  const changed = {
    ...draft,
    property: 'wdt:P361',
    relation: { ...changedRelation, mappingRevision: 'bangumi-relation-2@2:12:one-sided', evidence: [draft.relation!.evidence[0]!] },
  };
  reopened.remember([changed]);
  const changedSnapshot = { currentKeys: [graphEdgeKey(changed)], scope: ['10', '11'], digest: 'e'.repeat(64), complete: true };
  expect((await deliver(changedSnapshot)).proposed).toHaveLength(1);
  const preserved = reopenedDatabase
    .query('SELECT command_payload FROM cross_media_graph WHERE edge_key=?')
    .get(graphEdgeKey(draft)) as { command_payload: string };
  expect(preserved.command_payload).toBe(firstRow.command_payload);
  expect(sent).toHaveLength(3);
  expect(sent[2]?.commands[0]?.op).toBe('retract');

  const fencedDraft: GraphEdgeDraft = {
    ...draft,
    holder: '12',
    target: '13',
    record: { subject_id: 12, related_subject_id: 13, relation_type: 12 },
    relation: {
      ...draft.relation!,
      sourceSubject: '12',
      sourceEndpoint: '13',
      path: '/subject-relations/12/13',
      evidence: [{ path: '/subject-relations/12/13', code: 12, sourceSubject: '12', sourceEndpoint: '13', digest: 'c'.repeat(64) }],
    },
  };
  reopened.remember([fencedDraft]);
  const refused = await reopened.deliver({
    claim,
    nativeType: () => 'schema:TVSeries',
    fence: async () => ({ fenced: true, securityRevision: 'security-revision' }),
    batch: async () => {
      throw new Error('Fenced relation reached the write transport');
    },
  });
  expect(refused.unresolved.map(({ reason }) => reason)).toEqual(['fenced_relation_holder']);

  const missingDraft: GraphEdgeDraft = {
    ...fencedDraft,
    holder: '14',
    target: '999',
    record: { subject_id: 14, related_subject_id: 999, relation_type: 12 },
    relation: { ...fencedDraft.relation!, sourceSubject: '14', sourceEndpoint: '999', path: '/subject-relations/14/999' },
  };
  reopened.remember([missingDraft]);
  const missing = await reopened.deliver({
    claim: ({ external_id }) => external_id === '999' ? { state: 'pending' } : claim({ external_id }),
    nativeType: () => 'schema:TVSeries',
    fence: async () => ({ fenced: false, securityRevision: null }),
    batch: async () => {
      throw new Error('Missing endpoint reached the write transport');
    },
  });
  expect(missing.unresolved.map(({ reason }) => reason)).toEqual(['missing_endpoint:999']);
  reopenedDatabase.close();
  await rm(directory, { recursive: true, force: true });
});
