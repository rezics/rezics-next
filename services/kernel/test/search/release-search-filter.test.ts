import { expect, test } from 'bun:test';
import { bundledRelease } from '@rezics/definitions/bundled';
import {
  admittedReleaseProducerRoles,
  buildReleaseSearchFilter,
} from '../../src/search/release-search.ts';

const releaseType = 'wd:Q20631656';
const platformId = '018f0000-0000-7000-8000-000000000001';
const subjectId = '018f0000-0000-7000-8000-000000000002';

test('release filters keep platform languages attached and preserve calendar precision', () => {
  const filter = buildReleaseSearchFilter(bundledRelease, releaseType, {
    platform: platformId,
    languages: ['en', 'ja', 'en'],
    date: { type: 'time', gte: '2024-02-29', lte: '2024-03' },
  });

  expect(filter).toEqual({
    and: [
      { type: { in: [releaseType] } },
      {
        statement: {
          property: 'schema:gamePlatform',
          in: [platformId],
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
      producer: { role: 'developer', subject: subjectId },
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
      { statement: { property: 'wdt:P178', in: [subjectId] } },
    ],
  });

  expect(() =>
    buildReleaseSearchFilter(bundledRelease, releaseType, {
      producer: { role: 'publisher', subject: subjectId },
    }),
  ).not.toThrow();
});

test('language alone uses the released release-level language facet', () => {
  expect(buildReleaseSearchFilter(bundledRelease, releaseType, { languages: ['en', 'ja'] })).toEqual({
    and: [{ type: { in: [releaseType] } }, { statement: { property: 'schema:inLanguage', in: ['en', 'ja'] } }],
  });
});

test('producer controls expose only exact properties admitted by the active subtype', () => {
  const release = structuredClone(bundledRelease);
  release.types[releaseType]!.facets = release.types[releaseType]!.facets.filter(
    (property) => property !== 'schema:publisher',
  );
  expect(admittedReleaseProducerRoles(release, releaseType)).toEqual(['developer']);
});
