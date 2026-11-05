import { expect, test } from 'bun:test';
import { bundledRelease } from '@rezics/definitions/bundled';
import type { FilterRelease } from '@rezics/filter';
import {
  admittedReleaseSearchControls,
  admittedReleaseSearchTypes,
  buildReleaseSearchFilter,
} from '../../src/search/release-search.ts';

const type = 'wd:Q20631656';
const subject = '018f0000-0000-7000-8000-000000000002';

test('controls and both independent credit operands use the inherited active-release admission', () => {
  const release: FilterRelease = structuredClone(bundledRelease);
  release.types['local:Release'] = { bases: [type], facets: [] };
  release.properties['wdt:P2899']!.units = ['local:years'];
  const controls = admittedReleaseSearchControls(release, 'local:Release')!;
  expect(admittedReleaseSearchTypes(release)).toContain('local:Release');
  expect(controls.platform?.languageQualifier).toBe('schema:inLanguage');
  expect(controls.language?.property).toBe('schema:inLanguage');
  expect(controls.date?.property).toBe('schema:datePublished');
  expect(controls.ageRating?.units).toEqual(['local:years']);
  expect(controls.producers).toEqual([
    { role: 'developer', property: 'wdt:P178' },
    { role: 'publisher', property: 'schema:publisher' },
  ]);
  expect(
    buildReleaseSearchFilter(release, 'local:Release', {
      developer: subject,
      publisher: subject,
      ageRating: { gte: 13, unit: 'local:years' },
    }),
  ).toEqual({
    and: [
      { type: { in: ['local:Release'] } },
      { statement: { property: 'wdt:P2899', range: { gte: 13, unit: 'local:years' } } },
      { statement: { property: 'wdt:P178', in: [subject] } },
      { statement: { property: 'schema:publisher', in: [subject] } },
    ],
  });
});

test('replacement withdraws controls and rejects unavailable operands without substituting properties', () => {
  const release: FilterRelease = structuredClone(bundledRelease);
  release.types[type]!.facets = release.types[type]!.facets!.filter((p) => p !== 'schema:publisher');
  release.properties['wdt:P178'] = { datatype: 'string', value: { pattern: '^.*$' } };
  release.properties['schema:gamePlatform']!.qualifiers = [];
  release.properties['wdt:P2899']!.units = [];
  const controls = admittedReleaseSearchControls(release, type)!;
  expect(controls.producers).toEqual([]);
  expect(controls.ageRating).toBeNull();
  expect(controls.platform?.languageQualifier).toBeNull();
  for (const criteria of [
    { developer: subject },
    { publisher: subject },
    { ageRating: { gte: 13, unit: 'http://www.wikidata.org/entity/Q577' } },
    { platform: subject, languages: ['ja'] },
    { producer: { role: 'producer' as never, subject } },
  ])
    expect(() => buildReleaseSearchFilter(release, type, criteria)).toThrow();
  // Release-level languages still work; no qualifier fallback changes a platform condition's meaning.
  expect(() => buildReleaseSearchFilter(release, type, { languages: ['ja'] })).not.toThrow();
  expect(admittedReleaseSearchControls(bundledRelease, type)!.producers).toHaveLength(2);
});

test('property presence alone never establishes a release subtype or a language control', () => {
  const release: FilterRelease = structuredClone(bundledRelease);
  release.types['local:Work'] = { facets: ['schema:gamePlatform'] };
  expect(admittedReleaseSearchTypes(release)).not.toContain('local:Work');
  expect(admittedReleaseSearchControls(release, 'local:Missing')).toBeNull();
  delete release.properties['schema:inLanguage'];
  expect(admittedReleaseSearchControls(release, type)!.language).toBeNull();
  expect(admittedReleaseSearchControls(release, type)!.platform?.languageQualifier).toBeNull();
  delete release.properties['schema:exampleOfWork'];
  expect(admittedReleaseSearchControls(release, type)).toBeNull();
  expect(() => buildReleaseSearchFilter(release, type, {})).toThrow();
});
