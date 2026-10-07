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
import { parseTurtleProfile, profileSource } from '../compiler/shacl.ts';
import * as claimDeclaration from '../definitions/work-address-claim-v1.ts';
import * as dispositionDeclaration from '../definitions/work-address-disposition-v1.ts';
import * as lifecycleDeclaration from '../definitions/work-address-lifecycle-v1.ts';
import * as creditDeclaration from '../definitions/work-author-credit-v1.ts';

const root = resolve(import.meta.dir, '../..');
const rv = 'https://rezics.com/vocab/';
const definition = 'https://rezics.com/definition/';
const authorComment = '\n# Authored SHACL constraints for Work addresses and author credits.\n';
const ids = [
  'work-address-claim-v1',
  'work-address-disposition-v1',
  'work-address-lifecycle-v1',
  'work-author-credit-v1',
];
const profiles = authoredProfiles.filter((profile) => ids.includes(profile.id));
const modules = [
  ['work-address-claim-v1.ts', claimDeclaration],
  ['work-address-disposition-v1.ts', dispositionDeclaration],
  ['work-address-lifecycle-v1.ts', lifecycleDeclaration],
  ['work-author-credit-v1.ts', creditDeclaration],
] as const;
const options = { canonicalOrder: [], demandOrder: [] };
const temporary: string[] = [];
afterAll(() => {
  for (const path of temporary) rmSync(path, { recursive: true, force: true });
});
function directory(): string {
  mkdirSync(join(root, '.temp'), { recursive: true });
  const path = mkdtempSync(join(root, '.temp/work-address-turtle-'));
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
// Recorded before moving graph constraints and their registry metadata to Turtle companions.
const original = {
  'work-address-claim-v1': {
    source: '0447720e2e33c0f1a71259488f1710c0c837039a1a4f1931c8c1bed92f2848df',
    constraints: 'bc0e4993ce622db01b0ebd3c216a210cb209b486928bf750be332f312461dc36',
    roles: ['binding', 'revision'],
    counts: [6, 6],
  },
  'work-address-disposition-v1': {
    source: '30c4d9f8e3926e197186dbd3e0a9b6392db661fcd590251d3cee660880ab071c',
    constraints: '281713004559a9c57df31ff8b1cb50a121370ba2979632453fede1b2ab806068',
    roles: ['merged-route', 'retired-route', 'merged-revision', 'retired-revision'],
    counts: [8, 8, 10, 10],
  },
  'work-address-lifecycle-v1': {
    source: '54a6ba17ab7e5e9a70f7e1a4c6cc8e854692b1946f5a24247db3f47ef070634f',
    constraints: 'd6bafdc822dcb5dfb945d3d3beff8b91ad1bef4814c04d99ffbecfd2da75da5b',
    roles: ['redirect', 'revision'],
    counts: [7, 10],
  },
  'work-author-credit-v1': {
    source: '369b1c406b627053c612fff0c97fe18353e633df2b8128746cb4463273369281',
    constraints: '7c480c1edf72a33e052be8a0c27d16ae42f8915742d564acd58fca53cbea70c8',
    roles: ['credit', 'revision'],
    counts: [13, 20],
  },
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
function route(
  state: 'Current' | 'Redirected' | 'Retired',
  disposition?: 'Merged' | 'Retired',
): Record<string, unknown> {
  return {
    '@id': 'urn:work:route',
    'rdf:type': [`${rv}RouteBinding`],
    'rv:routeNamespace': ['work'],
    'rv:normalizedSlug': ['rain-night'],
    'rv:targetWork': ['urn:work:original'],
    'rv:routeState': [`${rv}${state}`],
    'rv:routeRevision': ['urn:work:route-revision'],
    ...(state === 'Redirected' ? { 'rv:redirectWork': ['urn:work:destination'] } : {}),
    ...(disposition ? { 'rv:routeDisposition': [`${rv}${disposition}`] } : {}),
  };
}
function addressRevision(
  state: 'Current' | 'Redirected' | 'Retired',
  disposition?: 'Merged' | 'Retired',
): Record<string, unknown> {
  return {
    '@id': 'urn:work:route-revision',
    'rdf:type': [`${rv}RevisionAnchor`],
    'rv:component': ['urn:work:route'],
    'rv:targetWork': ['urn:work:original'],
    'rv:normalizedSlug': ['rain-night'],
    'rv:modelRevision': ['urn:work:model'],
    'rv:shapeRevision': ['urn:work:shape'],
    ...(state !== 'Current'
      ? { 'rv:previousRevision': ['urn:work:previous'], 'rv:routeState': [`${rv}${state}`] }
      : {}),
    ...(state === 'Redirected' ? { 'rv:redirectWork': ['urn:work:destination'] } : {}),
    ...(disposition ? { 'rv:routeDisposition': [`${rv}${disposition}`] } : {}),
    ...(state === 'Redirected' && !disposition ? { 'rv:routeChangeKind': [`${rv}Renamed`] } : {}),
  };
}
const commonCredit = () => ({
  'rv:work': ['urn:work:credited'],
  'schema:roleName': ['author'],
  'rv:externalProvider': ['open-library'],
  'rv:externalNamespace': ['author'],
  'rv:externalKey': ['/authors/OL1A'],
  'schema:position': [0],
  'rv:editControl': [`${rv}HumanConfirmed`],
  'rv:rightsStatus': [`${rv}Undetermined`],
});
const credit = () => ({
  '@id': 'urn:work:credit',
  'rdf:type': [`${rv}AuthorCredit`],
  'rv:creditRevision': ['urn:work:credit-revision'],
  ...commonCredit(),
});
const creditRevision = () => ({
  '@id': 'urn:work:credit-revision',
  'rdf:type': [`${rv}AuthorCreditRevision`, `${rv}RevisionAnchor`],
  'rv:component': ['urn:work:credit'],
  'rv:confirmedBy': ['urn:work:actor'],
  'rv:workRevision': ['urn:work:revision'],
  'rv:modelRevision': [`${definition}work-author-credit-v1`],
  'rv:shapeRevision': [`${definition}work-author-credit-v1`],
  'rv:dataEpoch': ['00000000-0000-4000-8000-000000000001'],
  'rv:sequence': [1],
  ...commonCredit(),
});

test('Work address and credit discovery preserves 98 constraints, ten roles and command registry behavior', () => {
  const path = directory();
  for (const id of ids)
    writeFileSync(
      join(path, `${id}.ttl`),
      readFileSync(join(root, `model/definitions/${id}.ttl`), 'utf8'),
    );
  const discovered = discoverProfiles(path, modules);
  expect(discovered.map((profile) => profile.id)).toEqual(ids);
  expect(profiles.map((profile) => profile.id)).toEqual(ids);
  expect(discovered.flatMap((profile) => profile.shapes)).toHaveLength(10);
  expect(
    discovered.flatMap((profile) => profile.shapes.flatMap((shape) => shape.properties)),
  ).toHaveLength(98);
  const published = commandProfiles(discovered, options);
  for (const profile of discovered) {
    const baseline = original[profile.id as keyof typeof original];
    expect(digest(constraints(profile))).toBe(baseline.constraints);
    expect(profile.shapes.map((shape) => shape.iri)).toEqual(
      baseline.roles.map((role) => `${definition}${profile.id}/${role}-shape`),
    );
    expect(profile.shapes.map((shape) => shape.properties.length)).toEqual([...baseline.counts]);
    const entry = published.profiles.find((item) => item.id === profile.id)!;
    expect(entry.focusRoles).toEqual([...baseline.roles]);
    expect(entry.sha256).toBe(digest(profileSource(profile)));
    expect(entry.sha256).not.toBe(baseline.source);
    expect(published.shapes.get(entry.file)).toBe(profileSource(profile));
    // Exact constraints without a companion declaration cannot acquire fallback metadata.
    expect(commandProfiles([parseTurtleProfile(profile.id, profileSource(profile))], options).manifest).toEqual({
      profiles: [{ id: profile.id, sha256: digest(profileSource(profile)), file: `shapes/${profile.id}.ttl` }],
      canonical: [], bindingDemands: [],
    });
  }
  const registry = selectedRegistry(commandProfiles(authoredProfiles).manifest);
  expect(digest(JSON.stringify(registry))).toBe(
    'b6cc426b72e60d3e3c53e1586c3ab58c4927f33bbf64fa76b51f70be8145ea92',
  );
  expect(selectedRegistry(published.manifest)).toEqual(registry);
  for (const [, module] of modules) {
    expect(Object.keys(module)).toHaveLength(1);
    for (const [name, declaration] of Object.entries(module)) {
      expect(name.endsWith('Declaration')).toBe(true);
      expect(Object.keys(declaration).sort()).toEqual(
        name === 'workAuthorCreditDeclaration'
          ? ['binding', 'canonical', 'id']
          : ['canonical', 'id'],
      );
    }
  }
});

test('RouteBinding canonical discriminators preserve merged, retired, redirect and current priority', () => {
  const registry = selectedRegistry(commandProfiles(authoredProfiles).manifest);
  const routes = registry.canonical.find((entry) => entry.type === `${rv}RouteBinding`)!.routes;
  expect(routes).toEqual([
    {
      profile: 'work-address-disposition-v1',
      shape: `${definition}work-address-disposition-v1/merged-route-shape`,
      when: [
        { path: `${rv}routeState`, value: `${rv}Redirected` },
        { path: `${rv}routeDisposition`, value: `${rv}Merged` },
      ],
    },
    {
      profile: 'work-address-disposition-v1',
      shape: `${definition}work-address-disposition-v1/retired-route-shape`,
      when: [{ path: `${rv}routeState`, value: `${rv}Retired` }],
    },
    {
      profile: 'work-address-lifecycle-v1',
      shape: `${definition}work-address-lifecycle-v1/redirect-shape`,
      when: [{ path: `${rv}routeState`, value: `${rv}Redirected` }],
    },
    {
      profile: 'work-address-claim-v1',
      shape: `${definition}work-address-claim-v1/binding-shape`,
      when: [],
    },
  ]);
  expect(registry.canonical.filter((entry) => entry.type !== `${rv}RouteBinding`)).toEqual([
    {
      type: `${rv}AuthorCredit`,
      routes: [
        {
          profile: 'work-author-credit-v1',
          shape: `${definition}work-author-credit-v1/credit-shape`,
          when: [],
        },
      ],
    },
    {
      type: `${rv}AuthorCreditRevision`,
      routes: [
        {
          profile: 'work-author-credit-v1',
          shape: `${definition}work-author-credit-v1/revision-shape`,
          when: [],
        },
      ],
    },
  ]);
  expect(
    registry.profiles.find((profile) => profile.id === 'work-author-credit-v1')!.binding,
  ).toEqual({
    required: [
      'credit',
      'revision',
      'work',
      'work-head',
      'key',
      'ordinal',
      'actor',
      'receipt',
      'scope',
      'epoch',
      'intent',
    ],
    optional: ['source-role'],
    roles: ['credit', 'revision'],
  });
  expect(registry.bindingDemands).toEqual([
    { type: `${rv}AuthorCredit`, profile: 'work-author-credit-v1' },
    { type: `${rv}AuthorCreditRevision`, profile: 'work-author-credit-v1' },
  ]);
});

test('Work address author reload leaves original pinned bytes, registries and record digests exact', () => {
  const path = directory();
  const historicalProfiles = profiles.map((profile) => {
    const source = profileSource(profile);
    expect(source.endsWith(authorComment)).toBe(true);
    const pinnedBytes = source.slice(0, -authorComment.length);
    expect(digest(pinnedBytes)).toBe(original[profile.id as keyof typeof original].source);
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
    revision: 'urn:work:retained-revision',
  }));
  const retained = structuredClone({
    manifest: historical.manifest,
    profiles: historical.profiles,
    shapes: [...historical.shapes],
    records,
  });
  const before = commandProfiles(profiles, options);
  for (const profile of profiles)
    writeFileSync(
      join(path, `${profile.id}.ttl`),
      `${profileSource(profile)}\n# Author byte reload.\n`,
    );
  const reloaded = discoverProfiles(path, modules);
  const after = commandProfiles(reloaded, options);
  for (const [index, profile] of profiles.entries()) {
    expect(after.profiles[index]!.sha256).not.toBe(before.profiles[index]!.sha256);
    expect(after.profiles[index]!.sha256).toBe(digest(profileSource(reloaded[index]!)));
    expect(constraints(reloaded[index]!)).toBe(constraints(profile));
    expect(historical.profiles[index]!.sha256).toBe(
      original[profile.id as keyof typeof original].source,
    );
    expect(digest(historical.shapes.get(historical.profiles[index]!.file)!)).toBe(
      historical.profiles[index]!.sha256,
    );
  }
  expect(selectedRegistry(after.manifest)).toEqual(selectedRegistry(before.manifest));
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

test('Work routes retain normalized slugs, literal namespace and exact state/disposition requirements', async () => {
  const candidates = [
    ['work-address-claim-v1', 'binding', route('Current')],
    ['work-address-claim-v1', 'revision', addressRevision('Current')],
    ['work-address-lifecycle-v1', 'redirect', route('Redirected')],
    ['work-address-lifecycle-v1', 'revision', addressRevision('Redirected')],
    ['work-address-disposition-v1', 'merged-route', route('Redirected', 'Merged')],
    ['work-address-disposition-v1', 'merged-revision', addressRevision('Redirected', 'Merged')],
    ['work-address-disposition-v1', 'retired-route', route('Retired', 'Retired')],
    ['work-address-disposition-v1', 'retired-revision', addressRevision('Retired', 'Retired')],
  ] as const;
  for (const [id, role, valid] of candidates) {
    expect(await accepts(id, role, valid)).toBe(true);
    for (const slug of ['a', '0', 'rain-night-2', 'a'.repeat(64)])
      expect(await accepts(id, role, { ...valid, 'rv:normalizedSlug': [slug] })).toBe(true);
    for (const value of [
      [''],
      ['a'.repeat(65)],
      ['Rain'],
      ['-rain'],
      ['rain-'],
      ['rain--night'],
      ['rain_night'],
      ['rain night'],
      ['雨'],
      [null],
      [],
      null,
      'rain',
    ])
      expect(await accepts(id, role, { ...valid, 'rv:normalizedSlug': value })).toBe(false);
    if (role === 'binding' || role === 'redirect' || role.endsWith('-route')) {
      for (const value of [[`${rv}work`], ['Work'], ['author'], [], null, 'work'])
        expect(await accepts(id, role, { ...valid, 'rv:routeNamespace': value })).toBe(false);
    }
    if (role === 'binding') {
      expect(await accepts(id, role, { ...valid, 'rv:routeState': [`${rv}Redirected`] })).toBe(
        false,
      );
      expect(await accepts(id, role, { ...valid, 'rv:routeState': ['Current'] })).toBe(false);
    } else if (id !== 'work-address-claim-v1') {
      for (const value of [[`${rv}Current`], [null], [], null])
        expect(await accepts(id, role, { ...valid, 'rv:routeState': value })).toBe(false);
    }
    if (role.startsWith('merged-') || role.startsWith('retired-'))
      expect(
        await accepts(id, role, {
          ...valid,
          'rv:routeDisposition': [`${rv}${role.startsWith('merged-') ? 'Retired' : 'Merged'}`],
        }),
      ).toBe(false);
  }
});

test('Work redirects require one destination and retirements prohibit destination values', async () => {
  for (const [id, role, valid] of [
    ['work-address-lifecycle-v1', 'redirect', route('Redirected')],
    ['work-address-lifecycle-v1', 'revision', addressRevision('Redirected')],
    ['work-address-disposition-v1', 'merged-route', route('Redirected', 'Merged')],
    ['work-address-disposition-v1', 'merged-revision', addressRevision('Redirected', 'Merged')],
  ] as const) {
    const { 'rv:redirectWork': omitted, ...withoutDestination } = valid;
    expect(omitted).toEqual(['urn:work:destination']);
    expect(await accepts(id, role, withoutDestination)).toBe(false);
    for (const value of [
      [],
      ['urn:work:1', 'urn:work:2'],
      [null],
      [1],
      [{ '@id': 'urn:work:destination' }],
      null,
      'urn:work:destination',
    ])
      expect(await accepts(id, role, { ...valid, 'rv:redirectWork': value })).toBe(false);
  }
  for (const [role, valid] of [
    ['retired-route', route('Retired', 'Retired')],
    ['retired-revision', addressRevision('Retired', 'Retired')],
  ] as const) {
    expect(await accepts('work-address-disposition-v1', role, valid)).toBe(true);
    expect(
      await accepts('work-address-disposition-v1', role, { ...valid, 'rv:redirectWork': [] }),
    ).toBe(true);
    for (const value of [['urn:work:destination'], [null], null])
      expect(
        await accepts('work-address-disposition-v1', role, { ...valid, 'rv:redirectWork': value }),
      ).toBe(false);
  }
});

test('author credit literals, source keys and positions retain exact types and bounds', async () => {
  const id = 'work-author-credit-v1';
  for (const [role, valid] of [
    ['credit', credit()],
    ['revision', creditRevision()],
  ] as const) {
    expect(await accepts(id, role, valid)).toBe(true);
    for (const position of [0, 127])
      expect(await accepts(id, role, { ...valid, 'schema:position': [position] })).toBe(true);
    for (const value of [[-1], [128], [1.5], ['0'], [null], [], null, 0])
      expect(await accepts(id, role, { ...valid, 'schema:position': value })).toBe(false);
    for (const [path, value] of [
      ['schema:roleName', `${rv}author`],
      ['schema:roleName', 'translator'],
      ['rv:externalProvider', `${rv}open-library`],
      ['rv:externalProvider', 'wikidata'],
      ['rv:externalNamespace', `${rv}author`],
      ['rv:externalNamespace', 'work'],
      ['rv:externalKey', '/authors/OL0A'],
      ['rv:externalKey', '/authors/OL1W'],
      ['rv:externalKey', 'OL1A'],
      ['rv:externalKey', '/authors/OL1234567890123A'],
      ['rv:sourceRoleKey', 'x'.repeat(201)],
    ] as const)
      expect(await accepts(id, role, { ...valid, [path]: [value] })).toBe(false);
    expect(
      await accepts(id, role, { ...valid, 'rv:externalKey': ['/authors/OL123456789012A'] }),
    ).toBe(true);
    expect(await accepts(id, role, { ...valid, 'rv:sourceRoleKey': ['x'.repeat(200)] })).toBe(true);
    for (const path of ['rv:agent', 'schema:author']) {
      expect(await accepts(id, role, { ...valid, [path]: [] })).toBe(true);
      for (const value of [['urn:work:native-agent'], [null], null])
        expect(await accepts(id, role, { ...valid, [path]: value })).toBe(false);
    }
  }
});

test('author credit revision requires both distinct IRI types, a positive integer sequence and no predecessor', async () => {
  const id = 'work-author-credit-v1';
  const valid = creditRevision();
  expect(
    await accepts(id, 'revision', {
      ...valid,
      'rdf:type': [`${rv}RevisionAnchor`, `${rv}AuthorCreditRevision`],
    }),
  ).toBe(true);
  for (const value of [
    [`${rv}AuthorCreditRevision`],
    [`${rv}RevisionAnchor`],
    [`${rv}AuthorCreditRevision`, `${rv}AuthorCreditRevision`],
    ['rv:AuthorCreditRevision', 'rv:RevisionAnchor'],
    [`${rv}AuthorCreditRevision`, `${rv}RevisionAnchor`, `${rv}AuthorCredit`],
    [null],
    null,
  ])
    expect(await accepts(id, 'revision', { ...valid, 'rdf:type': value })).toBe(false);
  for (const value of [1, 1000])
    expect(await accepts(id, 'revision', { ...valid, 'rv:sequence': [value] })).toBe(true);
  for (const value of [[0], [-1], [1.5], ['1'], [null], [], null, 1])
    expect(await accepts(id, 'revision', { ...valid, 'rv:sequence': value })).toBe(false);
  expect(await accepts(id, 'revision', { ...valid, 'rv:predecessor': [] })).toBe(true);
  for (const value of [['urn:work:previous-credit'], [null], null])
    expect(await accepts(id, 'revision', { ...valid, 'rv:predecessor': value })).toBe(false);
  expect(
    await accepts(id, 'revision', { ...valid, 'rv:modelRevision': ['work-author-credit-v1'] }),
  ).toBe(false);
});

test('Work address and author credit contexts preserve literal, IRI and integer envelopes', () => {
  for (const id of ids) {
    const context = JSON.parse(outputs.get(`generated/model/contexts/${id}.jsonld`)!)['@context'];
    if (id === 'work-author-credit-v1') {
      for (const path of [
        'schema:roleName',
        'rv:externalProvider',
        'rv:externalNamespace',
        'rv:externalKey',
      ])
        expect(context[path]['@type']).toBeUndefined();
      expect(context['schema:position']['@type']).toBe('xsd:integer');
      expect(context['rv:sequence']['@type']).toBe('xsd:integer');
      expect(context['rdf:type']['@type']).toBe('@id');
      expect(context['rv:work']['@type']).toBe('@id');
    } else {
      if (context['rv:routeNamespace'])
        expect(context['rv:routeNamespace']['@type']).toBeUndefined();
      expect(context['rv:normalizedSlug']['@type']).toBeUndefined();
      expect(context['rv:targetWork']['@type']).toBe('@id');
      expect(context['rv:routeState']['@type']).toBe('@id');
    }
  }
});

test('address and credit conversion preserves every previously authored Turtle file byte-for-byte', () => {
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
    'work-reference-block-v1': 'c72c3a6b828632aeddc1a3078dead4dd0dfd0f989fca550530ad850dbcb9b9a0',
  };
  for (const [id, hash] of Object.entries(earlierAuthors))
    expect(digest(readFileSync(join(root, `model/definitions/${id}.ttl`), 'utf8'))).toBe(hash);
});
