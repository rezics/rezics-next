import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { releaseDigest } from '@rezics/definitions';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import readCompactCandidate from '../../src/semantic/candidates-read-compact-candidate.sql';
import readDecisionCandidate from '../../src/semantic/candidates-read-decision-candidate.sql';
import { itemFacts, isRelationProperty } from '../../src/semantic/item.ts';
import { checkGrowth, openGrowthDatabase, seed, type GrowthDatabase, type Population } from '../support/growth.ts';

let db: GrowthDatabase;
const historyScales = [64, 512, 4096] as const;
const unrelatedScales = [64, 512, 4096] as const;
const headRelease = {
  ...bundledRelease,
  catalogue: { ...bundledRelease.catalogue, version: 'compact-decision-history' },
};
const headDigest = releaseDigest(headRelease);

beforeAll(async () => {
  db = await openGrowthDatabase();
  await seed(
    db,
    {
      name: 'compact-head-release',
      hotPartition: 0,
      rows: () => ({
        'semantic.definition_release': [
          { route: 0, digest: headDigest, body: headRelease, recorded_transaction_id: randomUUID() },
        ],
      }),
    },
    { from: 0, to: 1 },
  );
});
afterAll(async () => {
  await db?.close();
});

for (const property of ['schema:inLanguage', 'schema:author'] as const) {
  for (const axis of ['history', 'unrelated'] as const) {
    test(`full compact ${property} decision lookup stays bounded with ${axis} growth`, async () => {
      const scales = axis === 'history' ? historyScales : unrelatedScales;
      const route = 8672;
      const subject = newId(route);
      const target = newId(route);
      const origin = randomUUID();
      const relation = isRelationProperty(bundledRelease, property);
      const facts = itemFacts(
        subject,
        {
          type: 'schema:Book',
          labels: { en: 'Fixed compact candidate' },
          statements: {
            [property]: [{ property: { id: property }, value: { type: 'value', content: relation ? target : 'ja' } }],
          },
        },
        'schema:Book',
        bundledRelease,
      );
      const fact = facts.find((row) => row.kind === 'statement')!;
      const params = { route, subject_id: subject, candidate_id: fact.statement_id! };
      const metadata = {
        candidate_id: fact.statement_id!,
        property,
        slot_id: fact.slot_id,
        relation,
      };
      const revision = (id: string, number: number, transaction = randomUUID()) => ({
        route: routeOf(id)!,
        subject_id: id,
        revision: number,
        kind: number === 1 ? 'create' : 'accept',
        release: number === 1 ? bundledDigest : headDigest,
        recorded_transaction_id: transaction,
      });
      // Invariant-only storage seeding isolates lookup cost. The frozen native API suite owns decisions/replay.
      await seed(
        db,
        {
          name: `compact-anchor-${property}-${axis}`,
          hotPartition: partitionOf(route),
          rows: () => ({
            'semantic.subject': [
              {
                route,
                subject_id: subject,
                type: 'schema:Book',
                current_release: headDigest,
                current_facts: facts.filter((row) => row.kind !== 'statement' || !relation).length,
                recorded_transaction_id: origin,
              },
              {
                route,
                subject_id: target,
                type: 'schema:Person',
                current_release: bundledDigest,
                current_facts: 0,
                recorded_transaction_id: randomUUID(),
              },
            ],
            'semantic.revision': [revision(subject, 1, origin), revision(subject, 2), revision(target, 1)],
            'semantic.fact': facts.map((row) => ({
              ...row,
              route,
              subject_id: subject,
              recorded_transaction_id: origin,
              release: row.kind === 'statement' ? bundledDigest : null,
              relation: row.kind === 'statement' && relation,
            })),
          }),
        },
        { from: 0, to: 1 },
      );

      const population: Population = {
        name: `compact-${property}-${axis}`,
        hotPartition: partitionOf(route),
        rows: ({ ordinal, route: unrelatedRoute }) => {
          if (axis === 'history') return { 'semantic.revision': [revision(subject, ordinal + 1)] };
          const id = newId(unrelatedRoute);
          const transaction = randomUUID();
          return {
            'semantic.subject': [
              {
                route: unrelatedRoute,
                subject_id: id,
                type: 'schema:Book',
                current_release: bundledDigest,
                current_facts: 0,
                recorded_transaction_id: transaction,
              },
            ],
            'semantic.revision': [revision(id, 1, transaction)],
          };
        },
      };
      const operation = async (scale: number) => {
        const row = await readCompactCandidate.run(db.pool, params);
        expect(row).toEqual({ ...metadata, revision: axis === 'history' ? scale : 2, release: bundledDigest });
        return row;
      };
      const report = await checkGrowth(db, {
        name: `Compact candidate decision ${property} ${axis}`,
        scales,
        rule: 'series',
        bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
        grow: async (database, scale, previous) => {
          await seed(database, population, { from: axis === 'history' ? Math.max(2, previous) : previous, to: scale });
        },
        operation: (_database, scale) => operation(scale),
      });
      expect(report.samples.map(({ scale }) => scale)).toEqual([...scales]);
      expect(report.samples.every(({ cost }) => cost.statements === 1)).toBe(true);
      console.info(
        `COMPACT_DECISION_GROWTH ${JSON.stringify({
          name: report.name,
          samples: report.samples.map(({ scale, cost, repetitions }) => ({ scale, cost, repetitions })),
          shadow: report.shadow,
          verdicts: report.verdicts,
        })}`,
      );
      type PlanNode = Record<string, unknown> & { Plans?: PlanNode[] };
      const nodes = (node: PlanNode): PlanNode[] => [node, ...(node.Plans ?? []).flatMap(nodes)];
      for (const sample of [report.samples[0]!, report.samples.at(-1)!]) {
        for (const [repetition, occurrences] of sample.occurrenceRepetitions.entries()) {
          expect(occurrences.statements).toHaveLength(1);
          const occurrence = occurrences.statements[0]!;
          console.info(
            `COMPACT_DECISION_PLAN ${JSON.stringify({ property, axis, scale: sample.scale, repetition, occurrence })}`,
          );
          const label = `${property} compact statement at ${axis} scale ${sample.scale}, repetition ${repetition}: ${occurrence.statement}`;
          expect(occurrence.statement, label).toContain('SELECT latest.revision, r.release');
          expect(occurrence.planDocuments, `${label}: retained native occurrence plan`).toHaveLength(1);
          const document = occurrence.planDocuments[0] as { Plan: PlanNode };
          const planNodes = nodes(document.Plan);
          expect(planNodes, `${label}: descending indexed latest head lookup`).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                'Node Type': 'Index Only Scan',
                'Index Name': 'revision_pkey',
                'Scan Direction': 'Backward',
              }),
            ]),
          );
          if (axis === 'history' && sample.scale === scales.at(-1)) {
            const originNode = planNodes.find((node) => node.Alias === 'revision');
            expect(originNode, `${label}: indexed origin release lookup`).toMatchObject({
              'Node Type': expect.stringMatching(/^Index (?:Only )?Scan$/),
            });
            for (const key of ['recorded_transaction_id', 'route', 'subject_id'])
              expect(originNode?.['Index Cond'], `${label}: origin point condition ${key}`).toContain(key);
          }
        }
      }
      expect(
        (
          await db.admin.query('SELECT candidate_id FROM semantic.candidate WHERE route=$1 AND subject_id=$2', [
            route,
            subject,
          ])
        ).rows,
      ).toEqual([]);

      // Materializing the same candidate changes neither its identity nor either read's established release role.
      await seed(
        db,
        {
          name: 'expanded-compact-metadata',
          hotPartition: partitionOf(route),
          rows: () => ({
            'semantic.candidate': [
              {
                route,
                subject_id: subject,
                ...metadata,
                rank: 'normal',
                statement: fact.body,
                release: bundledDigest,
                revision: 1,
                origin: 'compact',
                view_order: fact.log_seq,
              },
            ],
          }),
        },
        { from: 0, to: 1 },
      );
      expect(await readDecisionCandidate.run(db.pool, params)).toEqual({
        ...metadata,
        revision: axis === 'history' ? scales.at(-1)! : 2,
        release: headDigest,
      });
      expect(await readCompactCandidate.run(db.pool, params)).toEqual({
        ...metadata,
        revision: axis === 'history' ? scales.at(-1)! : 2,
        release: bundledDigest,
      });
    }, 180_000);
  }
}
