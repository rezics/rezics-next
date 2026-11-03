import { expect, test } from 'bun:test';
import { bundledRelease } from '@rezics/definitions/bundled';
import { buildReleaseSearchFilter } from '../../src/search/release-search.ts';

const releaseType = 'wd:Q20631656';

test('release filters keep platform languages attached and preserve calendar precision', () => {
  const filter = buildReleaseSearchFilter(bundledRelease, releaseType, {
    platform: 'wd:Q1406',
    languages: ['en', 'ja', 'en'],
    date: { type: 'time', gte: '2024-02-29', lte: '2024-03' },
  });

  expect(filter).toEqual({
    and: [
      { type: { in: [releaseType] } },
      {
        statement: {
          property: 'schema:gamePlatform',
          in: ['wd:Q1406'],
          qualifiers: [{ property: 'schema:inLanguage', in: ['en', 'ja'] }],
        },
      },
      { statement: { property: 'schema:datePublished', range: { type: 'time', gte: '2024-02-29', lte: '2024-03' } } },
    ],
  });
});

test('age rating uses its released unit and producer roles stay release-specific', () => {
  expect(
    buildReleaseSearchFilter(bundledRelease, releaseType, {
      ageRating: { gte: 13, unit: 'http://www.wikidata.org/entity/Q577' },
      producer: { role: 'developer', subject: 'wd:Q123' },
    }),
  ).toEqual({
    and: [
      { type: { in: [releaseType] } },
      {
        statement: {
          property: 'wdt:P2899',
          range: { gte: 13, unit: 'http://www.wikidata.org/entity/Q577' },
        },
      },
      { statement: { property: 'wdt:P178', in: ['wd:Q123'] } },
    ],
  });

  expect(() =>
    buildReleaseSearchFilter(bundledRelease, releaseType, {
      producer: { role: 'publisher', subject: 'wd:Q123' },
    }),
  ).not.toThrow();
});

test('language alone uses the released release-level language facet', () => {
  expect(buildReleaseSearchFilter(bundledRelease, releaseType, { languages: ['en', 'ja'] })).toEqual({
    and: [{ type: { in: [releaseType] } }, { statement: { property: 'schema:inLanguage', in: ['en', 'ja'] } }],
  });
});
