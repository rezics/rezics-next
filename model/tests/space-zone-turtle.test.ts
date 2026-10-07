import { afterAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { TSchema } from 'typebox';
import { Value } from 'typebox/value';
import { authoredProfiles, commandProfiles, discoverProfiles } from '../compiler/generate.ts';
import type { ProfileDefinition, PropertyDefinition } from '../compiler/ir.ts';
import { buildModelOutputs } from '../compiler/outputs.ts';
import {
  establishedDeclarations,
  type RegistryBinding,
  type RegistryRoute,
} from '../compiler/registry.ts';
import { isTurtleProfile, parseTurtleProfile, profileSource } from '../compiler/shacl.ts';
import * as spaceV1 from '../definitions/space-realm-v1.ts';
import * as spaceV2 from '../definitions/space-realm-v2.ts';
import * as spaceV3 from '../definitions/space-realm-v3.ts';
import * as capability from '../definitions/zone-capability-v1.ts';
import * as presentationV1 from '../definitions/zone-presentation-v1.ts';
import * as presentationV2 from '../definitions/zone-presentation-v2.ts';

const root = resolve(import.meta.dir, '../..');
const rv = 'https://rezics.com/vocab/';
const definition = 'https://rezics.com/definition/';
const authorComment = '\n# Authored SHACL constraints for Space, Realm and Zone capabilities.\n';
const ids = [
  'space-realm-v1',
  'space-realm-v2',
  'space-realm-v3',
  'zone-capability-v1',
  'zone-presentation-v1',
  'zone-presentation-v2',
];
const profiles = authoredProfiles.filter((profile) => ids.includes(profile.id));
const modules = [
  ['space-realm-v1.ts', spaceV1],
  ['space-realm-v2.ts', spaceV2],
  ['space-realm-v3.ts', spaceV3],
  ['zone-capability-v1.ts', capability],
  ['zone-presentation-v1.ts', presentationV1],
  ['zone-presentation-v2.ts', presentationV2],
] as const;
const declarations = modules.map(
  ([file, module]) =>
    [
      file,
      Object.fromEntries(Object.entries(module).filter(([name]) => name.endsWith('Declaration'))),
    ] as const,
);
const options = { established: {}, canonicalOrder: [], demandOrder: [] };
const temporary: string[] = [];
afterAll(() => {
  for (const path of temporary) rmSync(path, { recursive: true, force: true });
});
function directory(): string {
  mkdirSync(join(root, '.temp'), { recursive: true });
  const path = mkdtempSync(join(root, '.temp/space-zone-turtle-'));
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
// Accepted bytes and graph constraints recorded before the six author-source conversions.
const original = {
  'space-realm-v1': [
    '74a39bad65c0fd259f557146bed386843c5919fac3491b7503032d1ce9e370c2',
    'ea5fd5964fe789fcdb0e11b39230f7efe09d07c1045e7408d4ee92d2b1181f78',
  ],
  'space-realm-v2': [
    '6bcaa955e1c473f450b97d2d50afad3205d0136447b7dd11e30650a888045185',
    '0f7c1bb98a74ff1ac1397384eb98550296e89178cd91766cc7ca068e767c7640',
  ],
  'space-realm-v3': [
    '6009918e574419975be06974d6e02987158ae58c7f8c539140c20f171ce3f26d',
    '7353be59e0a551f753c1f9cef80eedd7f70ac3c0150e1f0ef0d48ee2e0775baa',
  ],
  'zone-capability-v1': [
    'c518389e8a7777b2358a5ed98f6016e77a803aa8c9336fefc40201fb38df4f65',
    'd8be0c6514f06a3a28ec37a6a503a47d0e450547a93fd7a3fad506c99ee5fa5b',
  ],
  'zone-presentation-v1': [
    '3d63c448965591516514a0323e77500e3a8b0d95da0a2c0abdd2af4110e063e2',
    '8863445647c89f51d9b0720f99fd3b9878b4bd894fb9ae4461c6dc8e2978956f',
  ],
  'zone-presentation-v2': [
    'c10111526ef6933baceda2e8a598b5df59d1c834800550df201dfe1172b6ede8',
    'd3edb6c98911a727654a2a82ec86b4142398f9c06da183ec2363d3ea453fff0f',
  ],
} as const;
const roles = (id: string) =>
  id.startsWith('space-')
    ? ['space', 'realm']
    : id === 'zone-capability-v1'
      ? ['navigation-link', 'zone', 'mount', 'revision']
      : ['zone'];
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
function space(id: string): Record<string, unknown> {
  return {
    '@id': 'urn:space:one',
    'rdf:type': [`${rv}Space`],
    'rv:owner': ['urn:space:owner'],
    'rv:realmCapability': ['urn:space:realm'],
    ...(id !== 'space-realm-v1' ? { 'rv:definitionProfile': [`${definition}${id}`] } : {}),
    ...(id === 'space-realm-v3'
      ? { 'rdfs:label': [{ '@value': '雨夜', '@language': 'zh-Hant' }] }
      : {}),
  };
}
function realm(id: string): Record<string, unknown> {
  return {
    '@id': 'urn:space:realm',
    'rdf:type': [`${rv}Realm`],
    'rv:space': ['urn:space:one'],
    'rv:realmState': [`${rv}Active`],
    'rv:selectionPolicy': [`${definition}realm-manager-fixed-main-fallback-v1`],
    'rv:membershipPolicy': [`${definition}realm-closed-v1`],
    'rv:reviewPolicy': [`${definition}realm-manager-reviewed-v1`],
    ...(id !== 'space-realm-v1' ? { 'rv:definitionProfile': [`${definition}${id}`] } : {}),
  };
}
const zone = () => ({
  '@id': 'urn:zone:one',
  'rdf:type': [`${rv}Zone`],
  'rv:space': ['urn:space:one'],
  'rv:zoneState': [`${rv}Active`],
  'rv:zoneHead': ['urn:zone:revision'],
  'rv:disclosure': [`${rv}Public`],
});
const epoch = 'abcdef01-2345-4000-8000-abcdef012345';
const revision = () => ({
  '@id': 'urn:zone:revision',
  'rdf:type': [`${rv}ZoneRevision`, `${rv}RevisionAnchor`],
  'rv:component': ['urn:zone:one'],
  'rv:operation': ['urn:zone:operation'],
  'rv:zoneOperation': [`${rv}ZoneCreate`],
  'rv:manifest': ['urn:zone:manifest'],
  'rv:modelRevision': [`${definition}zone-capability-v1`],
  'rv:shapeRevision': [`${definition}zone-capability-v1`],
  'rv:datasetId': ['urn:rezics:dataset:product'],
  'rv:dataEpoch': [epoch],
  'rv:sequence': [1],
});

test('Space Realm and Zone discovery emits six profiles once, preserving 81 properties and twelve roles', () => {
  const path = directory();
  for (const id of ids)
    writeFileSync(
      join(path, `${id}.ttl`),
      readFileSync(join(root, `model/definitions/${id}.ttl`), 'utf8'),
    );
  const discovered = discoverProfiles(path, modules);
  expect(discovered.map((profile) => profile.id)).toEqual(ids);
  expect(profiles.map((profile) => profile.id)).toEqual(ids);
  expect(discovered.flatMap((profile) => profile.shapes)).toHaveLength(12);
  expect(
    discovered.flatMap((profile) => profile.shapes.flatMap((shape) => shape.properties)),
  ).toHaveLength(81);
  const published = commandProfiles(discovered, options);
  for (const profile of discovered) {
    expect(digest(constraints(profile))).toBe(original[profile.id as keyof typeof original][1]);
    const expectedRoles = roles(profile.id);
    expect(profile.shapes.map((shape) => shape.iri)).toEqual(
      expectedRoles.map((role) => `${definition}${profile.id}/${role}-shape`),
    );
    const entry = published.profiles.find((item) => item.id === profile.id)!;
    expect(entry.focusRoles).toEqual(expectedRoles);
    expect(entry.sha256).toBe(digest(profileSource(profile)));
    expect(entry.sha256).not.toBe(original[profile.id as keyof typeof original][0]);
    expect(published.shapes.get(entry.file)).toBe(profileSource(profile));
  }
  for (const [file, module] of modules) {
    const exported = Object.entries(module).filter(([name]) => name.endsWith('Profile'));
    expect(exported).toHaveLength(1);
    const profile = exported[0]![1] as ProfileDefinition;
    expect(isTurtleProfile(profile)).toBe(true);
    expect(String(file)).toBe(`${profile.id}.ts`);
    expect(profileSource(profile)).toBe(readFileSync(join(path, `${profile.id}.ttl`), 'utf8'));
    expect(digest(constraints(profile))).toBe(original[profile.id as keyof typeof original][1]);
    expect(Object.entries(module).filter(([name]) => name.endsWith('Declaration'))).toHaveLength(1);
  }
  expect(establishedDeclarations['space-realm-v1']).toBeUndefined();
  const registry = selectedRegistry(commandProfiles(authoredProfiles).manifest);
  expect(digest(JSON.stringify(registry))).toBe(
    '975c03f2144abb28e3145c6eab3c9a2ac99b8925c2013228d5bbc046a2552990',
  );
  // Standalone registries order types lexically; full registry preserves historical type precedence.
  const isolated = selectedRegistry(published.manifest);
  expect(isolated.profiles).toEqual(registry.profiles);
  expect(isolated.canonical.sort((a, b) => a.type.localeCompare(b.type))).toEqual(
    [...registry.canonical].sort((a, b) => a.type.localeCompare(b.type)),
  );
  expect(isolated.bindingDemands).toEqual(registry.bindingDemands);
});

test('Space versions preserve discriminator priority and presentation versions retain separate named exports', () => {
  const registry = selectedRegistry(commandProfiles(authoredProfiles).manifest);
  for (const [type, role] of [
    ['Space', 'space'],
    ['Realm', 'realm'],
  ] as const) {
    const routes = registry.canonical.find((entry) => entry.type === `${rv}${type}`)!.routes;
    expect(routes).toEqual(
      ['v2', 'v3', 'v1'].map((version) => ({
        profile: `space-realm-${version}`,
        shape: `${definition}space-realm-${version}/${role}-shape`,
        when:
          version === 'v1'
            ? []
            : [{ path: `${rv}definitionProfile`, value: `${definition}space-realm-${version}` }],
      })),
    );
  }
  expect(presentationV1.zonePresentationProfile.id).toBe('zone-presentation-v1');
  expect(presentationV2.zonePresentationProfile.id).toBe('zone-presentation-v2');
  expect(presentationV1.zonePresentationProfile).not.toBe(presentationV2.zonePresentationProfile);
  for (const id of ids) {
    const profile = profiles.find((item) => item.id === id)!;
    expect(profile.shapes.every((shape) => shape.iri.startsWith(`${definition}${id}/`))).toBe(true);
  }
});

test('Space Realm and Zone historical pins remain exact across current author-byte reloads', () => {
  const path = directory();
  const historicalProfiles = profiles.map((profile) => {
    const source = profileSource(profile);
    expect(source.endsWith(authorComment)).toBe(true);
    const pinnedBytes = source.slice(0, -authorComment.length);
    expect(digest(pinnedBytes)).toBe(original[profile.id as keyof typeof original][0]);
    const canonical = Object.fromEntries(
      profile.shapes
        .filter((shape) => shape.canonical)
        .map((shape) => [shape.iri.split('/').at(-1)!.slice(0, -6), shape.canonical!]),
    );
    return parseTurtleProfile(profile.id, pinnedBytes, {
      id: profile.id,
      canonical,
      ...(profile.binding ? { binding: profile.binding } : {}),
    });
  });
  const historical = commandProfiles(historicalProfiles, options);
  const records = historical.profiles.map((profile) => ({
    profile: profile.id,
    shapeSha256: profile.sha256,
    revision: 'urn:space:retained-revision',
  }));
  const retained = structuredClone({
    manifest: historical.manifest,
    profiles: historical.profiles,
    shapes: [...historical.shapes],
    records,
  });
  const current = commandProfiles(profiles, options);
  for (const profile of profiles)
    writeFileSync(
      join(path, `${profile.id}.ttl`),
      `${profileSource(profile)}\n# Author byte reload.\n`,
    );
  // A stale named export cannot claim to represent newly authored bytes.
  expect(() => discoverProfiles(path, modules)).toThrow('Duplicate profile ID');
  const reloaded = discoverProfiles(path, declarations);
  const changed = commandProfiles(reloaded, options);
  for (const [index, profile] of profiles.entries()) {
    expect(changed.profiles[index]!.sha256).not.toBe(current.profiles[index]!.sha256);
    expect(changed.profiles[index]!.sha256).toBe(digest(profileSource(reloaded[index]!)));
    expect(constraints(reloaded[index]!)).toBe(constraints(profile));
    expect(historical.profiles[index]!.sha256).toBe(
      original[profile.id as keyof typeof original][0],
    );
    expect(digest(historical.shapes.get(historical.profiles[index]!.file)!)).toBe(
      historical.profiles[index]!.sha256,
    );
  }
  expect(selectedRegistry(changed.manifest)).toEqual(selectedRegistry(current.manifest));
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

test('Space links and optional disclosure remain distinct from Realm literal settings and IRI policies', async () => {
  for (const id of ids.filter((value) => value.startsWith('space-'))) {
    const valid = space(id);
    expect(await accepts(id, 'space', valid)).toBe(true);
    for (const path of ['rv:owner', 'rv:realmCapability']) {
      const missing = { ...valid };
      delete missing[path];
      expect(await accepts(id, 'space', missing)).toBe(false);
      for (const value of [[], [null], [1], ['urn:space:1', 'urn:space:2'], null, 'urn:space:one'])
        expect(await accepts(id, 'space', { ...valid, [path]: value })).toBe(false);
    }
    for (const value of [[], [`${rv}Public`], [`${rv}Private`]])
      expect(await accepts(id, 'space', { ...valid, 'rv:disclosure': value })).toBe(true);
    for (const value of [['public'], [`${rv}Public`, `${rv}Private`], [null], null])
      expect(await accepts(id, 'space', { ...valid, 'rv:disclosure': value })).toBe(false);
    const policy = realm(id);
    expect(await accepts(id, 'realm', policy)).toBe(true);
    for (const visibility of ['public', 'restricted', 'private'])
      expect(await accepts(id, 'realm', { ...policy, 'rv:visibility': [visibility] })).toBe(true);
    for (const mode of ['mandatory', 'trusted-members', 'open'])
      expect(await accepts(id, 'realm', { ...policy, 'rv:reviewMode': [mode] })).toBe(true);
    for (const [path, value] of [
      ['rv:visibility', `${rv}public`],
      ['rv:reviewMode', `${rv}open`],
      ['rv:reviewPolicy', 'realm-manager-reviewed-v1'],
      ['rv:selectionPolicy', 'realm-manager-fixed-main-fallback-v1'],
      ['rv:membershipPolicy', 'realm-closed-v1'],
    ] as const)
      expect(await accepts(id, 'realm', { ...policy, [path]: [value] })).toBe(false);
    for (const path of ['rv:visibility', 'rv:reviewMode', 'rv:realmPolicyHead']) {
      expect(await accepts(id, 'realm', { ...policy, [path]: [] })).toBe(true);
      expect(await accepts(id, 'realm', { ...policy, [path]: null })).toBe(false);
    }
    // Required values with no maxCount retain SHACL's contains semantics.
    expect(
      await accepts(id, 'realm', { ...policy, 'rv:realmState': [`${rv}Active`, `${rv}Retired`] }),
    ).toBe(true);
    expect(
      await accepts(id, 'realm', {
        ...policy,
        'rv:selectionPolicy': [
          `${definition}realm-manager-fixed-main-fallback-v1`,
          'urn:policy:additional',
        ],
      }),
    ).toBe(true);
  }
});

test('Space v3 requires one language label while older versions and optional v2 topics remain unchanged', async () => {
  for (const id of ['space-realm-v1', 'space-realm-v2'])
    expect(await accepts(id, 'space', space(id))).toBe(true);
  const id = 'space-realm-v3';
  const valid = space(id);
  const { 'rdfs:label': omitted, ...withoutLabel } = valid;
  expect(omitted).toEqual([{ '@value': '雨夜', '@language': 'zh-Hant' }]);
  expect(await accepts(id, 'space', withoutLabel)).toBe(false);
  expect(
    await accepts(id, 'space', { ...valid, 'rdfs:label': [{ '@value': '', '@language': 'en' }] }),
  ).toBe(true);
  for (const value of [
    [],
    ['Rain'],
    [{ '@value': 'Rain' }],
    [{ '@value': 'Rain', '@language': 'en_US' }],
    [
      { '@value': 'Rain', '@language': 'en' },
      { '@value': '雨', '@language': 'zh' },
    ],
    null,
  ])
    expect(await accepts(id, 'space', { ...valid, 'rdfs:label': value })).toBe(false);
  for (const version of ['space-realm-v2', 'space-realm-v3']) {
    const policy = realm(version);
    for (const topics of [[], ['urn:topic:1', 'urn:topic:2', 'urn:topic:3']])
      expect(await accepts(version, 'realm', { ...policy, 'rv:topic': topics })).toBe(true);
    for (const topics of [
      ['urn:topic:1', 'urn:topic:2', 'urn:topic:3', 'urn:topic:4'],
      [null],
      [1],
      null,
      'urn:topic:1',
    ])
      expect(await accepts(version, 'realm', { ...policy, 'rv:topic': topics })).toBe(false);
    expect(await accepts(version, 'realm', { ...policy, 'rv:communityHandle': [''] })).toBe(true);
    expect(await accepts(version, 'realm', { ...policy, 'rv:communityHandle': [null] })).toBe(
      false,
    );
    for (const role of ['space', 'realm']) {
      const node = role === 'space' ? space(version) : policy;
      expect(
        await accepts(version, role, {
          ...node,
          'rv:definitionProfile': [
            `${definition}space-realm-${version.endsWith('v2') ? 'v3' : 'v2'}`,
          ],
        }),
      ).toBe(false);
    }
  }
});

test('Zone initial navigation and defaults remain optional while navigation-link focus requires one Structure reference', async () => {
  const id = 'zone-capability-v1';
  const valid = zone();
  expect(await accepts(id, 'zone', valid)).toBe(true);
  expect(await accepts(id, 'navigation-link', valid)).toBe(false);
  expect(
    await accepts(id, 'navigation-link', { ...valid, 'rv:navigation': ['urn:zone:navigation'] }),
  ).toBe(true);
  for (const path of [
    'rv:navigation',
    'rv:defaultRealm',
    'rv:defaultContext',
    'rv:defaultContextRevision',
    'rv:presentation',
  ]) {
    for (const value of [[], ['urn:zone:reference']])
      expect(await accepts(id, 'zone', { ...valid, [path]: value })).toBe(true);
    for (const value of [
      ['urn:zone:1', 'urn:zone:2'],
      [null],
      [{ '@id': 'urn:zone:reference' }],
      null,
      'urn:zone:reference',
    ])
      expect(await accepts(id, 'zone', { ...valid, [path]: value })).toBe(false);
  }
  for (const state of ['Active', 'Retired'])
    expect(await accepts(id, 'zone', { ...valid, 'rv:zoneState': [`${rv}${state}`] })).toBe(true);
  for (const value of [
    [],
    ['Active'],
    [`${rv}Unknown`],
    [`${rv}Active`, `${rv}Retired`],
    [null],
    null,
  ])
    expect(await accepts(id, 'zone', { ...valid, 'rv:zoneState': value })).toBe(false);
  for (const value of [[], [null], null])
    expect(await accepts(id, 'navigation-link', { ...valid, 'rv:navigation': value })).toBe(false);
});

test('Zone revisions require two distinct IRI types, known operation, UUID epoch and positive integer sequence', async () => {
  const id = 'zone-capability-v1';
  const valid = revision();
  expect(await accepts(id, 'revision', valid)).toBe(true);
  expect(
    await accepts(id, 'revision', {
      ...valid,
      'rdf:type': [`${rv}RevisionAnchor`, `${rv}ZoneRevision`],
    }),
  ).toBe(true);
  for (const operation of ['ZoneCreate', 'ZoneConfigure', 'ZoneRetire', 'ZoneRecover'])
    expect(
      await accepts(id, 'revision', { ...valid, 'rv:zoneOperation': [`${rv}${operation}`] }),
    ).toBe(true);
  for (const [path, value] of [
    ['rdf:type', [`${rv}ZoneRevision`]],
    ['rdf:type', [`${rv}ZoneRevision`, `${rv}ZoneRevision`]],
    ['rdf:type', [`${rv}ZoneRevision`, `${rv}RevisionAnchor`, `${rv}Zone`]],
    ['rv:zoneOperation', ['ZoneCreate']],
    ['rv:zoneOperation', [`${rv}ZoneUnknown`]],
    ['rv:zoneOperation', []],
    ['rv:dataEpoch', [epoch.toUpperCase()]],
    ['rv:dataEpoch', ['not-a-uuid']],
    ['rv:sequence', [0]],
    ['rv:sequence', [1.5]],
    ['rv:sequence', ['1']],
    ['rv:sequence', null],
    ['rv:sequence', 1],
    ['rv:modelRevision', ['zone-capability-v1']],
    ['rv:datasetId', ['product']],
  ] as const)
    expect(await accepts(id, 'revision', { ...valid, [path]: value })).toBe(false);
  for (const path of ['rv:predecessor', 'rv:advancedConfig']) {
    for (const value of [[], ['urn:zone:reference']])
      expect(await accepts(id, 'revision', { ...valid, [path]: value })).toBe(true);
    for (const value of [['urn:zone:1', 'urn:zone:2'], [null], null, 'urn:zone:reference'])
      expect(await accepts(id, 'revision', { ...valid, [path]: value })).toBe(false);
  }
});

test('Zone mount segments preserve lowercase bounds and presentation versions require their exact IRI', async () => {
  const mount = {
    '@id': 'urn:zone:mount',
    'rdf:type': [`${rv}ZoneMount`],
    'rv:zone': ['urn:zone:one'],
    'rv:routeSegment': ['rain-night'],
    'rv:disclosure': [`${rv}Private`],
  };
  for (const segment of ['a', '0', 'rain-night-2', 'a'.repeat(64)])
    expect(
      await accepts('zone-capability-v1', 'mount', { ...mount, 'rv:routeSegment': [segment] }),
    ).toBe(true);
  for (const value of [
    [''],
    ['a'.repeat(65)],
    ['Rain'],
    ['-rain'],
    ['rain--night'],
    ['rain_night'],
    [null],
    [],
    null,
    'rain',
  ])
    expect(
      await accepts('zone-capability-v1', 'mount', { ...mount, 'rv:routeSegment': value }),
    ).toBe(false);
  for (const id of ['zone-presentation-v1', 'zone-presentation-v2']) {
    const valid = {
      '@id': 'urn:zone:one',
      'rdf:type': [`${rv}Zone`],
      'rv:presentation': [`${definition}${id}`],
    };
    expect(await accepts(id, 'zone', valid)).toBe(true);
    for (const value of [
      [],
      [`${definition}zone-presentation-${id.endsWith('v1') ? 'v2' : 'v1'}`],
      [id],
      [null],
      null,
      `${definition}${id}`,
    ])
      expect(await accepts(id, 'zone', { ...valid, 'rv:presentation': value })).toBe(false);
  }
  const realmContext = JSON.parse(outputs.get('generated/model/contexts/space-realm-v3.jsonld')!)[
    '@context'
  ];
  expect(realmContext['rv:visibility']['@type']).toBeUndefined();
  expect(realmContext['rv:reviewMode']['@type']).toBeUndefined();
  expect(realmContext['rv:reviewPolicy']['@type']).toBe('@id');
  const zoneContext = JSON.parse(
    outputs.get('generated/model/contexts/zone-capability-v1.jsonld')!,
  )['@context'];
  expect(zoneContext['rv:sequence']['@type']).toBe('xsd:integer');
  expect(zoneContext['rv:zoneOperation']['@type']).toBe('@id');
});

test('Space Realm and Zone conversion preserves all thirty earlier authored Turtle byte digests', () => {
  const earlierAuthors = {
    'global-rating-standing-context-v1':
      'fffed312c16e43a3e6d8fdda5f3947cb2d1a97b36778b128b6ce4667a78db76a',
    'global-rating-standing-observation-v1':
      'dc2ad4e4ec21a66a78d1c416a4e8299e17a84e4530daccf330dbe3d3156ec9c9',
    'post-v1': 'aaa6e353c76cd215f5d64dbfcc0ae57846bb74e52f64e93582ffa6a1f27ec776',
    'realm-daily-rating-context-v1':
      '061f3a2c304b6d372c582af28facc91895ab2bfa1ca96da723dce737b484ca46',
    'realm-daily-rating-observation-v1':
      '514dbf814fef5943ad37da569c6768d2d94e2f48bcd4d5594b9efa26d4e67faf',
    'realm-experience-rating-context-v1':
      'e74ba4e6db85146ab55978ad43240b66a3eaaee088e8f56c84373604e4330569',
    'realm-experience-rating-observation-v1':
      'fe22f7a2143be4317ed09912ec3e4e799e525a30452df76c21d3d9a033093e65',
    'realm-release-rating-context-v1':
      'a3edcb7334d29b923da433d5295aebf30d23d6dde295ebae32280e4fba275d49',
    'realm-release-rating-observation-v1':
      'e1926bc5e8371333a5d32adf9ec4f9f03bc3e1cdb89e458e22006fa60775fecb',
    'realm-standing-rating-context-v1':
      '7bec3a7793417ef4138e54a6220ceaec7aa76e446df3a9fdadc9d1ba5cc35fab',
    'realm-standing-rating-observation-v1':
      'd824ac73cde5f8a3a67f83339c4a3db9b982a8223b04f2277981d6adba33caa4',
    'realm-target-rating-context-v1':
      '30f3b40be8bee4466305813e8487ad5baee5a8e0caf4ed1753df6c42b7cc1cf2',
    'realm-target-rating-context-v2':
      '29a8fe741508eb591b0348ecb88f76f9693ea15256783298d78cb75d5ff8f936',
    'realm-target-rating-context-v3':
      'a50948f15f468a27a6a68468c126d0a051cf703b1c4550ef7ff4f6e352c4c890',
    'realm-target-rating-context-v4':
      '86d150f2d1d56437e1843345d7dfa07ab2de6c134dff61e3314513296f73e32b',
    'realm-target-rating-observation-v1':
      '0169769b3c1179209e7205833b57b2dfb62c91603fc4efc098c0350d667e5d0c',
    'realm-target-rating-observation-v2':
      'dbfdb6259c310991d57b339854f8ac138f3b42c8acfba780d9d932bab411a341',
    'realm-target-rating-observation-v3':
      '4dc4a035b1dae7714d354e730617f1f649561e99a8a76eeb0afaed4a7b742c0e',
    'realm-target-rating-observation-v4':
      '670763404c8cd86a0629e4e55f35fb5b560e95ca00c1f7aaac52749dd4ee7386',
    'source-field-statement-v1': 'bc6c6397fb9ec6e4bf6bb44ffd933bf1abeaa7b83eb1939c57d32f438a2dcfb7',
    'source-open-library-work-v1':
      '460460ddffc2e3f6f8384402d54e521bef4f179b9ac6897fac98641acbc4390b',
    'source-reification-v1': '70f30519cefdb502ee86281b6edcdf18b7ced37209a90058113727abc521884c',
    'work-address-claim-v1': '17326364438e3f150c7ff8e02e37e51596bed52049282f7b40a120c520503617',
    'work-address-disposition-v1':
      '9c4f852c5ff565984ef8a1c228d2c580b58c98c8e397cfdfb5305800fdc676de',
    'work-address-lifecycle-v1': '4057be5cb9790c3aa94c846707224cbe7c211f1eb3b3f17f03ecb3b039715134',
    'work-author-credit-v1': '40f7566879e80c782d418972aec38b5c1699ee0727c8eb56c128b719c606eb4a',
    'work-derivation-unresolved-v1':
      'd47d816b777674c9142e2b7b3238f6728d4e89a072268a46acc0303cb992ad52',
    'work-derivation-v1': '27e4e0f2871f58bd1b7434dff809342721109220daec1b5b0f817da8abf176df',
    'work-reference-block-v1': 'c72c3a6b828632aeddc1a3078dead4dd0dfd0f989fca550530ad850dbcb9b9a0',
    'work-title-control-v1': '4b9028fab23fb2fa56e3be8ba4364cb15d0bcfdaaee646c868203fed48f26822',
  };
  expect(Object.keys(earlierAuthors)).toHaveLength(30);
  for (const [id, hash] of Object.entries(earlierAuthors))
    expect(digest(readFileSync(join(root, `model/definitions/${id}.ttl`), 'utf8'))).toBe(hash);
});
