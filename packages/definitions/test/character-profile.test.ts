import { readFileSync } from 'node:fs';
import { expect, test } from 'bun:test';
import { bundledRelease, bundledSources } from '../src/bundled.ts';

const locales = ['de', 'en', 'es', 'fr', 'ja', 'ko', 'zh-Hans', 'zh-Hant'];
const character = 'wd:Q95074';
const works = ['schema:TVSeries', 'schema:VideoGame', 'wd:Q689445'];
const characterProperties = [
  'schema:abstract',
  'schema:alternateName',
  'schema:birthDate',
  'schema:gender',
  'schema:height',
  'schema:image',
  'schema:keywords',
  'schema:name',
  'schema:sameAs',
  'schema:url',
  'schema:weight',
  'wdt:P1853',
  'wdt:P3180',
  'wdt:P6296',
  'rezics:relatedCharacterIdentity',
  'wdt:P26',
  'wdt:P3373',
  'wdt:P22',
  'wdt:P25',
  'wdt:P451',
  'rezics:characterRival',
];
const newProperties = [
  'schema:gender',
  'schema:height',
  'schema:weight',
  'wdt:P1853',
  'wdt:P6296',
  'rezics:relatedCharacterIdentity',
  'wdt:P26',
  'wdt:P3373',
  'wdt:P22',
  'wdt:P25',
  'wdt:P451',
  'rezics:characterRival',
];

type Decision = {
  status: string;
  term?: string;
  on?: string;
  qualifies?: string;
  reason?: string;
  qualifiers?: Record<string, Decision> | Array<Decision | string>;
  profile?: Decision;
  value?: Decision;
};
type VndbTable = { name: string; type: string; columns: Array<Decision & { name: string }> };
type BangumiEntry = { id: string; type?: Decision; fields?: Array<{ id: string; mapping: Decision }> };

function inventory<T>(source: string): T {
  return Bun.YAML.parse(readFileSync(new URL(`../sources/${source}.yaml`, import.meta.url), 'utf8')) as T;
}

// Qualifiers belong to the statement's property contract, rather than being main properties of its subject.
function covered(decision: Decision, main?: string) {
  if (decision.status === 'omitted') {
    expect(decision.reason?.trim().length).toBeGreaterThan(15);
    expect(decision.term).toBeUndefined();
    return;
  }
  expect(decision.status).toBe('existing');
  expect(decision.term).toBeDefined();
  expect(decision.on).toBeDefined();
  const type = bundledRelease.types[decision.on!];
  expect(type).toBeDefined();
  if (main) {
    expect(bundledRelease.properties[main]?.qualifiers).toContain(decision.term);
  } else {
    expect(
      decision.term === decision.on ||
        type!.properties.includes(decision.term!) ||
        type!.properties.some((property) => bundledRelease.properties[property]?.qualifiers.includes(decision.term!)),
    ).toBe(true);
  }
  expect(bundledRelease.types[decision.term!] ?? bundledRelease.properties[decision.term!]).toBeDefined();
  for (const qualifier of Object.values(decision.qualifiers ?? {})) {
    if (typeof qualifier !== 'string') covered(qualifier, decision.term);
  }
  if (decision.profile) covered(decision.profile);
  if (decision.value) covered(decision.value);
}

