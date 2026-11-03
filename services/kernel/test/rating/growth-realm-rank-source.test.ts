import { expect, test } from 'bun:test';
import { assertGrowthAccessPaths, checkGrowth } from '../support/growth.ts';
import {
  createGrowthRealmRankSourceFixture,
  REALM_RANK_SCALES,
  RANK_PAGE_SIZE,
  type RankGrowthDimension,
} from './support/growth-realm-rank-source-fixture.ts';

test('Derived native protected Realm rank page cost at 256/1024/4096 rows, including consumed withheld candidates and all native authority work', async () => {
  const fixture = await createGrowthRealmRankSourceFixture();
  try {
    const consumed = 3 * RANK_PAGE_SIZE; // First, strict deep and fully withheld; two empty pages consume zero.
    const full = fixture.pageBound(RANK_PAGE_SIZE);
    const empty = fixture.pageBound(0);
    for (const dimension of [
      'candidate depth',
      'question history',
      'subject and authority history',
    ] as const satisfies readonly RankGrowthDimension[]) {
      const report = await checkGrowth(fixture.database, {
        name: `protected Realm rank source under ${dimension}`,
        scales: REALM_RANK_SCALES,
        repetitions: 2,
        bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
        grow: async (_database, scale, previous) => {
          await fixture.grow(dimension, scale, previous);
          const plans = await fixture.planEvidence();
          for (const plan of plans) {
            expect(plan).toContain('realm_rank_score_idx');
            expect(plan).not.toContain('"Node Type":"Sort"');
          }
          expect(plans[1]).toContain('Index Cond');
          expect(plans[1]).toContain('ROW(score, subject_id) < ROW');
        },
        prepare: async () => {
          await fixture.refresh();
        },
        operation: async () => {
          const first = await fixture.page();
          const deep = await fixture.page({ ...fixture.request, cursor: fixture.cursors.deep! });
          const withheld = await fixture.page({ ...fixture.request, cursor: fixture.cursors.withheld! });
          const terminal = await fixture.page({ ...fixture.request, cursor: fixture.cursors.terminal! });
          const vacant = await fixture.page({ ...fixture.request, partition: (fixture.request.partition + 1) % 4096 });
          expect(first.candidates.map(({ subjectId }) => subjectId)).toEqual(
            fixture.ordered.slice(0, RANK_PAGE_SIZE).map(({ id }) => id),
          );
          const expectedDeep = fixture.ordered.slice(-128, -64);
          expect(deep.candidates.map(({ subjectId }) => subjectId)).toEqual(expectedDeep.map(({ id }) => id));
          expect(new Set(deep.candidates.map(({ score }) => score)).size).toBe(2);
          expect(first.next).toBeString();
          expect(deep.next).toBeString();
          expect(withheld.candidates).toEqual([]);
          expect(withheld.next).toBeString(); // No refill; a consumed full batch retains a legitimate cursor.
          expect(await fixture.page({ ...fixture.request, cursor: withheld.next! })).toEqual(terminal);
          expect(terminal).toEqual({ candidates: [], next: null });
          expect(vacant).toEqual(terminal);
        },
      });
      const relations = [
        ...new Set(
          report.samples.flatMap(({ repetitions }) => repetitions.flatMap(({ relations }) => Object.keys(relations))),
        ),
      ];
      expect(relations).toEqual(
        expect.arrayContaining([
          'rating.realm_rank',
          'rating.realm_rank_generation',
          'rating.population_prior_epoch',
          'core.partition',
          'community.realm',
          'community.space',
          'community.realm_revision',
          'community.realm_member',
          'access.membership_inverse',
          'semantic.subject',
          'semantic.revision',
        ]),
      );
      assertGrowthAccessPaths(report.name, report.samples, relations);
      for (const sample of report.samples) {
        // Six complete native calls: compare the fresh withheld cursor's empty page too.
        for (const cost of sample.repetitions) {
          expect(cost.rows).toBeGreaterThanOrEqual(consumed);
          expect(cost.relations['rating.realm_rank']!.rows).toBe(consumed);
          expect(cost.relations['semantic.subject']!.rows).toBeGreaterThanOrEqual(2 * consumed);
          expect(cost.rows).toBeLessThanOrEqual(3 * full.rows + 3 * empty.rows);
          expect(cost.statements + cost.controlStatements).toBeLessThanOrEqual(
            3 * full.statements + 3 * empty.statements,
          );
          expect(cost.controlStatements).toBe(6 * 8);
          expect(cost.sharedHit + cost.sharedRead).toBe(cost.blocks);
          expect(cost.blocks).toBeGreaterThan(0);
          expect(cost.limitations ?? []).toEqual([]);
        }
        for (const statements of sample.statementRepetitions) {
          const rank = statements.filter(({ statement }) => /FROM rating\.realm_rank\s/.test(statement));
          expect(rank.reduce((total, { count }) => total + count, 0)).toBe(6);
          expect(rank.some(({ statement }) => statement.includes('(score,subject_id) <'))).toBe(true);
          expect(statements.some(({ statement }) => statement.includes('access.resource_grant'))).toBe(true);
          expect(statements.some(({ statement }) => statement.includes('semantic.redirect'))).toBe(true);
        }
      }
    }
  } finally {
    await fixture.close();
  }
}, 1_800_000);
