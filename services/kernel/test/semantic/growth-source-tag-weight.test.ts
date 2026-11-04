import { afterAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { itemFacts, relationSlotId } from '../../src/semantic/item.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { checkGrowth, seed } from '../support/growth.ts';
import { createListPresentationFixture, type ListPresentationFixture } from './support/list-presentation-fixture.ts';
import { produceVndbSourceTagWeightCandidate, vndbTagsRatingEndpoint } from '../../src/semantic/source-tag-weight.ts';

const scales = [64, 512, 4096] as const;
const nil = '00000000-0000-0000-0000-000000000000';
let fixture: ListPresentationFixture;

afterAll(async () => {
  await fixture?.close();
});

test('source-weighted tag page rows, target disclosure and response bytes stay fixed across unrelated and obsolete history growth', async () => {
  fixture = await createListPresentationFixture({ poolMax: 1 });
  const snapshot = new Uint8Array(
    await Bun.file(new URL('../fixtures/vndb-source-weight-v17.json', import.meta.url)).arrayBuffer(),
  );
  const tag = await fixture.create('skos:Concept', {}, { en: 'Measured VNDB concept' });
  const unweighted = await fixture.create('skos:Concept', {}, { en: 'Unweighted concept' });
  const work = await fixture.create('wd:Q689445', {}, { en: 'Fixed weighted visual novel' });
  const weighted = produceVndbSourceTagWeightCandidate({
    endpoint: vndbTagsRatingEndpoint,
    requestBody: JSON.stringify({
      filters: ['id', '=', 'v17'],
      fields: 'id,tags{id,rating,spoiler,lie}',
      results: 1,
    }),
    snapshot,
    subjectId: work,
    contextId: GLOBAL_CONTEXT,
    property: 'schema:keywords',
    conceptId: tag,
    subjectRecordId: 'v17',
    tagId: 'g3',
  });
  expect(weighted.state).toBe('available');
  if (weighted.state !== 'available') return;
  const proposed = await fixture.checked('POST', `/v1/subjects/${work}/candidates`, {
    statement: weighted.candidate.statement,
  });
  await fixture.adopt(work, 'schema:keywords', [proposed.candidate as string]);
  const unweightedCandidate = await fixture.propose(work, 'schema:keywords', unweighted);
  await fixture.adopt(work, 'schema:keywords', [unweightedCandidate]);
  const current = await fixture.call('GET', `/v1/subjects/${work}`);
  expect(current.status).toBe(200);
  const revision = current.body.subject.revision as number;
  const route = routeOf(work)!;
  const hotPartition = partitionOf(route);
  const evidenceLimit = 26 * (2048 + 10240);

  const report = await checkGrowth(fixture.db, {
    name: 'Source-weighted classification windows and disclosed target summaries',
    scales,
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    byteBounds: { requestBytes: 'constant', responseBytes: 'constant' },
    counted: {
      read(value) {
        return value as { responseBytes: number; sourceEvidenceBytes: number; weightedFacts: number; targets: number };
      },
      limits: { sourceEvidenceBytes: evidenceLimit, weightedFacts: 2, targets: 26 },
      bounds: {
        sourceEvidenceBytes: 'constant',
        weightedFacts: 'constant',
        targets: 'constant',
        responseBytes: 'constant',
      },
    },
    async grow(db, scale, previous) {
      await seed(
        db,
        {
          name: 'unrelated-subjects-and-obsolete-tag-assertions',
          hotPartition,
          hotShare: 1,
          rows({ ordinal, route: placedRoute }) {
            const other = newId(placedRoute);
            const otherTransaction = randomUUID();
            const otherFacts = itemFacts(other, { labels: { en: `Unrelated subject ${ordinal}` } });
            const staleTarget = newId(route);
            const staleCandidate = newId(route);
            const staleSlot = relationSlotId(work, 'schema:keywords', staleTarget);
            const staleTransaction = randomUUID();
            const staleStatement = {
              ...weighted.candidate.statement,
              value: { type: 'value', content: staleTarget },
            };
            return {
              'semantic.subject': [
                {
                  route: placedRoute,
                  subject_id: other,
                  type: 'skos:Concept',
                  recorded_transaction_id: otherTransaction,
                  current_facts: otherFacts.length,
                  current_release: bundledDigest,
                  visibility: 'visible',
                  security_revision: 0,
                },
              ],
              'semantic.revision': [
                {
                  route: placedRoute,
                  subject_id: other,
                  revision: 1,
                  kind: 'create',
                  release: bundledDigest,
                  recorded_transaction_id: otherTransaction,
                },
              ],
              'semantic.fact': [
                ...otherFacts.map((fact) => ({
                  ...fact,
                  route: placedRoute,
                  subject_id: other,
                  recorded_transaction_id: otherTransaction,
                  release: null,
                })),
                {
                  route,
                  subject_id: work,
                  slot_id: staleSlot,
                  log_seq: 1,
                  operation: 'assert',
                  kind: 'statement',
                  language: null,
                  property: 'schema:keywords',
                  statement_id: staleCandidate,
                  body: staleStatement,
                  recorded_transaction_id: staleTransaction,
                  release: bundledDigest,
                  relation: true,
                },
                {
                  route,
                  subject_id: work,
                  slot_id: staleSlot,
                  log_seq: 2,
                  operation: 'retract',
                  kind: 'statement',
                  language: null,
                  property: 'schema:keywords',
                  statement_id: staleCandidate,
                  body: staleStatement,
                  recorded_transaction_id: staleTransaction,
                  release: null,
                  relation: true,
                },
              ],
              'semantic.candidate': [
                {
                  route,
                  subject_id: work,
                  candidate_id: staleCandidate,
                  slot_id: staleSlot,
                  property: 'schema:keywords',
                  rank: 'normal',
                  statement: staleStatement,
                  release: bundledDigest,
                  revision,
                  origin: 'proposal',
                  view_order: 0,
                  relation: true,
                },
              ],
              'semantic.outbound_link': [
                {
                  route,
                  subject_id: work,
                  property: 'schema:keywords',
                  filter_value: nil,
                  order_key: `obsolete-${String(ordinal).padStart(4, '0')}`,
                  target_subject_id: staleTarget,
                  statement_id: staleCandidate,
                  slot_id: staleSlot,
                  relation: true,
                  source_type: 'wd:Q689445',
                  source_order_key: '',
                  outbound_order: null,
                  source_revision: revision,
                  source_security_revision: 0,
                  target_revision: 0,
                  target_type: 'skos:Concept',
                  external: null,
                  value: 'value',
                  present: false,
                  recorded_transaction_id: staleTransaction,
                  context_id: GLOBAL_CONTEXT,
                  suppressed: false,
                },
              ],
            };
          },
        },
        { from: previous, to: scale },
      );
    },
    async operation() {
      const response = await fixture.call(
        'POST',
        '/v1/pages:read',
        { target: { subject: work }, languages: ['en'] },
        'anonymous',
      );
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const read = Object.values(response.body.reads as Record<string, any>).find(
        (result) => result.status === 200 && result.body?.subject?.id === work,
      )?.body;
      expect(read?.related[tag]?.labels.en).toBe('Measured VNDB concept');
      const statements = read?.subject.statements as Record<string, any[]>;
      const keywordStatements = statements['schema:keywords'] ?? [];
      expect(keywordStatements).toHaveLength(2);
      expect(keywordStatements.some((statement) =>
        statement.qualifiers.some((part: any) => part.property.id === 'rezics:sourceTagWeight'),
      )).toBe(true);
      const associationFacts = {
        statements: {
          genre: statements['schema:genre'] ?? [],
          keywords: keywordStatements,
        },
        related: Object.fromEntries(
          [tag, unweighted].map((id) => [id, read.related[id]]).filter(([, value]) => value !== undefined),
        ),
      };
      const sourceEvidenceBytes = Buffer.byteLength(JSON.stringify(associationFacts), 'utf8');
      expect(sourceEvidenceBytes).toBeLessThanOrEqual(evidenceLimit);
      return {
        responseBytes: Buffer.byteLength(JSON.stringify(response.body), 'utf8'),
        sourceEvidenceBytes,
        weightedFacts: keywordStatements.filter((statement) =>
          statement.qualifiers.some((part: any) => part.property.id === 'rezics:sourceTagWeight'),
        ).length,
        targets: Object.keys(associationFacts.related).length,
      };
    },
  });
  expect(report.samples.map(({ scale }) => scale)).toEqual([...scales]);
  for (const sample of report.samples) {
    expect(sample.counted?.sourceEvidenceBytes?.value).toBeLessThanOrEqual(evidenceLimit);
    expect(sample.counted?.weightedFacts?.value).toBe(1);
    expect(sample.cost.relations['semantic.outbound_link']?.sequentialScans ?? 0).toBe(0);
    expect(sample.cost.relations['semantic.fact']?.sequentialScans ?? 0).toBe(0);
  }
});
