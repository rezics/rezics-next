import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { bundledSources } from '../src/bundled.ts';
import { CatalogueError, compileCatalogue, type CatalogueViolation } from '../src/compile.ts';
import { validateRelease, type SavedFilter } from '../src/index.ts';

const prefixes = {
  linkml: 'https://w3id.org/linkml/',
  schema: 'http://schema.org/',
  skos: 'http://www.w3.org/2004/02/skos/core#',
  wdt: 'http://www.wikidata.org/prop/direct/',
};
const thing = { type: { in: ['schema:Thing'] } };
const recent = {
  and: [thing, { statement: { property: 'schema:datePublished', range: { gte: 1990, lte: 1999 } } }],
};
const brief = { statement: { property: 'schema:numberOfPages', range: { lte: 200, unit: '1' } } };
const genreSubject = '018f0000-0000-7000-8000-00a00000000b';
const roleSubject = '018f0000-0000-7000-8000-00a00000000c';
const named = {
  statement: {
    property: 'schema:genre',
    in: [genreSubject],
    qualifiers: [{ property: 'wdt:P3831', in: [roleSubject] }],
  },
};
const nested = { and: [thing, { saved: 'books/recent' }] };
const deep = { and: [{ or: [{ and: [{ or: [{ not: thing }, thing] }] }, thing] }] };
const at = (pointer: string, key: string | number) =>
  `${pointer}/${String(key).replace(/~/g, '~0').replace(/\//g, '~1')}`;
const filterAt = (key: string, suffix = '') => `${at('/filters', key)}/filter${suffix}`;

function catalogue() {
  return {
    root: 'fixture.yaml',
    schemas: {
      'fixture.yaml': JSON.stringify({
        id: 'https://rezics.com/catalogue/fixture',
        name: 'fixture',
        version: '1.0.0',
        prefixes,
        default_range: 'string',
        imports: ['linkml:types'],
        classes: {
          Thing: {
            class_uri: 'schema:Thing',
            slots: ['published', 'pages', 'genre'],
            annotations: { facets: 'published pages genre' },
          },
          Concept: { class_uri: 'skos:Concept' },
        },
        slots: {
          published: { slot_uri: 'schema:datePublished', range: 'date', annotations: { datatype: 'time' } },
          pages: {
            slot_uri: 'schema:numberOfPages',
            range: 'integer',
            annotations: { datatype: 'quantity', units: '1' },
          },
          genre: {
            slot_uri: 'schema:genre',
            range: 'Concept',
            annotations: { datatype: 'wikibase-item', qualifiers: 'role' },
          },
          role: { slot_uri: 'wdt:P3831', range: 'Concept', annotations: { datatype: 'wikibase-item' } },
        },
      }),
    },
    presentation: {
      en: JSON.stringify({
        types: { 'schema:Thing': 'thing', 'skos:Concept': 'concept' },
        properties: {
          'schema:datePublished': 'date published',
          'schema:numberOfPages': 'number of pages',
          'schema:genre': 'genre',
          'wdt:P3831': 'role',
        },
      }),
    },
  };
}

const saved = (entries: Record<string, { labels: Record<string, string>; filter: unknown }>) => JSON.stringify(entries);
const entry = (filter: unknown, labels: Record<string, string> = { en: 'Filter' }): SavedFilter => ({
  labels,
  filter: filter as SavedFilter['filter'],
});

function packed(count: number, perGroup = 64): Record<string, string> {
  const groups: Record<string, string> = {};
  for (let index = 0, remaining = count; remaining > 0; index += 1) {
    const size = Math.min(perGroup, remaining);
    groups[`g${String(index).padStart(2, '0')}`] = saved(
      Object.fromEntries(
        Array.from({ length: size }, (_, slug) => [`s${String(slug).padStart(2, '0')}`, entry(thing)]),
      ),
    );
    remaining -= size;
  }
  return groups;
}

async function violations(filters: Record<string, string>) {
  try {
    await compileCatalogue({ ...catalogue(), filters });
  } catch (error) {
    expect(error).toBeInstanceOf(CatalogueError);
    return (error as CatalogueError).violations.map(({ file, pointer, code }) => ({ file, pointer, code }));
  }
  throw new Error('Expected saved filters to fail compilation');
}

const byLocation = (left: { file: string; pointer: string }, right: { file: string; pointer: string }) =>
  left.file < right.file
    ? -1
    : left.file > right.file
      ? 1
      : left.pointer < right.pointer
        ? -1
        : left.pointer > right.pointer
          ? 1
          : 0;

