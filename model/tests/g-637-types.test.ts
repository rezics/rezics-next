import { afterEach, expect, test } from 'bun:test';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { uiLocales } from '../../apps/web/i18n/define.ts';
import { buildArtifacts, generate } from '../compiler/generate.ts';
import {
  compileTypes,
  profileWorkTypes,
  renderTypeRegistry,
  typeBases,
  typeLocales,
  type TypeRegistryDefinition,
} from '../compiler/type.ts';
import { typesV1 } from '../definitions/types-v1.ts';
import { workKindV2Profile } from '../definitions/work-kind-v2.ts';
import { workTypeV2Profile } from '../definitions/work-type-v2.ts';

const repo = new URL('../..', import.meta.url).pathname;
const compile = (definition: TypeRegistryDefinition = typesV1) =>
  compileTypes(definition, workKindV2Profile, workTypeV2Profile);
const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});
const scratch = () => {
  mkdirSync(join(repo, '.temp'), { recursive: true });
  const root = mkdtempSync(join(repo, '.temp/g-637-'));
  temporary.push(root);
  return root;
};

test('G-637: every Work profile type appears once, with exactly the reviewed type-edit set and eight locale forms', () => {
  const entries = compile();
  expect(typeLocales).toEqual(uiLocales);
  expect(new Set(entries.map((entry) => entry.type)).size).toBe(entries.length);
  expect(
    entries
      .filter((entry) => entry.base === 'work')
      .map((entry) => entry.type)
      .sort(),
  ).toEqual(profileWorkTypes(workKindV2Profile).sort());
  expect(
    entries
      .filter((entry) => entry.creatable)
      .map((entry) => entry.type)
      .sort(),
  ).toEqual(
    profileWorkTypes(workTypeV2Profile)
      .filter((type) => type !== 'https://schema.org/CreativeWork')
      .sort(),
  );
  for (const base of typeBases)
    expect(entries.filter((entry) => entry.base === base && entry.default)).toHaveLength(1);
  for (const entry of entries) {
    expect(Object.keys(entry.labels)).toEqual([...typeLocales]);
    for (const locale of typeLocales) {
      expect(entry.labels[locale].one.trim().length).toBeGreaterThan(0);
      expect(entry.labels[locale].other.trim().length).toBeGreaterThan(0);
    }
  }
  expect(entries.map((entry) => entry.type)).toEqual(
    expect.arrayContaining([
      'https://rezics.com/vocab/Character',
      'https://rezics.com/vocab/Role',
      'https://rezics.com/vocab/Release',
      'https://rezics.com/vocab/FixedRelease',
      'https://schema.org/ListItem',
      'https://rezics.com/vocab/TextContribution',
    ]),
  );
});

test('G-637: metadata-only or profile-only Work types fail compilation in both directions', () => {
  const metadata = typesV1.types['schema:Book'];
  expect(() =>
    compile({ ...typesV1, types: { ...typesV1.types, 'schema:NewWork': metadata } }),
  ).toThrow('Type metadata and Work profile differ');
  const profile = structuredClone(workKindV2Profile);
  const property = profile.shapes[0]!.properties[0]!;
  const newProfile = {
    ...profile,
    shapes: [
      {
        ...profile.shapes[0]!,
        properties: [
          { ...property, in: [...property.in, 'schema:NewWork' as const] },
          ...profile.shapes[0]!.properties.slice(1),
        ],
      },
    ],
  };
  expect(() => compileTypes(typesV1, newProfile, workTypeV2Profile)).toThrow(
    'Type metadata and Work profile differ',
  );
  const { 'schema:Book': _book, ...missingBook } = typesV1.types;
  expect(() => compile({ ...typesV1, types: missingBook })).toThrow(
    'Type metadata and Work profile differ',
  );
  const changedEdit = {
    ...workTypeV2Profile,
    shapes: [
      {
        ...workTypeV2Profile.shapes[0],
        properties: [
          {
            ...workTypeV2Profile.shapes[0].properties[0],
            in: [...workTypeV2Profile.shapes[0].properties[0].in, 'schema:NewWork' as const],
          },
          ...workTypeV2Profile.shapes[0].properties.slice(1),
        ],
      },
      ...workTypeV2Profile.shapes.slice(1),
    ],
  };
  expect(() => compileTypes(typesV1, workKindV2Profile, changedEdit)).toThrow(
    'Type-edit profile admits an unknown Work type',
  );
});

