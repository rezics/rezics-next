import { expect, test } from 'bun:test';
import captured from './bangumi-captured-subjects.json';
import { vocabularyDigest } from '../src/modules/classification/vocabulary.ts';
import { gamePlatformConcepts, type GamePlatformKey } from '../../../scripts/dev/seed/relation-lexicon-data.ts';
import { bangumiGameFacts, type BangumiFactSource, type BangumiPublicationDate }
  from '../../../scripts/datasets/bangumi.ts';

const actor = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
const subjects = captured as Record<string, BangumiFactSource>;
const day = 'http://www.w3.org/2001/XMLSchema#date';
const year = 'http://www.w3.org/2001/XMLSchema#gYear';
const on = (lexical: string, datatype: BangumiPublicationDate['datatype']): BangumiPublicationDate =>
  ({ lexical, datatype });

function platformTokens(record: BangumiFactSource): string[] {
  const box = record.infobox as { key: string; value: unknown }[];
  const values = box.find(row => row.key === '平台')?.value;
  if (Array.isArray(values)) return values.map(value => (value as { v: string }).v);
  return typeof values === 'string' ? [values] : [];
}

test('game platform concepts match the distinct tokens in real captured type-4 subjects', () => {
  const gameIds = ['2113', '636913'];
  const observed = [...new Set(gameIds.flatMap(id => platformTokens(subjects[id]!)))].sort();
  expect(observed).toEqual(gamePlatformConcepts.map(concept => concept.token).sort());
  for (const concept of gamePlatformConcepts) {
    expect(vocabularyDigest({ actingSubject: actor, scheme: null, labels: [...concept.labels],
      alternativeLabels: [], broader: [], narrower: [] })).toMatch(/^[0-9a-f]{64}$/);
  }
});

test('captured game facts keep multiple platforms, leave a missing platform empty, and choose the earliest date', () => {
  expect(bangumiGameFacts(subjects['2113']!)).toEqual({
    subjectId: '2113', platforms: ['ngc', 'n64'], date: on('1998-11-21', day),
  });
  expect(bangumiGameFacts(subjects['636913']!)).toEqual({
    subjectId: '636913', platforms: [], date: on('2021', year),
  });

  const repeatedAndUnknown = bangumiGameFacts({ id: 7, type: 4, infobox: [
    { key: '平台', value: [{ v: 'N64' }, { v: 'N64' }, { v: 'Unknown console' }] },
    { key: '发行日期', value: [{ v: '2001-03-04 (Japan)' }, { v: '1998年11月21日' }, { v: '2000年' }] },
  ] });
  expect(repeatedAndUnknown.platforms).toEqual(['n64']);
  expect(repeatedAndUnknown.date).toEqual(on('1998-11-21', day));
  expect(bangumiGameFacts({ id: 8, type: 4, infobox: '|平台=unrecognized' }).platforms).toEqual([]);
  expect(() => bangumiGameFacts({ id: 9, type: 2, platform: 1 })).toThrow('not a game');
});

test('the platform scheme remains separate from the single-valued anime and manga formats', () => {
  const keys: GamePlatformKey[] = gamePlatformConcepts.map(concept => concept.key);
  expect(keys).toEqual(['n64', 'ngc']);
});