test('saved filter files compile into the release keyed by group and slug', async () => {
  const base = catalogue();
  const release = await compileCatalogue({
    ...base,
    filters: {
      works: saved({ brief: entry(brief, { en: 'Brief' }) }),
      a: saved({ z: entry(thing, { en: 'Late' }) }),
      'a-b': saved({ a: entry(thing, { en: 'Hyphen' }) }),
      books: saved({
        recent: entry(recent, { en: 'Recent' }),
        classic: entry(thing, { ja: '古典', en: 'Classic' }),
      }),
    },
  });
  expect(release.types['schema:Thing']!.facets).toEqual([
    'schema:datePublished',
    'schema:numberOfPages',
    'schema:genre',
  ]);
  expect(Object.keys(release.filters ?? {})).toEqual(['a-b/a', 'a/z', 'books/classic', 'books/recent', 'works/brief']);
  expect(release.filters?.['books/recent']).toEqual({ labels: { en: 'Recent' }, filter: recent });
  expect(release.filters?.['books/classic']).toEqual({ labels: { en: 'Classic', ja: '古典' }, filter: thing });
  expect(Object.keys(release.filters?.['books/classic']?.labels ?? {})).toEqual(['en', 'ja']);
  expect(release.filters?.['works/brief']).toEqual({ labels: { en: 'Brief' }, filter: brief });
  expect(release.filters?.['a-b/a']).toEqual({ labels: { en: 'Hyphen' }, filter: thing });
  expect(release.filters?.['a/z']).toEqual({ labels: { en: 'Late' }, filter: thing });
  const plain = await compileCatalogue(base);
  expect(plain.filters).toBeUndefined();
  expect(Object.hasOwn(plain, 'filters')).toBe(false);
  expect(JSON.stringify(await compileCatalogue({ ...base, filters: {} }))).toBe(JSON.stringify(plain));
  expect(validateRelease(release)).toEqual([]);
  expect(validateRelease(plain)).toEqual([]);
}, 20_000);

