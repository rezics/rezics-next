import { afterAll, beforeAll, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { Compile } from 'typebox/schema';
import { validateRelease, publicationLimits, PUBLICATION_LIMITS } from '../src/index.ts';
import { constructionFixture } from './support/publication-construction.ts';
import { originalValidator } from './support/historical-construction.ts';

// Both callers execute the same tracked original core without runtime Git.
export { originalValidator } from './support/historical-construction.ts';

// Source integrity and module compilation are shared; validation outputs are never cached.
let matrixOracle: Awaited<ReturnType<typeof originalValidator>>;
beforeAll(async () => {
  matrixOracle = await originalValidator();
});
afterAll(() => matrixOracle?.close());

const memberCases: [string, unknown[]][] = [
  ['curie', ['schema:Thing', 'schema:Thing']],
  ['null', [null, null]],
  ['boolean', [true, true]],
  ['signed-zero', [0, -0, 0]],
  ['equal-numbers', [1, 1.0]],
  [
    'reordered-object',
    [
      { b: 2, a: 1 },
      { a: 1, b: 2 },
    ],
  ],
  [
    'nested-array',
    [
      [1, { x: 'é' }],
      [1, { x: 'é' }],
    ],
  ],
  ['unicode', ['é', 'é']],
];
const uniquenessSites = [
  'bases',
  'mappings',
  'properties',
  'facets',
  'qualifiers',
  'targets',
  'units',
  'filter',
  'recordKinds',
];
const matrix = uniquenessSites.flatMap((site) => memberCases.map(([name, items]) => [site, name, items] as const));

test('historical uniqueness coverage retains six schema keywords and all 72 site/member comparisons', () => {
  const schema = JSON.parse(readFileSync(new URL('../schema/release.json', import.meta.url), 'utf8'));
  let sites = 0;
  function count(value: any) {
    if (!value || typeof value !== 'object') return;
    if (value.uniqueItems === true) sites++;
    for (const child of Object.values(value)) count(child);
  }
  count(schema);
  expect(sites).toBe(6);
  expect(uniquenessSites).toHaveLength(9);
  expect(memberCases).toHaveLength(8);
  expect(matrix).toHaveLength(72);
  expect(new Set(matrix.map(([site, name]) => `${site}/${name}`)).size).toBe(72);
});

test.each(matrix)(
  'historical uniqueness %s / %s preserves exact malformed-member and escaped/child-pointer diagnostics',
  (site, _name, members) => {
    const items = structuredClone(members);
    const release: any = constructionFixture();
    release.types['grow:a~/b'] = structuredClone(release.types['grow:Root']);
    const property = release.properties['grow:code'];
    if (['bases', 'mappings', 'properties', 'facets'].includes(site)) release.types['grow:a~/b'][site] = items;
    else if (site === 'filter') property.relation = { group: 'association', inverse: 'none', filter: items };
    else if (site === 'recordKinds')
      release.libraryProfiles = {
        test: { id: 'test', importSources: [{ id: 'test', mappingVersion: 'test', recordKinds: items }] },
      };
    else property[site] = items;
    expect(validateRelease(release), `${site}: ${JSON.stringify(items)}`).toEqual(matrixOracle.validate(release));
  },
);

test('crowded malformed children preserve the pinned eight-node diagnostic budget and exact pointer/code order', () => {
  const crowded: any = constructionFixture();
  for (let index = 0; index < 90; index++)
    crowded.types[`grow:a~/${String(index).padStart(3, '0')}`] = {
      ...structuredClone(crowded.types['grow:Root']),
      bases: [null, null, { a: 1 }, { a: 1 }],
    };
  expect(validateRelease(crowded)).toEqual(matrixOracle.validate(crowded));
  expect(matrixOracle.validate(crowded)).toHaveLength(8);
  expect(validateRelease(crowded)).toHaveLength(8);
});

test('cheap collection limits preserve original precedence over uniqueness and unsafe patterns', () => {
  const cheap = constructionFixture();
  cheap.types['grow:Root']!.properties = Array(65).fill('grow:code');
  cheap.properties['grow:code']!.value = { type: 'string', pattern: '^(a+)+$' };
  expect(validateRelease(cheap)).toEqual(matrixOracle.validate(cheap));
});

test('schema-valid semantic faults retain the outer 64-result cap and exact escaped pointer/code order', async () => {
  const oracle = await originalValidator();
  try {
    const release = constructionFixture();
    for (let index = 0; index < 90; index++)
      release.types[`grow:a~/${String(index).padStart(3, '0')}`] = structuredClone(release.types['grow:Root']!);
    const schema = JSON.parse(readFileSync(new URL('../schema/release.json', import.meta.url), 'utf8'));
    expect(Compile(schema).Check(release)).toBe(true);
    const expected = Array.from({ length: 64 }, (_, index) => ({
      pointer: `/types/grow:a~0~1${String(index).padStart(3, '0')}/iri`,
      code: 'invalid',
    }));
    const original = oracle.validate(release);
    const delivered = validateRelease(release);
    expect(original).toHaveLength(64);
    expect(delivered).toHaveLength(64);
    expect(original).toEqual(expected);
    expect(delivered).toEqual(original);
  } finally {
    oracle.close();
  }
});

test('new caps are intentional admission differences while historical validation keeps its meaning', async () => {
  const oracle = await originalValidator();
  try {
    const historical = constructionFixture(4097, 4096);
    historical.types['grow:Root']!.mappings = Array.from(
      { length: 257 },
      (_, i) => `grow:M${String(i).padStart(4, '0')}`,
    );
    expect(oracle.validate(historical)).toEqual([]);
    expect(validateRelease(historical)).toEqual([]);
    expect(publicationLimits(historical)).toEqual([
      { pointer: '/types/grow:Root/bases', code: 'limit' },
      { pointer: '/types/grow:Root/mappings', code: 'limit' },
    ]);
    expect(PUBLICATION_LIMITS).toEqual({ bases: 4096, mappings: 256, qualifiers: 4096 });
    for (const member of ['bases', 'mappings', 'qualifiers'] as const) {
      const release = constructionFixture();
      const definition = member === 'qualifiers' ? release.properties['grow:code']! : release.types['grow:Root']!;
      (definition as any)[member] = Array(PUBLICATION_LIMITS[member]).fill('schema:Thing');
      expect(publicationLimits(release)).toEqual([]);
      (definition as any)[member].push('schema:Thing');
      expect(publicationLimits(release)).toHaveLength(1);
    }
  } finally {
    oracle.close();
  }
});

test('JSON admission refuses accessors, inherited data and sparse arrays without executing user code', () => {
  let reads = 0;
  const getter = constructionFixture();
  Object.defineProperty(getter, 'types', {
    enumerable: true,
    get() {
      reads++;
      throw new Error('getter');
    },
  });
  expect(validateRelease(getter)).toEqual([{ pointer: '', code: 'invalid' }]);
  expect(reads).toBe(0);
  const inherited = constructionFixture();
  Object.setPrototypeOf(inherited.types, { hidden: inherited.types['grow:Root'] });
  expect(validateRelease(inherited)).toEqual([{ pointer: '', code: 'invalid' }]);
  const sparse = constructionFixture();
  sparse.types['grow:Root']!.bases = new Array(3);
  expect(validateRelease(sparse)).toEqual([{ pointer: '', code: 'invalid' }]);
});
