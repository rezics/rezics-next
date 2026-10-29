import { expect, test } from 'bun:test';
import { admitFilter, facetProperties, parseFilter, validateFilter } from '../src/filter.ts';
import { constructionEvidence, constructionFixture } from '../../definitions/test/support/publication-construction.ts';

for (const mode of ['release', 'filter'] as const)
  for (const invalid of [false, true]) {
    test(`${mode} ${invalid ? 'invalid' : 'valid'} saved filters must reuse type facets across independently grown bases and filters`, async () => {
      const report = await constructionEvidence();
      const excessive: unknown[] = [];
      const rows = report.rows.filter(
        (row) =>
          row.mode === mode && /^(bases|filters|returnable)-/.test(row.name) && row.name.includes(`-${invalid}-`),
      );
      expect(rows.length).toBe(12);
      for (const row of rows) {
        expect(row.instrumented, row.name).toEqual(row.original);
        // Each base edge is expanded once per owned release; per-filter/type set
        // probes are separate work. Count actual copy reads AND actual expansions.
        const allowance = 8 * (row.axes.bases! + row.axes.filters! * (row.axes.returnable ?? 1));
        if (row.counts.baseReads + row.counts.baseVisits > allowance)
          excessive.push({ name: row.name, counts: row.counts, allowance });
      }
      expect(excessive, 'once-per-release one-level facet construction is missing').toEqual([]);
    }, 240_000);

    test(`${mode} ${invalid ? 'invalid' : 'valid'} qualifier membership must reuse sets across declarations leaves qualifiers and saved populations`, async () => {
      const report = await constructionEvidence();
      const excessive: unknown[] = [];
      const rows = report.rows.filter(
        (row) =>
          row.mode === mode &&
          /^(qualifiers|qualifier-filters|leaves|statement-qualifiers)-/.test(row.name) &&
          row.name.includes(`-${invalid}-`),
      );
      expect(rows.length).toBe(15);
      for (const row of rows) {
        expect(row.instrumented, row.name).toEqual(row.original);
        const references = row.axes.filters! * row.axes.leaves! * row.axes.qualifiers!;
        const allowance = 8 * (row.axes.declarations! + references);
        if (row.counts.qualifierVisits > allowance) excessive.push({ name: row.name, counts: row.counts, allowance });
      }
      expect(excessive, 'declared qualifier sets must replace actual repeated own-data list scans').toEqual([]);
    }, 240_000);
  }

test('ordinary Filter outcomes keep stable one-level order own-data access and mutable-input freshness', () => {
  const release = constructionFixture(64, 64);
  const filter = Object.entries(release.filters!).find(([key]) => key.startsWith('construction'))![1].filter;
  const parsed = parseFilter(filter);
  expect(admitFilter(parsed, release, { saved: false })).toEqual(parsed);
  expect(validateFilter(filter, release, { saved: false })).toEqual([]);
  expect(facetProperties(release, ['grow:Root'])).toEqual(['grow:code']);
  release.types['grow:Base'] = {
    ...structuredClone(release.types['grow:Root']!),
    iri: 'https://construction.example/Base',
    bases: ['grow:Deep'],
    facets: ['schema:datePublished'],
  };
  release.types['grow:Deep'] = {
    ...structuredClone(release.types['grow:Root']!),
    iri: 'https://construction.example/Deep',
    bases: [],
    facets: ['schema:genre'],
  };
  release.types['grow:Root']!.bases = ['grow:Base'];
  expect(facetProperties(release, ['grow:Root', 'grow:Base'])).toEqual([
    'grow:code',
    'schema:datePublished',
    'schema:genre',
  ]);
  expect(facetProperties(release, ['grow:Root'])).toEqual(['grow:code', 'schema:datePublished']);
  release.types['grow:Root']!.facets = [];
  release.types['grow:Root']!.bases = [];
  expect(validateFilter(filter, release, { saved: false })).toEqual([
    { problem: 'unsupported_query', pointer: '/and/1/statement/property', code: 'unsupported' },
  ]);
  let reads = 0;
  Object.defineProperty(release.types['grow:Root'], 'facets', {
    configurable: true,
    get() {
      reads++;
      return ['grow:code'];
    },
  });
  expect(facetProperties(release, ['grow:Root'])).toEqual([]);
  expect(reads).toBe(0);
});

test('raw mutable FilterRelease calls refresh patterns qualifiers typed facets and the untyped facet union', () => {
  const release = constructionFixture(0, 8);
  const qualifier = 'grow:code';
  const withQualifier = {
    statement: {
      property: 'grow:code',
      in: ['A'],
      qualifiers: [{ property: qualifier, in: ['x'] }],
    },
  } as const;
  expect(validateFilter(withQualifier, release, { saved: false })).toEqual([]);

  // The same property object is edited between raw calls. Pattern and qualifier
  // indexes must follow its current own data on every call.
  (release.properties['grow:code']!.value as { pattern?: string }).pattern = '^B+$';
  expect(validateFilter(withQualifier, release, { saved: false })).toEqual([
    { problem: 'invalid_request', pointer: '/statement/in/0', code: 'invalid_format' },
  ]);
  (release.properties['grow:code']!.value as { pattern?: string }).pattern = '^[A-Z]+$';
  release.properties['grow:code']!.qualifiers = [];
  expect(validateFilter(withQualifier, release, { saved: false })).toEqual([
    { problem: 'unsupported_query', pointer: '/statement/qualifiers/0/property', code: 'unsupported' },
  ]);

  // Facets are direct only and raw display/admission observes edits to the same
  // type, its base and another type contributing to the untyped union.
  release.types['grow:Base'] = {
    ...structuredClone(release.types['grow:Root']!),
    iri: 'https://construction.example/Base',
    bases: [],
    facets: ['schema:genre'],
  };
  release.types['grow:Root']!.bases = ['grow:Base'];
  expect(facetProperties(release, ['grow:Root'])).toEqual(['grow:code', 'schema:genre']);
  const untyped = { statement: { property: 'schema:genre', range: { gte: 1 } } } as const;
  expect(validateFilter(untyped, release, { saved: false })).toEqual([]);
  release.types['grow:Base']!.facets = [];
  expect(facetProperties(release, ['grow:Root'])).toEqual(['grow:code']);
  expect(validateFilter(untyped, release, { saved: false })).toEqual([
    { problem: 'unsupported_query', pointer: '/statement/property', code: 'unsupported' },
  ]);
});

test('raw Filter construction ignores inherited, accessor-backed and sparse definition lists', () => {
  let reads = 0;
  const release = constructionFixture();
  const rootType = release.types['grow:Root']!;
  Object.defineProperty(rootType, 'facets', {
    configurable: true,
    get() {
      reads++;
      return ['grow:code'];
    },
  });
  expect(facetProperties(release, ['grow:Root'])).toEqual([]);
  expect(reads).toBe(0);

  Object.defineProperty(rootType, 'facets', {
    configurable: true,
    value: Object.assign(Object.create({ inherited: 'grow:code' }), { own: 'schema:genre' }),
  });
  expect(facetProperties(release, ['grow:Root'])).toEqual([]);

  const sparse = new Array<string>(1);
  Object.defineProperty(rootType, 'facets', { configurable: true, value: sparse });
  expect(facetProperties(release, ['grow:Root'])).toEqual([]);
  expect(reads).toBe(0);
});
