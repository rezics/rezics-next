import { afterAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { TSchema } from 'typebox';
import { Value } from 'typebox/value';
import { authoredProfiles, commandProfiles, discoverProfiles } from '../compiler/generate.ts';
import type { ProfileDefinition, PropertyDefinition } from '../compiler/ir.ts';
import { buildModelOutputs } from '../compiler/outputs.ts';
import type { RegistryBinding, RegistryRoute } from '../compiler/registry.ts';
import { isTurtleProfile, parseTurtleProfile, profileSource } from '../compiler/shacl.ts';
import { structureCompositionProfile } from '../definitions/structure-composition-v1.ts';
import * as curation from '../definitions/collection-curation-v1.ts';
import * as publicName from '../definitions/collection-public-name-v1.ts';
import * as recipe from '../definitions/recipe-structure-v1.ts';
import * as book from '../definitions/structure-book-v1.ts';
import * as composition from '../definitions/structure-work-composition-v1.ts';

const root = resolve(import.meta.dir, '../..');
const rv = 'https://rezics.com/vocab/';
const schema = 'https://schema.org/';
const definition = 'https://rezics.com/definition/';
const ids = [
  'collection-curation-v1',
  'collection-public-name-v1',
  'recipe-structure-v1',
  'structure-book-v1',
  'structure-work-composition-v1',
];
const profiles = authoredProfiles.filter((profile) => ids.includes(profile.id));
const modules = [
  ['collection-curation-v1.ts', curation],
  ['collection-public-name-v1.ts', publicName],
  ['recipe-structure-v1.ts', recipe],
  ['structure-book-v1.ts', book],
  ['structure-work-composition-v1.ts', composition],
] as const;
const declarations = modules.map(
  ([file, module]) =>
    [
      file,
      Object.fromEntries(Object.entries(module).filter(([name]) => name.endsWith('Declaration'))),
    ] as const,
);
const options = { canonicalOrder: [], demandOrder: [] };
const temporary: string[] = [];
afterAll(() => {
  for (const path of temporary) rmSync(path, { recursive: true, force: true });
});
function directory(): string {
  mkdirSync(join(root, '.temp'), { recursive: true });
  const path = mkdtempSync(join(root, '.temp/structure-collection-turtle-'));
  temporary.push(path);
  return path;
}
const digest = (source: string) => createHash('sha256').update(source).digest('hex');
function normalizedProperties(properties: readonly PropertyDefinition[]) {
  return properties
    .map((property) =>
      Object.fromEntries(
        Object.entries(property)
          .filter(([key]) => !['hasValueBeforeMaxCount', 'lineBreaks', 'wrapAfter'].includes(key))
          .sort(([a], [b]) => a.localeCompare(b)),
      ),
    )
    .sort(
      (a, b) =>
        String(a.path).localeCompare(String(b.path)) ||
        JSON.stringify(a).localeCompare(JSON.stringify(b)),
    );
}
function constraints(profile: ProfileDefinition): string {
  return JSON.stringify(
    profile.shapes.map((shape) => ({
      iri: shape.iri,
      properties: normalizedProperties(shape.properties),
      ...(shape.or ? { or: shape.or.map(normalizedProperties) } : {}),
      ...(shape.closed ? { closed: shape.closed } : {}),
    })),
  );
}
// Exact prior pins and complete constraint snapshots, including every local alternative.
const original = {
  'collection-curation-v1': [
    'f89da51e411b4d1dc4f402ba2059b63a123bd3093f865b527d751a3dfa3468fe',
    'd094a088da05f27e865991f2961602d15cbc27d1d518ecec9eab861c9f8f13b0',
  ],
  'collection-public-name-v1': [
    '62e499bd577ea08182da6ac7b4694807568932445b6bbb464e1699d53cc08832',
    '285ec402959903105f0ef378efe165d51dc16dc659bd4b24c9f52ca6af3f7dd9',
  ],
  'recipe-structure-v1': [
    'b950e8eb396bc5261a976cf9c8378e42655b0aa2bdf9531701c7aaa51958dd72',
    '3d1837287c51ea1b96be9b20d4937df8e65f85a82a30cce80fcd302914a2fe6f',
  ],
  'structure-book-v1': [
    '5598fd9d04b2729c3008a647c92c03c9f1580b5c103dbe2e1a84f10e226e6242',
    '858d2f13c857c644d6e1a9a7022878e52547c73761017bb6a52ded9777be7ff2',
  ],
  'structure-work-composition-v1': [
    'f8b3030ccf4b0bcc882dc360452ec471e4f9d2f9ea125a09120b990a2eda7566',
    'e079880f669fe3ca5ba02e6dd72fe666b6201f09440079cfc514be1959d1a46f',
  ],
} as const;
const roles = {
  'collection-curation-v1': [
    'structure-link',
    'collection',
    'revision',
    'definition',
    'definition-revision',
  ],
  'collection-public-name-v1': ['revision'],
  'recipe-structure-v1': ['ingredient-line', 'step', 'measure'],
  'structure-book-v1': ['group'],
  'structure-work-composition-v1': ['part'],
} as const;
interface RegistryManifest {
  profiles: { id: string; binding?: RegistryBinding }[];
  canonical: { type: string; routes: RegistryRoute[] }[];
  bindingDemands: { type: string; profile: string }[];
}
function selectedRegistry(value: Record<string, unknown>) {
  const manifest = value as unknown as RegistryManifest;
  return {
    profiles: manifest.profiles
      .filter((profile) => ids.includes(profile.id))
      .map(({ id, binding }) => ({ id, ...(binding ? { binding } : {}) })),
    canonical: manifest.canonical
      .map((entry) => ({
        ...entry,
        routes: entry.routes.filter((route) => ids.includes(route.profile)),
      }))
      .filter((entry) => entry.routes.length),
    bindingDemands: manifest.bindingDemands.filter((demand) => ids.includes(demand.profile)),
  };
}
const outputs = buildModelOutputs(profiles);
let schemaPromise: Promise<Record<string, TSchema>> | undefined;
async function accepts(id: string, role: string, value: Record<string, unknown>): Promise<boolean> {
  if (!schemaPromise) {
    const path = join(directory(), 'schemas.ts');
    writeFileSync(path, outputs.get('packages/model/src/generated/schemas.ts')!);
    schemaPromise = import(path).then((module) => module.shapeSchemas as Record<string, TSchema>);
  }
  return Value.Check((await schemaPromise)[`${definition}${id}/${role}-shape`]!, value);
}
const node = (type: string, values: Record<string, unknown>) => ({
  '@id': 'urn:structure:focus',
  'rdf:type': [`${rv}${type}`],
  ...values,
});
const label = (value: string, language = 'en') => ({ '@value': value, '@language': language });
const placement = () => ({
  '@id': 'urn:structure:placement',
  'rdf:type': [`${rv}OccurrencePlacement`, `${schema}ListItem`],
  'schema:position': ['a'],
  'rv:occurrence': ['urn:structure:occurrence'],
  'rv:generation': ['urn:structure:generation'],
  'rv:orderSegment': ['urn:structure:segment'],
  'rv:orderKey': ['a'],
  'rv:occurrenceRole': [`${rv}PartRole`],
  'schema:item': ['urn:work:part'],
});
const ingredient = () =>
  node('IngredientLine', {
    'rv:originalText': [label('1/8 cup flour')],
    'rv:optionality': [`${rv}Required`],
    'rv:scaling': [`${rv}LinearScaling`],
    'rv:parseStatus': [`${rv}Parsed`],
  });
const measure = () =>
  node('RecipeMeasure', {
    'rv:generation': ['urn:structure:generation'],
    'rv:measureKind': [`${rv}Yield`],
    'rv:valueNumerator': [0],
    'rv:valueDenominator': [1],
    'rv:basis': [`${rv}WholeRecipe`],
    'rv:coverage': [`${rv}Complete`],
    'rv:provenance': [`${rv}Declared`],
  });
const collection = () =>
  node('Collection', {
    'rv:curator': ['urn:collection:curator'],
    'rv:disclosure': [`${rv}Public`],
    'rv:collectionState': [`${rv}Active`],
    'rv:collectionHead': ['urn:collection:revision'],
    'schema:name': [label('Shelf')],
    'rv:collectionKind': [`${rv}StaticCollection`],
  });
function collectionRevision(dynamic = false): Record<string, unknown> {
  return {
    '@id': 'urn:collection:revision',
    'rdf:type': [
      `${rv}${dynamic ? 'DynamicCollectionRevision' : 'CollectionRevision'}`,
      `${rv}RevisionAnchor`,
    ],
    'rv:component': ['urn:collection:one'],
    'rv:operation': ['urn:collection:operation'],
    'rv:manifest': ['urn:collection:manifest'],
    'rv:modelRevision': [`${definition}collection-curation-v1`],
    'rv:shapeRevision': [`${definition}collection-curation-v1`],
    'rv:datasetId': ['urn:rezics:dataset:product'],
    'rv:dataEpoch': ['abcdef01-2345-4000-8000-abcdef012345'],
    'rv:sequence': [1],
    ...(dynamic
      ? { 'rv:queryProfile': ['urn:collection:query-profile'], 'rv:resultBudget': [1] }
      : { 'rv:collectionOperation': [`${rv}CollectionCreate`] }),
  };
}

test('five Structure and Collection discoveries preserve exact pins, 91 properties, nine alternatives and roles', () => {
  const path = directory();
  for (const id of ids)
    writeFileSync(
      join(path, `${id}.ttl`),
      readFileSync(join(root, `model/definitions/${id}.ttl`), 'utf8'),
    );
  const discovered = discoverProfiles(path, modules);
  expect(discovered.map((profile) => profile.id)).toEqual(ids);
  expect(profiles.map((profile) => profile.id)).toEqual(ids);
  const shapes = discovered.flatMap((profile) => profile.shapes);
  expect(shapes).toHaveLength(11);
  expect(shapes.flatMap((shape) => shape.properties)).toHaveLength(91);
  expect(shapes.flatMap((shape) => shape.or ?? [])).toHaveLength(9);
  expect(shapes.flatMap((shape) => (shape.or ?? []).flat())).toHaveLength(32);
  const published = commandProfiles(discovered, options);
  for (const profile of discovered) {
    const id = profile.id as keyof typeof original;
    expect(digest(constraints(profile))).toBe(original[id][1]);
    expect(digest(profileSource(profile))).toBe(original[id][0]);
    expect(profile.shapes.map((shape) => shape.iri)).toEqual(
      roles[id].map((role) => `${definition}${id}/${role}-shape`),
    );
    const entry = published.profiles.find((item) => item.id === id)!;
    expect(entry.focusRoles).toEqual([...roles[id]]);
    expect(entry.sha256).toBe(original[id][0]);
    expect(published.shapes.get(entry.file)).toBe(profileSource(profile));
  }
  for (const [file, module] of modules) {
    const exported = Object.entries(module).filter(([name]) => name.endsWith('Profile'));
    expect(exported).toHaveLength(1);
    const profile = exported[0]![1] as ProfileDefinition;
    expect(isTurtleProfile(profile)).toBe(true);
    expect(String(file)).toBe(`${profile.id}.ts`);
    expect(profileSource(profile)).toBe(readFileSync(join(path, `${profile.id}.ttl`), 'utf8'));
    expect(Object.entries(module).filter(([name]) => name.endsWith('Declaration'))).toHaveLength(1);
  }
  const registry = selectedRegistry(commandProfiles(authoredProfiles).manifest);
  expect(digest(JSON.stringify(registry))).toBe(
    '53a43411523337d88fe5e6c3a4391c7bdc5e3164d91f0019130eff8868ebd231',
  );
  const isolated = selectedRegistry(published.manifest);
  expect(isolated.profiles).toEqual(registry.profiles);
  expect(isolated.canonical.sort((a, b) => a.type.localeCompare(b.type))).toEqual(
    [...registry.canonical].sort((a, b) => a.type.localeCompare(b.type)),
  );
  expect(isolated.bindingDemands).toEqual(registry.bindingDemands);
});

test('current author bytes match historical pins and a temporary author reload cannot rewrite retained records', () => {
  const path = directory();
  const historicalProfiles = profiles.map((profile) => {
    const source = profileSource(profile);
    expect(digest(source)).toBe(original[profile.id as keyof typeof original][0]);
    const canonical = Object.fromEntries(
      profile.shapes
        .filter((shape) => shape.canonical)
        .map((shape) => [shape.iri.split('/').at(-1)!.slice(0, -6), shape.canonical!]),
    );
    return parseTurtleProfile(profile.id, source, {
      id: profile.id,
      canonical,
      ...(profile.binding ? { binding: profile.binding } : {}),
    });
  });
  const historical = commandProfiles(historicalProfiles, options);
  const records = historical.profiles.map((profile) => ({
    profile: profile.id,
    shapeSha256: profile.sha256,
    revision: 'urn:structure:retained-revision',
  }));
  const retained = structuredClone({
    manifest: historical.manifest,
    profiles: historical.profiles,
    shapes: [...historical.shapes],
    records,
  });
  for (const profile of profiles)
    writeFileSync(
      join(path, `${profile.id}.ttl`),
      `${profileSource(profile)}\n# Temporary author byte reload.\n`,
    );
  expect(() => discoverProfiles(path, modules)).toThrow('Duplicate profile ID');
  const reloaded = discoverProfiles(path, declarations);
  const changed = commandProfiles(reloaded, options);
  for (const [index, profile] of profiles.entries()) {
    expect(changed.profiles[index]!.sha256).not.toBe(
      original[profile.id as keyof typeof original][0],
    );
    expect(changed.profiles[index]!.sha256).toBe(digest(profileSource(reloaded[index]!)));
    expect(constraints(reloaded[index]!)).toBe(constraints(profile));
  }
  expect(selectedRegistry(changed.manifest)).toEqual(selectedRegistry(historical.manifest));
  const preserved = commandProfiles(historicalProfiles, options);
  expect(preserved.manifest).toEqual(retained.manifest);
  expect(preserved.profiles).toEqual(retained.profiles);
  expect([...preserved.shapes]).toEqual(retained.shapes);
  expect({
    manifest: historical.manifest,
    profiles: historical.profiles,
    shapes: [...historical.shapes],
    records,
  }).toEqual(retained);
});

test('Work composition keeps the part qualifier; the shared shape admits any profile and role', () => {
  expect(digest(profileSource(structureCompositionProfile))).toBe(
    '1b6f33eae08a2779caee4b0335ad6f823be4f41ec3f6dd070a3c4ea70de5fd1c',
  );
  expect(digest(constraints(structureCompositionProfile))).toBe(
    '240c154991880ff83febd6a3d783b07d3a0c7a939d3c4b6adec69ee174f3dd0c',
  );
  const kernel = profileSource(structureCompositionProfile);
  expect(kernel).toContain('sh:path rv:structureProfile ; sh:minCount 1 ; sh:maxCount 1 ; sh:nodeKind sh:IRI');
  expect(kernel).toContain('sh:path rv:occurrenceRole ; sh:minCount 1 ; sh:maxCount 1 ; sh:nodeKind sh:IRI');
  expect(kernel).not.toContain('rv:BookComposition');
  expect(kernel).not.toContain('rv:PartRole');
  const manifest = commandProfiles(authoredProfiles).manifest as unknown as RegistryManifest;
  const partRoutes = manifest.canonical.find((entry) => entry.type === `${rv}WorkPart`)!.routes;
  expect(partRoutes).toContainEqual({
    profile: 'structure-work-composition-v1',
    shape: `${definition}structure-work-composition-v1/part-shape`,
    when: [],
  });
  for (const type of ['Structure', 'OccurrencePlacement', 'RemovedPlacement']) {
    const routes = manifest.canonical.find((entry) => entry.type === `${rv}${type}`)?.routes ?? [];
    expect(routes.some((route) => route.profile === 'structure-work-composition-v1')).toBe(false);
  }
});

test('the shared Structure shape admits a new profile and role and still rejects a broken selection', async () => {
  const path = join(directory(), 'shared-schemas.ts');
  writeFileSync(path, buildModelOutputs([structureCompositionProfile]).get('packages/model/src/generated/schemas.ts')!);
  const schemas = (await import(path)).shapeSchemas as Record<string, TSchema>;
  const check = (role: string, value: Record<string, unknown>) =>
    Value.Check(schemas[`${definition}structure-composition-v1/${role}-shape`]!, value);
  const structure = node('Structure', {
    'rv:structureOf': ['urn:work:composing'],
    'rv:structureProfile': [`${rv}SectionList`],
    'rv:structureHead': ['urn:structure:revision'],
    'rv:selectedGeneration': ['urn:structure:generation'],
  });
  expect(check('structure', structure)).toBe(true);
  expect(check('structure', { ...structure, 'rv:structureProfile': [`${rv}WorkComposition`] })).toBe(true);
  expect(check('structure', { ...structure, 'rv:structureProfile': [] })).toBe(false);
  const valid = { ...placement(), 'rv:occurrenceRole': [`${rv}SectionRole`] };
  expect(check('placement', valid)).toBe(true);
  expect(check('placement', { ...valid, 'rv:occurrenceRole': [`${rv}PartRole`] })).toBe(true);
  expect(check('placement', { ...valid, 'rv:occurrenceRole': [] })).toBe(false);
  expect(check('placement', { ...valid, 'rv:selectionMode': [`${rv}FollowContext`] })).toBe(true);
  expect(check('placement', { ...valid, 'rv:selectionMode': [`${rv}FixedRealm`] })).toBe(false);
  const { 'schema:item': omitted, ...withoutItem } = valid;
  expect(omitted).toEqual(['urn:work:part']);
  expect(check('placement', withoutItem)).toBe(false);
  const removed = node('RemovedPlacement', {
    'rv:occurrence': ['urn:structure:occurrence'],
    'rv:generation': ['urn:structure:generation'],
    'rv:occurrenceRole': [`${rv}EntryRole`],
    'rv:lastParent': ['urn:structure:parent'],
    'rv:removedBy': ['urn:structure:revision'],
  });
  expect(check('removed-placement', removed)).toBe(true);
  expect(check('removed-placement', { ...removed, 'rv:orderKey': ['a'] })).toBe(false);
});

test('WorkPart labels and Book group divisions retain exact bounds and generation links', async () => {
  const part = node('WorkPart', {
    'rv:generation': ['urn:structure:generation'],
    'rv:displayLabel': ['Part'],
    'rv:partInclusion': [`${rv}RequiredPart`],
  });
  for (const inclusion of ['RequiredPart', 'OptionalPart', 'ExtraPart'])
    expect(
      await accepts('structure-work-composition-v1', 'part', {
        ...part,
        'rv:partInclusion': [`${rv}${inclusion}`],
      }),
    ).toBe(true);
  expect(
    await accepts('structure-work-composition-v1', 'part', {
      ...part,
      'rv:displayLabel': ['x'.repeat(500)],
    }),
  ).toBe(true);
  for (const value of [[''], ['x'.repeat(501)], [label('Part')], [null], null, 'Part'])
    expect(
      await accepts('structure-work-composition-v1', 'part', { ...part, 'rv:displayLabel': value }),
    ).toBe(false);
  const group = node('BookGroup', {
    'rv:generation': ['urn:structure:generation'],
    'rv:bookDivision': [`${rv}VolumeDivision`],
  });
  for (const division of ['VolumeDivision', 'PartDivision', 'ExtrasDivision'])
    expect(
      await accepts('structure-book-v1', 'group', {
        ...group,
        'rv:bookDivision': [`${rv}${division}`],
      }),
    ).toBe(true);
  for (const value of [[], ['VolumeDivision'], [`${rv}ChapterDivision`], [null], null])
    expect(
      await accepts('structure-book-v1', 'group', { ...group, 'rv:bookDivision': value }),
    ).toBe(false);
  expect(await accepts('structure-book-v1', 'group', { ...group, 'rv:generation': [] })).toBe(
    false,
  );
});

test('Recipe ingredient alternatives retain exact rational bounds and allow unresolved lexical amounts', async () => {
  const id = 'recipe-structure-v1';
  const plain = ingredient();
  expect(await accepts(id, 'ingredient-line', plain)).toBe(true);
  const exact = {
    ...plain,
    'rv:amountNumerator': [1],
    'rv:amountDenominator': [8],
    'rv:amountLexical': ['0.125'],
    'rv:unitText': ['heaped cup'],
  };
  const preserved = structuredClone(exact);
  expect(await accepts(id, 'ingredient-line', exact)).toBe(true);
  expect(exact).toEqual(preserved);
  expect(
    await accepts(id, 'ingredient-line', {
      ...exact,
      'rv:amountUpperNumerator': [2],
      'rv:amountUpperDenominator': [8],
    }),
  ).toBe(true);
  expect(
    await accepts(id, 'ingredient-line', {
      ...plain,
      'rv:amountNumerator': [0],
      'rv:amountDenominator': [1_000_000_000_000],
    }),
  ).toBe(true);
  expect(
    await accepts(id, 'ingredient-line', {
      ...plain,
      'rv:amountNumerator': [1_000_000_000_000],
      'rv:amountDenominator': [1],
    }),
  ).toBe(true);
  for (const path of [
    'rv:amountNumerator',
    'rv:amountDenominator',
    'rv:amountUpperNumerator',
    'rv:amountUpperDenominator',
  ]) {
    const range = { ...exact, 'rv:amountUpperNumerator': [2], 'rv:amountUpperDenominator': [8] };
    expect(await accepts(id, 'ingredient-line', { ...range, [path]: [1_000_000_000_000] })).toBe(
      true,
    );
    expect(await accepts(id, 'ingredient-line', { ...range, [path]: [1_000_000_000_001] })).toBe(
      false,
    );
  }
  for (const extra of [
    { 'rv:amountNumerator': [1] },
    { 'rv:amountDenominator': [8] },
    { 'rv:amountUpperNumerator': [1], 'rv:amountUpperDenominator': [8] },
    { 'rv:amountNumerator': [1], 'rv:amountDenominator': [8], 'rv:amountUpperNumerator': [2] },
    { 'rv:amountNumerator': [-1], 'rv:amountDenominator': [8] },
    { 'rv:amountNumerator': [1], 'rv:amountDenominator': [0] },
    { 'rv:amountNumerator': [1_000_000_000_001], 'rv:amountDenominator': [1] },
    { 'rv:amountNumerator': ['1'], 'rv:amountDenominator': [8] },
    { 'rv:amountNumerator': [0.125], 'rv:amountDenominator': [1] },
    { 'rv:amountNumerator': null },
    { 'rv:amountNumerator': [null] },
  ])
    expect(await accepts(id, 'ingredient-line', { ...plain, ...extra })).toBe(false);
  expect(
    await accepts(id, 'ingredient-line', {
      ...plain,
      'rv:amountLexical': ['as needed'],
      'rv:parseStatus': [`${rv}Unparsed`],
    }),
  ).toBe(true);
  const step = node('RecipeStep', {
    'rv:instructionText': [label('Mix well')],
    'rv:scaling': [`${rv}NotScalable`],
  });
  expect(await accepts(id, 'step', step)).toBe(true);
  expect(await accepts(id, 'step', { ...step, 'rv:instructionText': [label('')] })).toBe(false);
});

test('Recipe measure alternatives require nutrient and computed evidence without tightening declared evidence', async () => {
  const id = 'recipe-structure-v1';
  const valid = measure();
  for (const kind of [
    'Yield',
    'Servings',
    'PreparationDuration',
    'CookingDuration',
    'TotalDuration',
  ]) {
    const quantity = { ...valid, 'rv:measureKind': [`${rv}${kind}`] };
    expect(await accepts(id, 'measure', quantity)).toBe(true);
    expect(await accepts(id, 'measure', { ...quantity, 'rv:nutrient': ['urn:nutrient:one'] })).toBe(
      false,
    );
  }
  const nutrient = {
    ...valid,
    'rv:measureKind': [`${rv}Nutrient`],
    'rv:nutrient': ['urn:nutrient:one'],
  };
  expect(await accepts(id, 'measure', { ...valid, 'rv:measureKind': [`${rv}Nutrient`] })).toBe(
    false,
  );
  for (const sample of [valid, nutrient]) {
    for (const provenance of ['Declared', 'SourceStated']) {
      expect(
        await accepts(id, 'measure', { ...sample, 'rv:provenance': [`${rv}${provenance}`] }),
      ).toBe(true);
      expect(
        await accepts(id, 'measure', {
          ...sample,
          'rv:provenance': [`${rv}${provenance}`],
          'rv:evidence': ['urn:recipe:evidence'],
        }),
      ).toBe(true);
    }
    expect(await accepts(id, 'measure', { ...sample, 'rv:provenance': [`${rv}Computed`] })).toBe(
      false,
    );
    expect(
      await accepts(id, 'measure', {
        ...sample,
        'rv:provenance': [`${rv}Computed`],
        'rv:evidence': ['urn:recipe:evidence'],
      }),
    ).toBe(true);
    for (const [path, value] of [
      ['rv:valueNumerator', -1],
      ['rv:valueNumerator', 1_000_000_000_001],
      ['rv:valueDenominator', 0],
      ['rv:valueDenominator', '1'],
      ['rv:basis', 'WholeRecipe'],
      ['rv:coverage', `${rv}Invalid`],
    ] as const)
      expect(await accepts(id, 'measure', { ...sample, [path]: [value] })).toBe(false);
  }
});

test('Collection static and captured alternatives preserve optional initial Structure and localized name bounds', async () => {
  const id = 'collection-curation-v1';
  const valid = collection();
  expect(await accepts(id, 'collection', valid)).toBe(true);
  expect(await accepts(id, 'structure-link', valid)).toBe(false);
  expect(
    await accepts(id, 'structure-link', { ...valid, 'rv:structure': ['urn:collection:structure'] }),
  ).toBe(true);
  const captured = {
    ...valid,
    'rv:collectionKind': [`${rv}CapturedCollection`],
    'rv:capturedFrom': ['urn:collection:rule-revision'],
    'rv:captureCoverage': [`${rv}Partial`],
  };
  expect(await accepts(id, 'collection', captured)).toBe(true);
  expect(
    await accepts(id, 'collection', {
      ...valid,
      'rv:capturedFrom': ['urn:collection:rule-revision'],
    }),
  ).toBe(false);
  expect(
    await accepts(id, 'collection', { ...valid, 'rv:captureCoverage': [`${rv}Complete`] }),
  ).toBe(false);
  for (const path of ['rv:capturedFrom', 'rv:captureCoverage']) {
    const missing = { ...captured } as Record<string, unknown>;
    delete missing[path];
    expect(await accepts(id, 'collection', missing)).toBe(false);
  }
  expect(
    await accepts(id, 'collection', {
      ...valid,
      'schema:name': [label('x'.repeat(300)), label('雨', 'zh')],
    }),
  ).toBe(true);
  // No lexical minimum is authored for these localized names.
  expect(await accepts(id, 'collection', { ...valid, 'schema:name': [label('')] })).toBe(true);
  for (const value of [
    [],
    [label('x'.repeat(301))],
    [label('A', 'en-US'), label('B', 'en-us')],
    ['Shelf'],
    [null],
    null,
  ])
    expect(await accepts(id, 'collection', { ...valid, 'schema:name': value })).toBe(false);
});

test('Dynamic Collection budgets and revision envelopes preserve exact types, requirements and optional predecessor', async () => {
  const id = 'collection-curation-v1';
  for (const dynamic of [false, true]) {
    const role = dynamic ? 'definition-revision' : 'revision';
    const valid = collectionRevision(dynamic);
    expect(await accepts(id, role, valid)).toBe(true);
    for (const path of [
      'rv:operation',
      'rv:manifest',
      'rv:component',
      ...(dynamic ? ['rv:queryProfile'] : []),
    ]) {
      const missing = { ...valid };
      delete missing[path];
      expect(await accepts(id, role, missing)).toBe(false);
    }
    for (const value of [[0], ['1'], [null], null, 1])
      expect(await accepts(id, role, { ...valid, 'rv:sequence': value })).toBe(false);
    expect(await accepts(id, role, { ...valid, 'rv:predecessor': [] })).toBe(true);
    expect(
      await accepts(id, role, { ...valid, 'rv:predecessor': ['urn:collection:previous'] }),
    ).toBe(true);
    expect(await accepts(id, role, { ...valid, 'rv:predecessor': null })).toBe(false);
    expect(
      await accepts(id, role, {
        ...valid,
        'rdf:type': [`${rv}RevisionAnchor`, `${rv}RevisionAnchor`],
      }),
    ).toBe(false);
    expect(await accepts(id, role, { ...valid, 'rv:dataEpoch': ['not-a-uuid'] })).toBe(false);
    if (dynamic) {
      for (const value of [1, 10000])
        expect(await accepts(id, role, { ...valid, 'rv:resultBudget': [value] })).toBe(true);
      for (const value of [[], [0], [10001], [1.5], ['1'], [null], null, 1])
        expect(await accepts(id, role, { ...valid, 'rv:resultBudget': value })).toBe(false);
    }
  }
});

test('Dynamic Collection definition retains its required head and localized names independently of static membership', async () => {
  const id = 'collection-curation-v1';
  const valid = node('DynamicCollection', {
    'rv:curator': ['urn:collection:curator'],
    'rv:disclosure': [`${rv}Private`],
    'rv:collectionState': [`${rv}Active`],
    'rv:definitionHead': ['urn:collection:rule-revision'],
    'schema:name': [label('Rule'), label('規則', 'zh')],
  });
  expect(await accepts(id, 'definition', valid)).toBe(true);
  expect(
    await accepts(id, 'definition', { ...valid, 'rv:collectionState': [`${rv}Retired`] }),
  ).toBe(true);
  for (const path of ['rv:curator', 'rv:definitionHead', 'schema:name']) {
    const missing = { ...valid } as Record<string, unknown>;
    delete missing[path];
    expect(await accepts(id, 'definition', missing)).toBe(false);
    expect(await accepts(id, 'definition', { ...valid, [path]: null })).toBe(false);
  }
  expect(
    await accepts(id, 'definition', {
      ...valid,
      'schema:name': [label('A', 'en-US'), label('B', 'en-us')],
    }),
  ).toBe(false);
  expect(
    await accepts(id, 'definition', { ...valid, 'schema:name': [label('x'.repeat(301))] }),
  ).toBe(false);
});

test('Collection public-name payload remains bounded lexical text rather than a JSON parser', async () => {
  const id = 'collection-public-name-v1';
  const valid = {
    '@id': 'urn:collection:name-revision',
    'rdf:type': [`${rv}CollectionNameRevision`, `${rv}RevisionAnchor`],
    'rv:component': ['urn:collection:one'],
    'rv:operation': ['urn:collection:operation'],
    'rv:profilePayload': ['{}'],
    'rv:modelRevision': [`${definition}${id}`],
    'rv:shapeRevision': [`${definition}${id}`],
    'rv:datasetId': ['urn:rezics:dataset:product'],
    'rv:dataEpoch': ['owner-defined epoch'],
    'rv:sequence': [1],
  };
  for (const lexical of ['{}', 'xx', 'not JSON', 'x'.repeat(8000)])
    expect(await accepts(id, 'revision', { ...valid, 'rv:profilePayload': [lexical] })).toBe(true);
  for (const value of [[], ['x'], ['x'.repeat(8001)], [{}], [null], null, '{}'])
    expect(await accepts(id, 'revision', { ...valid, 'rv:profilePayload': value })).toBe(false);
  const context = JSON.parse(outputs.get(`generated/model/contexts/${id}.jsonld`)!)['@context'];
  expect(context['rv:profilePayload']).toEqual({ '@id': `${rv}profilePayload` });
});

test('Structure and Collection authors preserve all thirty-nine earlier Turtle byte digests', () => {
  const earlierIds = [
    'fixed-native-text-release-v1',
    'global-rating-standing-context-v1',
    'global-rating-standing-observation-v1',
    'post-v1',
    'realm-daily-rating-context-v1',
    'realm-daily-rating-observation-v1',
    'realm-experience-rating-context-v1',
    'realm-experience-rating-observation-v1',
    'realm-release-rating-context-v1',
    'realm-release-rating-observation-v1',
    'realm-standing-rating-context-v1',
    'realm-standing-rating-observation-v1',
    'realm-target-rating-context-v1',
    'realm-target-rating-context-v2',
    'realm-target-rating-context-v3',
    'realm-target-rating-context-v4',
    'realm-target-rating-observation-v1',
    'realm-target-rating-observation-v2',
    'realm-target-rating-observation-v3',
    'realm-target-rating-observation-v4',
    'rights-offering-v1',
    'source-field-statement-v1',
    'source-open-library-work-v1',
    'source-reification-v1',
    'space-realm-v1',
    'space-realm-v2',
    'space-realm-v3',
    'translation-link-v1',
    'work-address-claim-v1',
    'work-address-disposition-v1',
    'work-address-lifecycle-v1',
    'work-author-credit-v1',
    'work-derivation-unresolved-v1',
    'work-derivation-v1',
    'work-reference-block-v1',
    'work-title-control-v1',
    'zone-capability-v1',
    'zone-presentation-v1',
    'zone-presentation-v2',
  ];
  expect(earlierIds).toHaveLength(39);
  const recorded = earlierIds.map((id) => ({
    file: `model/definitions/${id}.ttl`,
    sourceSha256: digest(readFileSync(join(root, `model/definitions/${id}.ttl`), 'utf8')),
  }));
  expect(digest(JSON.stringify(recorded))).toBe(
    'e0684173a78929e8da0570fe048eef9079cf2fc127f8f88f3ddbb65b0b59b73e',
  );
});