test('a saved filter that fails filter validation, names a subject or nests a saved filter is refused at compilation and by validateRelease', async () => {
  const release = await compileCatalogue({
    ...catalogue(),
    filters: { books: saved({ recent: entry(recent, { en: 'Recent' }) }) },
  });
  const unknown = structuredClone(release);
  unknown.filters!['books/missing'] = entry({ type: { in: ['schema:Missing'] } }, { en: 'Missing' });
  expect(validateRelease(unknown)).toEqual([{ pointer: filterAt('books/missing', '/type/in/0'), code: 'invalid' }]);
  const broken = structuredClone(release);
  broken.filters!['books/broken'] = entry({ colour: 'red' }, { en: 'Broken' });
  expect(validateRelease(broken)).toEqual([{ pointer: filterAt('books/broken', '/colour'), code: 'invalid' }]);
  const limited = structuredClone(release);
  limited.filters!['books/deep'] = entry(deep, { en: 'Deep' });
  expect(validateRelease(limited)).toEqual([
    { pointer: filterAt('books/deep', '/and/0/or/0/and/0/or/0'), code: 'limit' },
  ]);
  const subject = structuredClone(release);
  subject.filters!['books/named'] = entry(named, { en: 'Named' });
  expect(validateRelease(subject)).toEqual([
    { pointer: filterAt('books/named', '/statement/in/0'), code: 'invalid' },
    { pointer: filterAt('books/named', '/statement/qualifiers/0/in/0'), code: 'invalid' },
  ]);
  const savedLeaf = structuredClone(release);
  savedLeaf.filters!['books/nested'] = entry(nested, { en: 'Nested' });
  expect(validateRelease(savedLeaf)).toEqual([{ pointer: filterAt('books/nested', '/and/1/saved'), code: 'invalid' }]);
  const unlabelled = structuredClone(release);
  delete unlabelled.filters!['books/recent']!.labels.en;
  expect(validateRelease(unlabelled)).toEqual([
    { pointer: `${at('/filters', 'books/recent')}/labels/en`, code: 'invalid' },
  ]);
  const badKey = structuredClone(release);
  badKey.filters!['Books/Recent'] = entry(thing, { en: 'Recent' });
  expect(validateRelease(badKey)).toEqual([{ pointer: at('/filters', 'Books/Recent'), code: 'invalid' }]);

  const crowded = structuredClone(release);
  crowded.filters = Object.fromEntries(
    Array.from({ length: 65 }, (_, index) => [`books/f${String(index).padStart(2, '0')}`, entry(thing)]),
  );
  expect(validateRelease(crowded)).toEqual([{ pointer: '/filters/books', code: 'limit' }]);
  const allowedGroup = structuredClone(release);
  allowedGroup.filters = Object.fromEntries(
    Array.from({ length: 64 }, (_, index) => [`books/f${String(index).padStart(2, '0')}`, entry(thing)]),
  );
  expect(validateRelease(allowedGroup)).toEqual([]);
  const tooMany = structuredClone(release);
  tooMany.filters = Object.fromEntries(
    Array.from({ length: 1025 }, (_, index) => [`g${String(index).padStart(4, '0')}/only`, entry(thing)]),
  );
  expect(validateRelease(tooMany)).toEqual([{ pointer: '/filters', code: 'limit' }]);
  const allowedRelease = structuredClone(release);
  allowedRelease.filters = Object.fromEntries(
    Array.from({ length: 1024 }, (_, index) => [`g${String(index).padStart(4, '0')}/only`, entry(thing)]),
  );
  expect(validateRelease(allowedRelease)).toEqual([]);

  const found = await violations({
    Books: saved({ recent: entry(thing, { en: 'Recent' }) }),
    books: saved({
      Recent: entry(thing, { en: 'Recent' }),
      broken: entry({ colour: 'red' }, { en: 'Broken' }),
      deep: entry(deep, { en: 'Deep' }),
      extra: { ...entry(thing, { en: 'Extra' }), note: true } as { labels: Record<string, string>; filter: unknown },
      missing: entry({ type: { in: ['schema:Missing'] } }, { en: 'Missing' }),
      named: entry(named, { en: 'Named' }),
      nested: entry(nested, { en: 'Nested' }),
      unlabelled: entry(thing, { ja: '無名' }),
    }),
  });
  const expected: Pick<CatalogueViolation, 'file' | 'pointer' | 'code'>[] = [
    { file: 'filters/Books', pointer: '/filters/Books', code: 'invalid' },
    { file: 'filters/books', pointer: at('/filters', 'books/Recent'), code: 'invalid' },
    { file: 'filters/books', pointer: filterAt('books/broken', '/colour'), code: 'invalid' },
    { file: 'filters/books', pointer: filterAt('books/deep', '/and/0/or/0/and/0/or/0'), code: 'limit' },
    { file: 'filters/books', pointer: `${at('/filters', 'books/extra')}/note`, code: 'unsupported' },
    { file: 'filters/books', pointer: filterAt('books/missing', '/type/in/0'), code: 'invalid' },
    { file: 'filters/books', pointer: filterAt('books/named', '/statement/in/0'), code: 'invalid' },
    { file: 'filters/books', pointer: filterAt('books/named', '/statement/qualifiers/0/in/0'), code: 'invalid' },
    { file: 'filters/books', pointer: filterAt('books/nested', '/and/1/saved'), code: 'invalid' },
    { file: 'filters/books', pointer: `${at('/filters', 'books/unlabelled')}/labels/en`, code: 'missing_label' },
  ];
  expect(found).toEqual(expected.sort(byLocation));

  const boundary = await compileCatalogue({
    ...catalogue(),
    filters: {
      books: saved(
        Object.fromEntries(
          Array.from({ length: 64 }, (_, index) => [`f${String(index).padStart(2, '0')}`, entry(thing)]),
        ),
      ),
    },
  });
  expect(Object.keys(boundary.filters ?? {})).toHaveLength(64);
  expect(validateRelease(boundary)).toEqual([]);
  expect(
    await violations({
      books: saved(
        Object.fromEntries(
          Array.from({ length: 65 }, (_, index) => [`f${String(index).padStart(2, '0')}`, entry(thing)]),
        ),
      ),
    }),
  ).toEqual([{ file: 'filters/books', pointer: '/filters/books', code: 'limit' }]);
  const full = await compileCatalogue({ ...catalogue(), filters: packed(1024) });
  expect(Object.keys(full.filters ?? {})).toHaveLength(1024);
  expect(validateRelease(full)).toEqual([]);
  expect(await violations(packed(1025))).toEqual([{ file: 'filters', pointer: '/filters', code: 'limit' }]);
}, 20_000);

test('every filters file is bundled with no code edit', () => {
  const sources = bundledSources();
  const directory = new URL('../filters/', import.meta.url);
  let names: string[] = [];
  try {
    names = readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.yaml'))
      .map((entry) => entry.name.replace(/\.yaml$/u, ''))
      .sort();
  } catch (error) {
    if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  expect(Object.keys(sources.filters).sort()).toEqual(names);
  for (const name of names)
    expect(sources.filters[name]).toBe(readFileSync(new URL(`${name}.yaml`, directory), 'utf8'));
  expect(Object.keys(sources.presentation).every((key) => !key.startsWith('filters'))).toBe(true);
});