test('G-637: compiler rejects broken locale forms, duplicate IRIs, invalid metadata and missing defaults', () => {
  const book = typesV1.types['schema:Book'];
  expect(() =>
    compile({
      ...typesV1,
      types: {
        ...typesV1.types,
        'schema:Book': {
          ...book,
          labels: { ...book.labels, ko: { one: '', other: '책' } },
        },
      },
    }),
  ).toThrow('ko one label');
  const { ja: _ja, ...labels } = book.labels;
  expect(() =>
    compile({
      ...typesV1,
      types: { ...typesV1.types, 'schema:Book': { ...book, labels } },
    } as unknown as TypeRegistryDefinition),
  ).toThrow('needs ja labels');
  expect(() =>
    compile({ ...typesV1, types: { ...typesV1.types, '<https://schema.org/Book>': book } }),
  ).toThrow('Duplicate Type IRI');
  expect(() =>
    compile({
      ...typesV1,
      types: {
        ...typesV1.types,
        'schema:Book': {
          ...book,
          priority: -1,
        },
      },
    }),
  ).toThrow('Invalid Type metadata');
  expect(() =>
    compile({ ...typesV1, defaults: { ...typesV1.defaults, resource: 'rv:Missing' } }),
  ).toThrow('resource needs one default');
});

test('G-637: non-Work types stay open without widening Work admission', () => {
  const metadata = typesV1.types['rv:Character'];
  const entries = compile({
    ...typesV1,
    types: {
      ...typesV1.types,
      'rv:NewResource': metadata,
      'rv:NewRecord': { ...metadata, base: 'record',wikiSegment: undefined },
    },
  });
  expect(entries).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: 'https://rezics.com/vocab/NewResource',
        base: 'resource',
        creatable: false,
      }),
      expect.objectContaining({
        type: 'https://rezics.com/vocab/NewRecord',
        base: 'record',
        creatable: false,
      }),
    ]),
  );
  expect(entries.filter((entry) => entry.base === 'work')).toEqual(
    compile().filter((entry) => entry.base === 'work'),
  );
});

test('G-637: generator emits deterministic registry outside the command manifest; ETag covers label and policy edits', () => {
  const output = renderTypeRegistry(typesV1, workKindV2Profile, workTypeV2Profile);
  expect(buildArtifacts(repo).get('packages/model/src/generated/types.ts')).toBe(output);
  expect(buildArtifacts(repo).get('generated/model/manifest.json')).not.toContain('types-v1');
  const reordered = {
    ...typesV1,
    types: Object.fromEntries(Object.entries(typesV1.types).reverse()),
  } as TypeRegistryDefinition;
  expect(renderTypeRegistry(reordered, workKindV2Profile, workTypeV2Profile)).toBe(output);
  const book = typesV1.types['schema:Book'];
  const relabelled = {
    ...typesV1,
    types: {
      ...typesV1.types,
      'schema:Book': {
        ...book,
        labels: { ...book.labels, en: { one: 'Volume', other: 'Volumes' } },
      },
    },
  };
  expect(renderTypeRegistry(relabelled, workKindV2Profile, workTypeV2Profile)).not.toBe(output);
  const policy = {
    ...typesV1,
    types: { ...typesV1.types, 'schema:Book': { ...book, creation: 'administrator' as const } },
  };
  expect(renderTypeRegistry(policy, workKindV2Profile, workTypeV2Profile)).not.toBe(output);
});

test('G-637: policy metadata can be refined without an accepted type lock', async () => {
  const root = scratch();
  cpSync(join(repo, 'model'), join(root, 'model'), { recursive: true });
  symlinkSync(join(repo, 'infra'), join(root, 'infra'));
  const source = join(root, 'model/definitions/types-v1.ts');
  const original = readFileSync(source, 'utf8');
  const changed = original.replace(
    /('schema:Book': \{[\s\S]*?creation: )'contributor'/,
    "$1'administrator'",
  );
  expect(changed).not.toBe(original);
  writeFileSync(source, changed);
  const copied = (await import(
    join(root, 'model/compiler/generate.ts')
  )) as typeof import('../compiler/generate.ts');
  expect(() => copied.generate(root, false)).not.toThrow();
  expect(readFileSync(join(root, 'packages/model/src/generated/types.ts'), 'utf8')).not.toBe(
    renderTypeRegistry(typesV1, workKindV2Profile, workTypeV2Profile),
  );
  expect(() => copied.generate(root, true)).not.toThrow();
});

test('G-637: generation detects type registry drift', () => {
  const root = scratch();
  generate(root, false);
  expect(() => generate(root, true)).not.toThrow();
  const file = join(root, 'packages/model/src/generated/types.ts');
  writeFileSync(file, readFileSync(file, 'utf8').replace('"Book"', '"Changed book"'));
  expect(() => generate(root, true)).toThrow(
    'Generated artifact differs: packages/model/src/generated/types.ts',
  );
});
