import { expect, test } from 'bun:test';
import { corpusPublicUnits, fixtureCorpus, publicUnitAt }
  from '../../../scripts/fixture/corpus.ts';
import { graphOwner } from '../../../scripts/fixture/owners/graph.ts';

test('SEARCH18: fixture plans 10,000 distinct public MatchUnits with bounded phrase degrees', () => {
  const corpus = fixtureCorpus('medium');
  expect(corpus.publicUnits).toBe(10_000);
  const units = [...corpusPublicUnits(corpus)];
  expect(new Set(units.map(unit => unit.unit)).size).toBe(10_000);
  expect(units.filter(unit => unit.body.includes('public load'))).toHaveLength(64);
  expect(units.filter(unit => unit.body.includes('candidate degree'))).toHaveLength(512);
  expect(units.filter(unit => unit.body.includes('overflow degree'))).toHaveLength(513);
  expect(units[2]?.work.language).toBe('zh');
  expect(units[4]?.work.language).toBe('ja');
  expect(units[128]!.body.length).toBeGreaterThan(4_000);
  expect(units[129]!.body).toContain('rejected sapphire harbor');
  expect(publicUnitAt(corpus, 9_999)).toEqual(units[9_999]);
});

test('OPS05/SEARCH18: deterministic public graph plan scales with the imported corpus', () => {
  const small = fixtureCorpus('small');
  const medium = fixtureCorpus('medium', undefined, 10_000);
  const first = graphOwner.summarize(small);
  const second = graphOwner.summarize(medium);
  expect(graphOwner.summarize(small)).toEqual(first);
  expect(first.counts['graph:public']).toBe(1 + 11 * small.publicUnits);
  expect(second.counts['graph:public']).toBe(1 + 11 * medium.publicUnits);
  const unrelated = medium.works - small.works;
  const currentGrowth = second.counts['graph:current']! - first.counts['graph:current']!
    - 7 * (medium.publicUnits - small.publicUnits);
  expect(currentGrowth).toBeGreaterThanOrEqual(9 * unrelated);
  expect(currentGrowth).toBeLessThanOrEqual(11 * unrelated);
}, 15_000);
