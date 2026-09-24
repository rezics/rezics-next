import { test, expect } from 'bun:test';
import { canonicalRatingInstant, sameRatingInstant } from '../src/modules/rating/observation.ts';

test('RDF dateTime canonicalization preserves exact standing rating revision time', () => {
  const recorded = '2026-09-24T03:53:50.520Z';
  const jenaLexical = '2026-09-24T03:53:50.52Z';
  expect(canonicalRatingInstant(jenaLexical)).toBe(recorded);
  expect(sameRatingInstant(recorded, jenaLexical)).toBe(true);
  expect(sameRatingInstant(recorded, '2026-09-24T03:53:50.521Z')).toBe(false);
  expect(sameRatingInstant(jenaLexical, recorded)).toBe(false);
  expect(sameRatingInstant(null, jenaLexical)).toBe(false);
});
