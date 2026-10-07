import { afterAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { TSchema } from 'typebox';
import { Value } from 'typebox/value';
import { authoredProfiles, commandProfiles } from '../compiler/generate.ts';
import { expand, buildModelOutputs } from '../compiler/outputs.ts';
import { isTurtleProfile, profileSource } from '../compiler/shacl.ts';
import { workMetadataProfile } from '../definitions/work-metadata-v1.ts';
import { workMetadataV2Profile } from '../definitions/work-metadata-v2.ts';
import { workMetadataDetailsProfile } from '../definitions/work-metadata-details-v1.ts';
import { workMetadataDetailsV2Profile } from '../definitions/work-metadata-details-v2.ts';
import { workNativeChildProfile } from '../definitions/work-native-child-v1.ts';
import { STRUCTURE_ROLES, structureCompositionProfile } from '../definitions/structure-composition-v1.ts';

const root = resolve(import.meta.dir, '../..');
const rv = 'https://rezics.com/vocab/';
const schema = 'https://schema.org/';
const definition = 'https://rezics.com/definition/';
const ids = [
  'structure-composition-v1',
  'work-metadata-details-v1',
  'work-metadata-details-v2',
  'work-metadata-v1',
  'work-metadata-v2',
  'work-native-child-v1',
];
const runtimeProfiles = [
  structureCompositionProfile,
  workMetadataDetailsProfile,
  workMetadataDetailsV2Profile,
  workMetadataProfile,
  workMetadataV2Profile,
  workNativeChildProfile,
] as const;
const profiles = authoredProfiles.filter((profile) => ids.includes(profile.id));
const outputs = buildModelOutputs(profiles);
const temporary: string[] = [];
afterAll(() => {
  for (const path of temporary) rmSync(path, { recursive: true, force: true });
});

const digest = (source: string) => createHash('sha256').update(source).digest('hex');
const shapeIri = (id: string, role: string) => definition + id + '/' + role + '-shape';
const vocab = (name: string) => rv + name;
function directory(): string {
  mkdirSync(join(root, '.temp'), { recursive: true });
  const path = mkdtempSync(join(root, '.temp/work-metadata-structure-turtle-'));
  temporary.push(path);
  return path;
}

const original = {
  'structure-composition-v1': {
    sha256: 'd6bcd8a0f349a7d9926298317e24086ce038a4596c5fcb73f0a1d09a5c105bf0',
    roles: [
      'structure', 'generation', 'segment', 'item-list', 'occurrence',
      'placement', 'removed-placement', 'revision', 'seal',
    ],
    canonical: {
      structure: { types: ['rv:Structure'] },
      generation: { types: ['rv:StructureGeneration'] },
      segment: { types: ['rv:OrderSegment'] },
      'item-list': { types: ['schema:ItemList'] },
      occurrence: { types: ['schema:ListItem'] },
      placement: { types: ['rv:OccurrencePlacement'] },
      'removed-placement': { types: ['rv:RemovedPlacement'] },
      revision: { types: ['rv:StructureRevision'] },
      seal: { types: ['rv:StructureSeal'] },
    },
  },
  'work-metadata-details-v1': {
    sha256: '905826519ea23297628a4e192c81176ff210b1089cb1ba821a48b10456032a09',
    roles: ['work', 'component', 'revision'],
    canonical: {
      component: { types: ['rv:WorkMetadataComponent'] },
      revision: { types: ['rv:WorkMetadataRevision'] },
    },
  },
  'work-metadata-details-v2': {
    sha256: '7ed4adc3c3f9379e5ce7c0b80a38ff2c602df761a5ffcfcf655ae3d6831e6ae6',
    roles: ['component', 'revision'],
    canonical: {
      component: { types: ['rv:EditionRecord'] },
      revision: { types: ['rv:WorkMetadataDetailsV2Revision'] },
    },
  },
  'work-metadata-v1': {
    sha256: 'ac918cf0458150520bf03f9683e6a363ad702376ebc50eaa729f98d84b3b8760',
    roles: ['work', 'main-version'],
    canonical: {
      work: { types: ['schema:CreativeWork'] },
      'main-version': { types: ['rv:MainVersion'] },
    },
  },
  'work-metadata-v2': {
    sha256: '5f2a13cf49bf5d8692bf4a57d5d7e10c080f916d63f5e29c7c16dc217799f866',
    roles: ['work', 'main-version'],
    canonical: {},
  },
  'work-native-child-v1': {
    sha256: '1c9e1ed2ab97a4211095848ddce43f361082b5b80c042000d384658ad029d5d5',
    roles: ['child', 'revision'],
    canonical: { child: { types: ['rv:NativeChild'] } },
  },
} as const;

let schemaPromise: Promise<Record<string, TSchema>> | undefined;
async function schemas(): Promise<Record<string, TSchema>> {
  if (!schemaPromise) {
    const path = join(directory(), 'schemas.ts');
    writeFileSync(path, outputs.get('packages/model/src/generated/schemas.ts')!);
    schemaPromise = import(path).then((module) => module.shapeSchemas as Record<string, TSchema>);
  }
  return schemaPromise;
}
async function accepts(id: string, role: string, value: Record<string, unknown>): Promise<boolean> {
  return Value.Check((await schemas())[shapeIri(id, role)]!, value);
}

test('Work metadata and Structure Turtle profiles preserve pins, focus roles and command metadata', () => {
  expect(runtimeProfiles.map((profile) => profile.id)).toEqual(ids);
  expect(profiles.map((profile) => profile.id)).toEqual(ids);
  expect(profiles.every(isTurtleProfile)).toBe(true);

  const command = commandProfiles(authoredProfiles);
  const manifest = command.manifest as {
    profiles: { id: string; sha256: string; file: string; binding?: unknown }[];
    canonical: {
      type: string;
      routes: { profile: string; shape: string; when: { path: string; value: string }[] }[];
    }[];
    bindingDemands: { type: string; profile: string }[];
  };
  for (const profile of profiles) {
    const baseline = original[profile.id as keyof typeof original];
    const published = manifest.profiles.find((entry) => entry.id === profile.id)!;
    const roles = profile.shapes.map((shape) => shape.iri.split('/').at(-1)!.slice(0, -6));
    expect(digest(profileSource(profile))).toBe(baseline.sha256);
    expect(profileSource(profile)).toBe(
      readFileSync(join(root, 'model/definitions', profile.id + '.ttl'), 'utf8'),
    );
    expect(published.sha256).toBe(baseline.sha256);
    expect(command.shapes.get(published.file)).toBe(profileSource(profile));
    expect(roles).toEqual(baseline.roles);
    expect(profile.shapes.map((shape) => shape.iri)).toEqual(
      baseline.roles.map((role) => shapeIri(profile.id, role)),
    );
    const canonical = Object.fromEntries(
      profile.shapes.flatMap((shape) => shape.canonical
        ? [[shape.iri.split('/').at(-1)!.slice(0, -6), shape.canonical]]
        : []),
    );
    expect(canonical).toEqual(baseline.canonical);
    expect(profile.binding).toBeUndefined();
    expect(published.binding).toBeUndefined();
  }
  expect(STRUCTURE_ROLES).toEqual([
    'rv:GroupRole', 'rv:ChapterRole', 'rv:MemberRole', 'rv:MountRole',
    'rv:NavigationRole', 'rv:IngredientRole', 'rv:StepRole', 'rv:EquipmentRole',
  ]);
  expect(manifest.bindingDemands.filter((demand) => ids.includes(demand.profile))).toEqual([]);

  const routes = manifest.canonical.flatMap((entry) =>
    entry.routes.filter((route) => ids.includes(route.profile)),
  ).map(({ profile, shape, when }) => ({ profile, shape, when }));
  const declaredRoutes = profiles.flatMap((profile) => profile.shapes.flatMap((shape) => {
    if (!shape.canonical) return [];
    const prefixes = new Map(profile.prefixes);
    return shape.canonical.types.map((type) => ({
      profile: profile.id,
      shape: shape.iri,
      when: (shape.canonical?.when ?? []).map((condition) => ({
        path: expand(condition.path, prefixes),
        value: expand(condition.value, prefixes),
      })),
    }));
  }));
  const sorted = (items: typeof routes) =>
    [...items].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  expect(sorted(routes)).toEqual(sorted(declaredRoutes));
});

test('Work metadata retains mandatory MainVersion, release and metadata-kind bounds', async () => {
  const workV1 = {
    '@id': 'urn:work:metadata-v1',
    'rdf:type': [schema + 'CreativeWork'],
    'rv:mainVersion': ['urn:main:v1'],
    'rv:continuityProfile': ['urn:continuity:v1'],
    'rv:scalarValue': ['urn:scalar:value'],
  };
  expect(await accepts('work-metadata-v1', 'work', workV1)).toBe(true);
  expect(await accepts('work-metadata-v1', 'work', {
    ...workV1, 'rv:mainVersion': [],
  })).toBe(false);

  const workV2 = {
    ...workV1,
    '@id': 'urn:work:metadata-v2',
    'rv:release': ['urn:release:1'],
  };
  expect(await accepts('work-metadata-v2', 'work', workV2)).toBe(true);
  expect(await accepts('work-metadata-v2', 'work', {
    ...workV2, 'rv:release': Array.from({ length: 65 }, (_, index) => 'urn:release:' + index),
  })).toBe(false);

  const mainVersion = {
    '@id': 'urn:main:v1',
    'rdf:type': [vocab('MainVersion')],
    'rv:work': ['urn:work:metadata-v1'],
    'rv:hostingPolicy': [vocab('MetadataOnly')],
  };
  expect(await accepts('work-metadata-v1', 'main-version', mainVersion)).toBe(true);
  expect(await accepts('work-metadata-v1', 'main-version', {
    ...mainVersion, 'rv:hostingPolicy': [vocab('VirtualHosted')],
  })).toBe(false);

  const metadataComponent = {
    '@id': 'urn:metadata:edition',
    'rdf:type': [vocab('WorkMetadataComponent')],
    'rv:work': ['urn:work:metadata-v1'],
    'rv:metadataKind': ['edition'],
    'rv:metadataHead': ['urn:metadata:revision'],
    'rv:editionState': [vocab('Active')],
    'rv:editionLanguage': ['en'],
  };
  expect(await accepts('work-metadata-details-v1', 'component', metadataComponent)).toBe(true);
  expect(await accepts('work-metadata-details-v1', 'component', {
    ...metadataComponent, 'rv:metadataKind': ['abstract'],
  })).toBe(false);

  const editionRecord = {
    '@id': 'urn:metadata:edition-v2',
    'rdf:type': [vocab('EditionRecord')],
    'rv:work': ['urn:work:metadata-v1'],
    'rv:metadataKind': ['edition'],
    'rv:metadataHead': ['urn:metadata:revision-v2'],
    'rv:editionState': [vocab('Active')],
    'rv:editionLanguage': ['en'],
    'rv:contentLanguages': ['en,fr'],
    'rv:isTranslation': ['true'],
  };
  expect(await accepts('work-metadata-details-v2', 'component', editionRecord)).toBe(true);
  expect(await accepts('work-metadata-details-v2', 'component', {
    ...editionRecord, 'rv:contentLanguages': ['x'.repeat(401)],
  })).toBe(false);
});

test('Native child ownership and Structure parent shapes retain cardinality and order constraints', async () => {
  const child = {
    '@id': 'urn:child:author',
    'rdf:type': [vocab('NativeChild')],
    'rv:childRevision': ['urn:child:revision'],
    'rv:work': ['urn:work:parent'],
    'rv:childField': ['authors'],
    'rv:sourceKey': ['/authors/OL1A'],
    'schema:position': [0],
    'rv:editControl': [vocab('HumanConfirmed')],
    'rv:rightsStatus': [vocab('Undetermined')],
  };
  expect(await accepts('work-native-child-v1', 'child', child)).toBe(true);
  expect(await accepts('work-native-child-v1', 'child', {
    ...child, 'rv:work': [],
  })).toBe(false);
  expect(await accepts('work-native-child-v1', 'child', {
    ...child, 'rv:work': ['urn:work:parent', 'urn:work:other'],
  })).toBe(false);
  expect(await accepts('work-native-child-v1', 'child', {
    ...child, 'schema:position': [128],
  })).toBe(false);

  const childRevision = {
    '@id': 'urn:child:revision',
    'rdf:type': [vocab('NativeChildRevision'), vocab('RevisionAnchor')],
    'rv:component': ['urn:child:author'],
    'rv:workRevision': ['urn:work:revision'],
    'rv:confirmedBy': ['urn:agent:editor'],
    'rv:modelRevision': [definition + 'work-native-child-v1'],
    'rv:shapeRevision': [definition + 'work-native-child-v1'],
    'rv:dataEpoch': ['epoch-1'],
    'rv:sequence': [1],
    'rv:work': ['urn:work:parent'],
    'rv:childField': ['authors'],
    'rv:sourceKey': ['/authors/OL1A'],
    'schema:position': [0],
    'rv:editControl': [vocab('HumanConfirmed')],
    'rv:rightsStatus': [vocab('Undetermined')],
  };
  expect(await accepts('work-native-child-v1', 'revision', childRevision)).toBe(true);
  expect(await accepts('work-native-child-v1', 'revision', {
    ...childRevision, 'rv:predecessor': ['urn:child:previous'],
  })).toBe(false);

  const structure = {
    '@id': 'urn:structure:book',
    'rdf:type': [vocab('Structure')],
    'rv:structureOf': ['urn:work:book'],
    'rv:structureProfile': [vocab('BookComposition')],
    'rv:structureHead': ['urn:structure:revision'],
    'rv:selectedGeneration': ['urn:structure:generation'],
  };
  expect(await accepts('structure-composition-v1', 'structure', structure)).toBe(true);
  expect(await accepts('structure-composition-v1', 'structure', {
    ...structure, 'rv:structureOf': ['urn:work:book', 'urn:work:other'],
  })).toBe(false);

  const segment = {
    '@id': 'urn:structure:segment',
    'rdf:type': [vocab('OrderSegment')],
    'rv:generation': ['urn:structure:generation'],
    'rv:parent': ['urn:structure:root'],
    'rv:segmentKey': ['a1-b2'],
    'rv:memberCount': [2],
  };
  expect(await accepts('structure-composition-v1', 'segment', segment)).toBe(true);
  expect(await accepts('structure-composition-v1', 'segment', {
    ...segment, 'rv:parent': [],
  })).toBe(false);

  const occurrence = {
    '@id': 'urn:structure:occurrence',
    'rdf:type': [schema + 'ListItem'],
    'rv:structure': ['urn:structure:book'],
    'rv:introducedBy': ['urn:structure:revision'],
  };
  expect(await accepts('structure-composition-v1', 'occurrence', occurrence)).toBe(true);
  expect(await accepts('structure-composition-v1', 'occurrence', {
    ...occurrence, 'rv:introducedBy': [],
  })).toBe(false);
});
