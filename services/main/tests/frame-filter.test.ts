import { expect, test } from 'bun:test';
import { covers, specificity, type Coordinate } from '../src/modules/projection/dimension.ts';
import { projectionStatementMeaning, StatementProjectionRefused } from '../src/modules/statement/projection.ts';
import { framePattern, matchFromScore, FRAME_READ_COST } from '../src/modules/projection/frame-read.ts';
import { GRAPHS } from '../src/modules/work/activate.ts';

const coordinate = (iri: string, dimension: Coordinate['dimension'], extra = {}): Coordinate => ({ iri, dimension, ...extra });
const canon = coordinate('https://rezics.com/id/00000000-0000-4000-8000-000000000001', 'continuity');
const legends = coordinate('https://rezics.com/id/00000000-0000-4000-8000-000000000002', 'continuity');
const work = coordinate('https://rezics.com/id/00000000-0000-4000-8000-000000000003', 'work', { continuities: [canon.iri, legends.iri] });
const position = coordinate('https://rezics.com/id/00000000-0000-4000-8000-000000000004', 'position',
  { work: work.iri, continuities: [canon.iri, legends.iri] });

test('Work and position coverage use only their own active continuity memberships', () => {
  expect(covers([canon], [work])).toBe(true);
  expect(covers([canon, legends], [work])).toBe(true);
  expect(covers([canon], [position])).toBe(true);
  expect(covers([canon, position], [position])).toBe(true);
  expect(covers([legends], [work, canon])).toBe(false);
  expect(covers([legends], [position, canon])).toBe(false);
  expect(covers([canon, legends], [work, canon])).toBe(true);
  expect(covers([canon], [coordinate(work.iri, 'work')])).toBe(false);
  expect(covers([position], [canon])).toBe(false);
  expect(covers([work], [canon])).toBe(false);
  expect(covers([canon], [coordinate(work.iri, 'release', { continuities: [canon.iri] })])).toBe(false);
});

test('specificity orders constrained dimensions and exact coordinates before inherited and global facts', () => {
  const applicability = [[], [canon, legends], [work], [position], [canon, position]];
  const ranked = applicability.map(items => specificity(items, [position]));
  expect(ranked.map(item => item.score)).toEqual([0, 16, 16, 17, 33]);
  expect(specificity([canon, legends], [canon])).toEqual(specificity([canon], [canon]));
  for (const match of ranked) expect(matchFromScore(match.score)).toEqual(match);
});

test('a projection Statement has one home, a deduplicated union, and a typed overflow refusal', () => {
  expect(projectionStatementMeaning('subject', [canon.iri, work.iri], [canon.iri]))
    .toEqual({ subject: 'subject', applicability: [canon.iri, work.iri].sort() });
  expect(projectionStatementMeaning('subject', ['frame'], Array.from({ length: 7 }, (_, i) => String(i))).applicability).toHaveLength(8);
  expect(() => projectionStatementMeaning('subject', ['frame'], Array.from({ length: 8 }, (_, i) => String(i))))
    .toThrow(StatementProjectionRefused);
});

test('coverage is applied to candidate queries, and membership preparation has a fixed request bound', () => {
  const pattern = framePattern([position], '?statement', GRAPHS.current);
  expect(pattern.filter).toContain('FILTER(!EXISTS');
  expect(pattern.filter).toContain(canon.iri);
  expect(pattern.filter).toContain(legends.iri);
  expect(pattern.score).toContain('16');
  expect(FRAME_READ_COST).toEqual({ coordinates: 8, membershipQueries: 1, membershipRows: 64 });
});
