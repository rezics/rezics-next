import { expect, test } from 'bun:test';
import type { Coordinate } from '../src/modules/projection/dimension.ts';
import { projectionStatementMeaning, StatementApplicabilityRefused } from '../src/modules/statement/projection.ts';
import { framePattern, matchFromScore, FRAME_READ_COST } from '../src/modules/projection/frame-read.ts';
import { GRAPHS } from '../src/modules/work/activate.ts';

const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const coordinate = (iri: string, dimension: Coordinate['dimension'], extra = {}): Coordinate => ({ iri, dimension, ...extra });
const canon = coordinate(id(1), 'continuity');
const legends = coordinate(id(2), 'continuity');
const work = coordinate(id(3), 'work', { work: id(3), continuities: [canon.iri, legends.iri] });
const volume = id(5);
const position = coordinate(id(4), 'position', { work: work.iri, ancestors: [volume], continuities: [canon.iri, legends.iri] });
const release = coordinate(id(6), 'release', { work: work.iri, continuities: [canon.iri] });
const refusal = (run: () => unknown) => { try { run(); } catch (error) { return error instanceof StatementApplicabilityRefused ? error.code : error; } };

test('specificity scores decode into constrained dimensions and exact coordinates', () => {
  expect(matchFromScore(0)).toEqual({ dimensions: 0, exact: 0, score: 0 });
  expect(matchFromScore(33)).toEqual({ dimensions: 2, exact: 1, score: 33 });
  expect(() => matchFromScore(137)).toThrow();
});

test('a projection Statement has one home, a deduplicated union, and typed refusals', () => {
  expect(projectionStatementMeaning('subject', [canon, work], [canon]))
    .toEqual({ subject: 'subject', applicability: [canon.iri, work.iri].sort() });
  // A slot the frame leaves empty takes the caller's coordinates, several of them as OR alternatives.
  expect(projectionStatementMeaning('subject', [position], [canon, legends]).applicability)
    .toEqual([canon.iri, legends.iri, position.iri].sort());
  const many = (count: number) => Array.from({ length: count }, (_, index) => coordinate(id(100 + index), 'event'));
  expect(projectionStatementMeaning('subject', [position], many(7)).applicability).toHaveLength(8);
  expect(refusal(() => projectionStatementMeaning('subject', [position], many(8)))).toBe('statement_applicability_too_large');
});

test('applicability in a slot the frame already fills must be that coordinate', () => {
  const other = coordinate(id(7), 'position', { work: work.iri });
  // Another position, another continuity, the Work or a release the frame's slot holds: all would move the Statement.
  expect(refusal(() => projectionStatementMeaning('subject', [position], [other]))).toBe('statement_applicability_slot_occupied');
  expect(refusal(() => projectionStatementMeaning('subject', [position], [work]))).toBe('statement_applicability_slot_occupied');
  expect(refusal(() => projectionStatementMeaning('subject', [canon], [legends]))).toBe('statement_applicability_slot_occupied');
  expect(refusal(() => projectionStatementMeaning('subject', [release], [coordinate(id(8), 'realization')])))
    .toBe('statement_applicability_slot_occupied');
  // The same coordinate adds nothing, and a different slot is free.
  expect(projectionStatementMeaning('subject', [position], [position, canon]).applicability).toEqual([canon.iri, position.iri].sort());
});

test('a projection Statement cannot add an edition belonging to another Work', () => {
  const foreign = coordinate(id(9), 'release', { work: id(10) });
  expect(refusal(() => projectionStatementMeaning('subject', [position], [foreign])))
    .toBe('statement_applicability_work_mismatch');
  expect(projectionStatementMeaning('subject', [position], [release]).applicability)
    .toEqual([position.iri, release.iri].sort());
});

test('coverage combines Work and position alternatives in one structure slot, and editions in another', () => {
  const pattern = framePattern([position, release], '?statement', GRAPHS.current);
  expect(pattern.filter).toContain('?coordinate_structure');
  expect(pattern.filter).not.toContain('?coordinate_work');
  expect(pattern.filter).not.toContain('?coordinate_position');
  expect(pattern.filter).toContain('?coordinate_edition');
  expect(pattern.filter).not.toContain('?coordinate_release');
  expect(pattern.filter).not.toContain('?coordinate_realization');
});

test('coverage is applied to candidate queries: a position by its group and Work, a release by its Work', () => {
  const pattern = framePattern([position], '?statement', GRAPHS.current);
  expect(pattern.filter).toContain('FILTER(!EXISTS');
  for (const covering of [canon.iri, legends.iri, volume, work.iri, position.iri]) expect(pattern.filter).toContain(covering);
  expect(pattern.score).toContain('16');
  const edition = framePattern([release], '?statement', GRAPHS.current);
  expect(edition.filter).toContain(work.iri);
  expect(edition.filter).toContain(canon.iri);
  // Containment goes one way: a Work frame is covered by neither a group nor a release.
  expect(framePattern([work], '?statement', GRAPHS.current).filter).not.toContain(volume);
});

test('frame reads cost a bounded relation of the Work, and hidden memberships are skipped before the cap', () => {
  expect(FRAME_READ_COST).toEqual({ coordinates: 8, membershipBatch: 64, membershipScans: 8, membershipRows: 64, ancestorQueries: 16 });
});
