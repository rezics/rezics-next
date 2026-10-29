import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { validateRelease, publicationLimits, PUBLICATION_LIMITS } from '../src/index.ts';
import { constructionFixture } from './support/publication-construction.ts';

// Execute the unchanged implementation in an isolated module graph. No installed
// dependency, submitted array or released schema is patched.
export async function originalValidator() {
  const root = resolve(import.meta.dir, '../../..');
  const temporary = join(root, '.temp/publication-construction');
  mkdirSync(temporary, { recursive: true });
  const directory = mkdtempSync(join(temporary, 'oracle-'));
  function source(path: string) {
    const result = Bun.spawnSync(['git', 'show', `2c86ce30ef:${path}`], { cwd: root });
    if (result.exitCode) throw new Error(result.stderr.toString());
    return result.stdout.toString().replace(/from (['"])([^'"]+)\1/g, (match, quote: string, specifier: string) => {
      if (specifier.startsWith('node:')) return match;
      const target = specifier.startsWith('.') ? resolve(root, dirname(path), specifier) : Bun.resolveSync(specifier, resolve(root, dirname(path)));
      return `from ${quote}${target}${quote}`;
    });
  }
  const filter = join(directory, 'filter.ts');
  const definitions = join(directory, 'definitions.ts');
  writeFileSync(filter, source('packages/filter/src/filter.ts'));
  writeFileSync(definitions, source('packages/definitions/src/index.ts').replace(
    Bun.resolveSync('@rezics/filter', resolve(root, 'packages/definitions/src')), filter));
  const original = await import(definitions) as { validateRelease: typeof validateRelease };
  return { validate: original.validateRelease, close: () => rmSync(directory, { recursive: true, force: true }) };
}

test('every uniqueItems site preserves malformed JSON members, child indices, escaped pointers, error precedence and 64 cap', async () => {
  const oracle = await originalValidator();
  try {
    const schema = JSON.parse(readFileSync(new URL('../schema/release.json', import.meta.url), 'utf8'));
    let sites = 0;
    function count(value: any) {
      if (!value || typeof value !== 'object') return;
      if (value.uniqueItems === true) sites++;
      for (const child of Object.values(value)) count(child);
    }
    count(schema);
    expect(sites).toBe(6);
    const members = [
      ['schema:Thing', 'schema:Thing'], [null, null], [true, true],
      [0, -0, 0], [1, 1.0], [{ b: 2, a: 1 }, { a: 1, b: 2 }],
      [[1, { x: 'é' }], [1, { x: 'é' }]], ['é', 'é'],
    ];
    for (const items of members) for (const site of ['bases', 'mappings', 'properties', 'facets', 'qualifiers', 'targets', 'units', 'filter', 'recordKinds']) {
      const release: any = constructionFixture();
      release.types['grow:a~/b'] = structuredClone(release.types['grow:Root']);
      const property = release.properties['grow:code'];
      if (['bases', 'mappings', 'properties', 'facets'].includes(site)) release.types['grow:a~/b'][site] = items;
      else if (site === 'filter') property.relation = { group: 'association', inverse: 'none', filter: items };
      else if (site === 'recordKinds') release.libraryProfiles = { test: { id: 'test', importSources: [{ id: 'test', mappingVersion: 'test', recordKinds: items }] } };
      else property[site] = items;
      expect(validateRelease(release), `${site}: ${JSON.stringify(items)}`).toEqual(oracle.validate(release));
    }
    const crowded: any = constructionFixture();
    for (let index = 0; index < 90; index++) crowded.types[`grow:a~/${String(index).padStart(3,'0')}`] = {
      ...structuredClone(crowded.types['grow:Root']), bases: [null, null, { a: 1 }, { a: 1 }],
    };
    expect(validateRelease(crowded)).toEqual(oracle.validate(crowded));
    expect(validateRelease(crowded)).toHaveLength(64);
    const cheap = constructionFixture();
    cheap.types['grow:Root']!.properties = Array(65).fill('grow:code');
    cheap.properties['grow:code']!.value = { type: 'string', pattern: '^(a+)+$' };
    expect(validateRelease(cheap)).toEqual(oracle.validate(cheap));
  } finally { oracle.close(); }
});

test('new caps are intentional admission differences while historical validation keeps its meaning', async () => {
  const oracle = await originalValidator();
  try {
    const historical = constructionFixture(4097, 4096);
    historical.types['grow:Root']!.mappings = Array.from({length:257}, (_, i) => `grow:M${String(i).padStart(4,'0')}`);
    expect(oracle.validate(historical)).toEqual([]);
    expect(validateRelease(historical)).toEqual([]);
    expect(publicationLimits(historical)).toEqual([
      { pointer: '/types/grow:Root/bases', code: 'limit' },
      { pointer: '/types/grow:Root/mappings', code: 'limit' },
    ]);
    expect(PUBLICATION_LIMITS).toEqual({ bases: 4096, mappings: 256, qualifiers: 4096 });
    for (const member of ['bases','mappings','qualifiers'] as const) {
      const release = constructionFixture();
      const definition = member === 'qualifiers' ? release.properties['grow:code']! : release.types['grow:Root']!;
      (definition as any)[member] = Array(PUBLICATION_LIMITS[member]).fill('schema:Thing');
      expect(publicationLimits(release)).toEqual([]);
      (definition as any)[member].push('schema:Thing');
      expect(publicationLimits(release)).toHaveLength(1);
    }
  } finally { oracle.close(); }
});

test('JSON admission refuses accessors, inherited data and sparse arrays without executing user code', () => {
  let reads = 0;
  const getter = constructionFixture();
  Object.defineProperty(getter, 'types', { enumerable: true, get() { reads++; throw new Error('getter'); } });
  expect(validateRelease(getter)).toEqual([{ pointer: '', code: 'invalid' }]);
  expect(reads).toBe(0);
  const inherited = constructionFixture();
  Object.setPrototypeOf(inherited.types, { hidden: inherited.types['grow:Root'] });
  expect(validateRelease(inherited)).toEqual([{ pointer: '', code: 'invalid' }]);
  const sparse = constructionFixture();
  sparse.types['grow:Root']!.bases = new Array(3);
  expect(validateRelease(sparse)).toEqual([{ pointer: '', code: 'invalid' }]);
});
