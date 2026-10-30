import { expect, test } from 'bun:test';
import { GLOBAL_CONTEXT } from '../../src/access/gates/catalogue.ts';
import { STANDARD_QUESTION_ID } from '../../src/rating/votes.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { assertGrowthAccessPaths, checkGrowth } from '../support/growth.ts';
import {
  body,
  createNativePublicationFixture,
  PUBLICATION_GROWTH_SCALES,
} from './public-figure-native-publication-fixture.ts';

test('Original documented privacy, replay and raw growth bounds remain strict', async () => {
  const fixture = await createNativePublicationFixture();
  try {
    // Keep the exact target's count, mean and score fixed even when genuine unrelated votes start another epoch.
    // All native votes in this growth fixture are 16 units (8 display points), including its fifty-vote prior.
    await fixture.establishPrior(16);
    for (const voter of fixture.members) await fixture.applied(await fixture.vote(fixture.target, voter, 16));
    const partition = partitionOf(routeOf(fixture.target)!);
    const unrelatedSubjects: string[] = [];
    const historicalPopulations: string[] = [];

    // Independently vary subject/figure cardinality and same-subject population history. Both keep their
    // growing rows in this exact target's anchor partition and retain all native producer outcomes.
    for (const dimension of ['subjects', 'population history'] as const) {
      const name = `native public figure exact reads under ${dimension} growth`;
      const report = await checkGrowth(fixture.database, {
        name,
        scales: PUBLICATION_GROWTH_SCALES,
        repetitions: 2,
        bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
        grow: async (database, scale, previous) => {
          for (let index = previous; index < scale; index++) {
            if (dimension === 'subjects') {
              const subjectId = await fixture.createSubject(partition);
              unrelatedSubjects.push(subjectId);
              await fixture.applied(await fixture.vote(subjectId, fixture.outsiders[0]!, 16));
              expect(await fixture.current(subjectId)).toMatchObject({ count: 1, mean: null, score: null });
            } else {
              historicalPopulations.push(await fixture.createHistoricalPopulation(fixture.target, fixture.members[0]!));
            }
          }
          await fixture.settle();
          const ids = dimension === 'subjects' ? unrelatedSubjects : historicalPopulations;
          expect(ids).toHaveLength(scale);
          // Observe the actual relation footprint and its source identity. Never replace the harness's
          // metrics with response size, a catalogue filter, a counter or a local cost classifier.
          if (dimension === 'subjects') {
            const rows = await database.admin.query<{ subjects: number; figures: number; native_votes: number }>(
              `SELECT
                (SELECT count(*)::integer FROM semantic.subject WHERE (route >> 4) = $1
                   AND subject_id = ANY($2::uuid[])) AS subjects,
                (SELECT count(*)::integer FROM rating.public_figure WHERE partition_no = $1
                   AND subject_id = ANY($2::uuid[]) AND question_id = $3 AND population_id = $4
                   AND count = 1 AND revision > 0 AND pending_position IS NULL) AS figures,
                (SELECT count(*)::integer FROM rating.population_vote WHERE target_id = ANY($2::uuid[])
                   AND question_id = $3 AND population_id = $4 AND units = 16) AS native_votes`,
              [partition, unrelatedSubjects, STANDARD_QUESTION_ID, GLOBAL_CONTEXT.id],
            );
            expect(rows.rows).toEqual([{ subjects: scale, figures: scale, native_votes: scale }]);
            expect(unrelatedSubjects.every((id) => partitionOf(routeOf(id)!) === partition)).toBe(true);
          } else {
            const rows = await database.admin.query<{ figures: number; components: number }>(
              `SELECT
                (SELECT count(*)::integer FROM rating.public_figure WHERE partition_no = $1
                   AND route = $2 AND subject_id = $3 AND question_id = $4
                   AND population_id = ANY($5::uuid[]) AND count = 0 AND revision > 0
                   AND pending_position IS NULL AND pending_prior_generation IS NULL) AS figures,
                (SELECT count(DISTINCT population_id)::integer FROM rating.aggregate_component WHERE route = $2
                   AND target_id = $3 AND question_id = $4 AND population_id = ANY($5::uuid[])) AS components`,
              [partition, routeOf(fixture.target), fixture.target, STANDARD_QUESTION_ID, historicalPopulations],
            );
            expect(rows.rows).toEqual([{ figures: scale, components: scale }]);
          }
          const current = await fixture.current(fixture.target);
          expect(current).toMatchObject({ count: 5, mean: 8, score: 8, m: 8, C: 5 });
        },
        operation: async (_database, scale) => {
          // This is only the declared exact public read operation. All required native producers ran
          // during grow; no asynchronous producer or unrelated startup work is moved out of this capture.
          const expectedFigure = {
            questionId: STANDARD_QUESTION_ID,
            populationId: GLOBAL_CONTEXT.id,
            scale: { min: 0, max: 20, displayStep: 1 },
            count: 5,
            state: 'ready',
            mean: 8,
            score: 8,
          };
          const responses = [];
          const etags = [];
          for (const actor of [null, fixture.reader]) {
            const response = await fixture.request('GET', `/v1/subjects/${fixture.target}/figure`, { actor });
            etags.push(response.headers.get('etag'));
            const result = await body(response);
            expect(result).toEqual({ figure: expectedFigure });
            responses.push(result);
          }
          const epoch = dimension === 'subjects' && scale < 45 ? 1 : 2;
          const snapshot = await fixture.source.read(partition, [fixture.target]);
          expect(snapshot.partition).toBe(partition);
          expect(snapshot.position).toBeGreaterThan(0n);
          expect([...snapshot.figures]).toEqual([
            [
              fixture.target,
              {
                questionId: STANDARD_QUESTION_ID,
                populationId: GLOBAL_CONTEXT.id,
                subjectId: fixture.target,
                count: 5,
                mean: 8,
                score: 8,
                priorEpoch: epoch,
                revision: expect.stringMatching(/^[1-9][0-9]*$/),
                asOf: expect.any(String),
              },
            ],
          ]);
          const sourceFigure = snapshot.figures.get(fixture.target)!;
          expect(etags).toEqual([`"${sourceFigure.revision}"`, `"${sourceFigure.revision}"`]);
          expect(await fixture.source.epoch()).toEqual({
            questionId: STANDARD_QUESTION_ID,
            populationId: GLOBAL_CONTEXT.id,
            priorEpoch: epoch,
          });
          return { responses, snapshot, etags };
        },
      });
      expect(report.samples.map(({ scale }) => scale)).toEqual([...PUBLICATION_GROWTH_SCALES]);
      const relations = [
        ...new Set(
          report.samples.flatMap((sample) =>
            sample.repetitions.flatMap((repetition) => Object.keys(repetition.relations)),
          ),
        ),
      ];
      expect(relations).toEqual(
        expect.arrayContaining([
          'semantic.subject',
          'rating.question',
          'rating.public_figure',
          'rating.population_prior_epoch',
          'core.partition',
        ]),
      );
      // Use every actual touched relation and unmodified raw metrics/footprints, including Access and catalogue work.
      assertGrowthAccessPaths(name, report.samples, relations);
      for (const sample of report.samples) {
        expect(sample.repetitions).toHaveLength(2);
        expect(sample.relationSizes['rating.public_figure']).toBeDefined();
        for (const repetition of sample.repetitions) {
          expect(repetition.rows).toBeGreaterThan(0);
          expect(repetition.statements).toBeGreaterThan(0);
          expect(repetition.blocks).toBeGreaterThan(0);
        }
      }
    }
  } finally {
    await fixture.close();
  }
}, 1_800_000);
