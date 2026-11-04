import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import canonicalize from 'canonicalize';
import { bundledRelease, bundledSources } from '../src/bundled.ts';
import { compileCatalogue } from '../src/compile.ts';
import { RELEASE_LIMITS, validateRelease } from '../src/index.ts';
import { sourcesFor } from './support/library-profiles.ts';

const locales = ['de', 'en', 'es', 'fr', 'ja', 'ko', 'zh-Hans', 'zh-Hant'];

test('release replacement is directed, exact-release scoped, and separate from chronology and organizations', () => {
  const release = bundledRelease;
  const current = release.properties['rezics:releaseSupersedes']!;
  expect(release.types['wd:Q20631656']!.properties).toContain('rezics:releaseSupersedes');
  expect(current).toMatchObject({
    datatype: 'wikibase-item',
    multivalued: true,
    targets: ['wd:Q20631656'],
    relation: {
      group: 'order',
      inverse: 'rezics:releaseSupersededBy',
      acyclic: true,
    },
    qualifiers: ['schema:sameAs'],
  });
  expect(current.mappings ?? []).toEqual([]);
  expect(release.properties['wdt:P155']).toMatchObject({
    targets: ['schema:CreativeWork', 'wd:Q20631656'],
    relation: { inverse: 'wdt:P156' },
  });
  expect(release.properties['wdt:P1365']!.targets).toEqual(['schema:Organization']);
  expect(release.properties['wdt:P1366']!.targets).toEqual(['schema:Organization']);
  for (const locale of locales) {
    expect(current.labels[locale]?.trim().length).toBeGreaterThan(0);
    expect(current.relation!.inverseLabels![locale]?.trim().length).toBeGreaterThan(0);
  }
});

test('VNDB source row keeps id as the superseding release and maps rid to the exact target', () => {
  const inventory = Bun.YAML.parse(readFileSync(new URL('../sources/vndb.yaml', import.meta.url), 'utf8')) as {
    table_types: Record<string, { meaning?: string }>;
    tables: {
      name: string;
      type: string;
      columns: { name: string; status: string; reason?: string; term?: string; on?: string; mapping?: string }[];
    }[];
  };
  const table = inventory.tables.find((item) => item.name === 'releases_supersedes')!;
  expect(table.type).toBe('rezics:releaseSupersedes');
  expect(table.columns.find((column) => column.name === 'id')).toMatchObject({
    status: 'omitted',
    reason: expect.stringContaining('Superseding Release'),
  });
  expect(table.columns.find((column) => column.name === 'rid')).toMatchObject({
    status: 'existing',
    term: 'rezics:releaseSupersedes',
    on: 'wd:Q20631656',
    mapping: 'rezics:releaseSupersedes',
  });
  expect(inventory.table_types['rezics:releaseSupersedes']!.meaning).toContain('current release id supersedes');
  expect(inventory.table_types['wdt:P155']!.meaning).toContain('does not mean replacement');
});

test('the released release descriptor stays within limits through ten and one hundred manifest expansions', async () => {
  expect(validateRelease(bundledRelease)).toEqual([]);
  for (const count of [10, 100]) {
    const expanded = await compileCatalogue(sourcesFor(count, false));
    expect(validateRelease(expanded)).toEqual([]);
    expect(expanded.types['wd:Q20631656']!.properties).toContain('rezics:releaseSupersedes');
    expect(expanded.properties['rezics:releaseSupersedes']).toEqual(
      bundledRelease.properties['rezics:releaseSupersedes'],
    );
    expect(Buffer.byteLength(canonicalize(expanded)!)).toBeLessThanOrEqual(RELEASE_LIMITS.bytes);
  }
  expect((await compileCatalogue(bundledSources())).properties['rezics:releaseSupersedes']).toEqual(
    bundledRelease.properties['rezics:releaseSupersedes'],
  );
}, 120_000);