test('a fictional character is a catalogue profile that works reference by qualified statements', () => {
  const { types, properties } = bundledRelease;
  expect(types[character]!.properties).toEqual(expect.arrayContaining(characterProperties));
  expect(types[character]!.properties).not.toContain('schema:character');
  expect(types[character]!.properties).not.toContain('wdt:P725');
  expect(types[character]!.properties).not.toContain('wdt:P453');
  expect(properties['schema:keywords']).toMatchObject({
    datatype: 'wikibase-item',
    targets: ['skos:Concept'],
    qualifiers: ['rezics:spoilerLevel'],
  });
  expect(properties['schema:character']).toMatchObject({
    datatype: 'wikibase-item',
    targets: [character],
    qualifiers: ['rezics:spoilerLevel', 'wdt:P1932', 'wdt:P3629', 'wdt:P3831', 'wdt:P518'],
    mappings: ['wd:P674'],
  });
  expect(properties['wdt:P725']!.qualifiers).toEqual(
    expect.arrayContaining(['schema:position', 'wdt:P1932', 'wdt:P3831', 'wdt:P453']),
  );
  expect(properties['wdt:P453']!.targets).toEqual([character]);
  for (const work of works) {
    expect(types[work]!.properties).toEqual(
      expect.arrayContaining(['schema:character', 'wdt:P725', 'schema:genre', 'schema:keywords', 'wdt:P179']),
    );
  }
  expect(properties['schema:alternateName']).toMatchObject({
    datatype: 'monolingualtext',
    multivalued: true,
    qualifiers: ['rezics:spoilerLevel'],
  });
  for (const term of ['schema:gender', 'wdt:P1853'])
    expect(properties[term]).toMatchObject({ datatype: 'wikibase-item', targets: ['skos:Concept'] });
  expect(properties['schema:gender']!.qualifiers).toContain('rezics:spoilerLevel');
  for (const term of ['schema:height', 'schema:weight'])
    expect(properties[term]).toMatchObject({ datatype: 'quantity', minimum: 0 });
  expect(properties['wdt:P6296']).toMatchObject({ datatype: 'external-id', mappings: ['wd:P6296'] });
  expect(properties['rezics:relatedCharacterIdentity']).toMatchObject({
    datatype: 'wikibase-item',
    targets: [character],
    qualifiers: ['rezics:spoilerLevel'],
    relation: { group: 'association', inverse: 'rezics:relatedCharacterIdentityOf' },
  });
  expect(properties['wdt:P3629']).toMatchObject({
    datatype: 'quantity',
    minimum: 0,
    units: ['http://www.wikidata.org/entity/Q577'],
  });
  expect(properties['schema:character']!.qualifiers).toContain('wdt:P3629');
  expect(properties['wdt:P26']!.relation).toMatchObject({ group: 'association', symmetric: true });
  expect(properties['rezics:characterRival']!.relation).toMatchObject({ group: 'association', symmetric: true });
  expect(types[character]!.facets).toEqual([
    'schema:keywords',
    'schema:gender',
    'wdt:P1853',
    'schema:birthDate',
    'schema:height',
    'schema:weight',
  ]);
  const schema = bundledSources().schemas['character.yaml']!;
  expect(schema).toContain('https://vndb.org/c');
  expect(schema).toContain('https://bgm.tv/character');
  const parsed = Bun.YAML.parse(schema) as { classes: Record<string, { class_uri?: string; is_a?: string }> };
  expect(parsed.classes.FictionalCharacter).toMatchObject({ is_a: 'Character', class_uri: character });
});

test('VNDB and Bangumi character fields are bundled or omitted with a reason', () => {
  const vndb = inventory<{ tables: VndbTable[] }>('vndb');
  const tables = [
    'chars',
    'chars_alias',
    'chars_names',
    'chars_traits',
    'chars_vns',
    'traits',
    'traits_parents',
    'vn_seiyuu',
  ];
  for (const name of tables) {
    const table = vndb.tables.find((entry) => entry.name === name)!;
    expect(table).toBeDefined();
    for (const column of table.columns) covered(column);
  }
  for (const name of ['chars', 'chars_alias', 'chars_names', 'chars_traits'])
    expect(vndb.tables.find((table) => table.name === name)!.type).toBe(character);
  const bangumi = inventory<{
    files: BangumiEntry[];
    infobox: BangumiEntry[];
    enumerations: Array<{ id: string; values: Array<{ mapping: Decision }> }>;
  }>('bangumi');
  for (const id of ['character', 'subject-characters', 'person-characters']) {
    const file = bangumi.files.find((entry) => entry.id === id)!;
    expect(file).toBeDefined();
    covered(file.type!);
    for (const field of file.fields!)
      covered(field.mapping, id === 'person-characters' && field.id === 'character_id' ? 'wdt:P725' : undefined);
  }
  for (const id of ['Crt', 'Crt.aliases']) {
    const template = bangumi.infobox.find((entry) => entry.id === id)!;
    expect(template).toBeDefined();
    for (const field of template.fields!) covered(field.mapping);
  }
  for (const id of ['character.role', 'subject-characters.type', 'person-characters.type']) {
    const group = bangumi.enumerations.find((entry) => entry.id === id)!;
    expect(group).toBeDefined();
    for (const value of group.values) covered(value.mapping);
  }
});

test('character terms carry labels in all eight UI locales', () => {
  for (const key of [character, ...characterProperties]) {
    const term = bundledRelease.types[key] ?? bundledRelease.properties[key];
    expect(term).toBeDefined();
    expect(Object.keys(term!.labels).sort()).toEqual(locales);
    for (const locale of locales) {
      expect(term!.labels[locale]?.trim().length).toBeGreaterThan(0);
      if (key !== character && !newProperties.includes(key)) continue;
      const labels = Bun.YAML.parse(bundledSources().presentation[`character/${locale}`]!) as {
        types?: Record<string, string>;
        properties?: Record<string, string>;
      };
      expect((key === character ? labels.types : labels.properties)?.[key]).toBe(term!.labels[locale]);
    }
  }
});
