import { afterAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { TSchema } from 'typebox';
import { Value } from 'typebox/value';
import { DataFactory, Parser, Store } from 'n3';
import { authoredProfiles, commandProfiles } from '../compiler/generate.ts';
import { buildModelOutputs } from '../compiler/outputs.ts';
import { profileWorkTypes } from '../compiler/type.ts';
import { isTurtleProfile, profileSource } from '../compiler/shacl.ts';
import { workKindV2Profile } from '../definitions/work-kind-v2.ts';
import { workTypeV2Profile } from '../definitions/work-type-v2.ts';
import { workKindProfile } from '../definitions/work-kind-v1.ts';
import { workTypeProfile } from '../definitions/work-type-v1.ts';

const root = resolve(import.meta.dir, '../..');
const rv = 'https://rezics.com/vocab/';
const schema = 'https://schema.org/';
const definition = 'https://rezics.com/definition/';
const ids = [
  'work-kind-v1',
  'work-kind-v2',
  'work-kind-v3',
  'work-type-v1',
  'work-type-v2',
  'work-type-v3',
];
const profiles = authoredProfiles.filter((profile) => ids.includes(profile.id));
const outputs = buildModelOutputs(profiles);
const temporary: string[] = [];
afterAll(() => {
  for (const path of temporary) rmSync(path, { recursive: true, force: true });
});

const digest = (source: string) => createHash('sha256').update(source).digest('hex');
function directory(): string {
  mkdirSync(join(root, '.temp'), { recursive: true });
  const path = mkdtempSync(join(root, '.temp/work-kind-type-turtle-'));
  temporary.push(path);
  return path;
}
const original = {
  'work-kind-v1': {
    sha256: 'd1cfc2074299ba294307ed19b97c2641dd0197b759f06a43eb376584cbe2d1d2',
    roles: ['work'],
  },
  'work-kind-v2': {
    sha256: '83d22b37af19ca88386aa6767c96f94537e64614979b84db72fe9264dbdb1009',
    roles: ['work'],
  },
  'work-kind-v3': {
    sha256: '08d0d5879c1810708f0bbd7eb1bd0ecc0a14c124cddfe202c66dd236e3b59f90',
    roles: ['work'],
  },
  'work-type-v3': {
    sha256: '86360e7c7ec939c8ce2283b16e2ae825113f07132eef4891e48e174c72d9a718',
    roles: ['work', 'work-revision'],
  },
  'work-type-v1': {
    sha256: 'e8ad5bd6e3e4bb4754e530c53f4caa5b60ec6e064e0d7b4a66bcdd23c7d7c6a4',
    roles: ['work', 'work-revision'],
  },
  'work-type-v2': {
    sha256: '94ef660d31ca8af44f51d5ecc6ad767ea97c6c39d1dcbf7db4321b1152632b2f',
    roles: ['work', 'work-revision'],
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
  const shape = (await schemas())[definition + id + '/' + role + '-shape']!;
  return Value.Check(shape, value);
}

test('All six Work Turtle profiles preserve source pins, focus roles and the imported type registry', () => {
  expect(profiles.map((profile) => profile.id)).toEqual(ids);
  const command = commandProfiles(authoredProfiles);
  const manifest = command.manifest as {
    profiles: { id: string; binding?: unknown }[];
    canonical: { routes: { profile: string }[] }[];
    bindingDemands: { profile: string }[];
  };
  for (const profile of profiles) {
    const baseline = original[profile.id as keyof typeof original];
    const entry = command.profiles.find((candidate) => candidate.id === profile.id)!;
    expect(isTurtleProfile(profile)).toBe(true);
    expect(digest(profileSource(profile))).toBe(baseline.sha256);
    expect(entry.sha256).toBe(baseline.sha256);
    expect(command.shapes.get(entry.file)).toBe(profileSource(profile));
    expect(entry.shapes).toEqual(
      baseline.roles.map((role) => definition + profile.id + '/' + role + '-shape'),
    );
    expect(profile.shapes.map((shape) => shape.iri.split('/').at(-1)!.slice(0, -6))).toEqual([
      ...baseline.roles,
    ]);
    expect(profile.shapes.every((shape) => shape.canonical === undefined)).toBe(true);
    expect(profile.binding).toBeUndefined();
    expect(
      manifest.profiles.find((candidate) => candidate.id === profile.id)!.binding,
    ).toBeUndefined();
  }
  expect(
    manifest.canonical
      .flatMap((entry) => entry.routes)
      .filter((route) => ids.includes(route.profile)),
  ).toEqual([]);
  expect(manifest.bindingDemands.filter((demand) => ids.includes(demand.profile))).toEqual([]);

  expect(workKindProfile.id).toBe('work-kind-v1');
  expect(workTypeProfile.id).toBe('work-type-v1');
  expect(workKindV2Profile.id).toBe('work-kind-v2');
  expect(workTypeV2Profile.id).toBe('work-type-v2');
  const admittedKinds = profileWorkTypes(workKindV2Profile);
  const editableTypes = profileWorkTypes(workTypeV2Profile);
  expect(admittedKinds).toContain(schema + 'BookSeries');
  expect(admittedKinds).toContain(schema + 'VideoGame');
  expect(editableTypes).toContain(schema + 'VideoGame');
  expect(editableTypes).not.toContain(schema + 'BookSeries');
  expect(digest(readFileSync(join(root, 'packages/model/src/generated/types.ts'), 'utf8'))).toBe(
    '21979e70a03a6950adae46170c7fdf75833a715b73ce92cb7c4e08c8bb5c60ab',
  );
});

test('Work kind and type Turtle graph constraints and TypeBox retain revision-specific type sets', async () => {
  const work = (types: string[]) => ({
    '@id': 'urn:work:test',
    'rdf:type': types,
    'rv:mainVersion': ['urn:work:main'],
  });
  const creativeWork = schema + 'CreativeWork';
  for (const id of ids) {
    const cases: [string[], boolean][] = [
      [[creativeWork], true],
      [[creativeWork, schema + 'Book'], true],
      [[schema + 'Book'], false],
      [[], false],
      [[creativeWork, schema + 'VideoGame'], !id.endsWith('v1')],
      [[creativeWork, schema + 'BookSeries'], id.startsWith('work-kind') || id.endsWith('v3')],
      [[creativeWork, 'urn:descriptive:unregistered'], id.endsWith('v3')],
      [[creativeWork, schema + 'Book', schema + 'Recipe', schema + 'DigitalDocument'], true],
      [
        [
          creativeWork,
          schema + 'Book',
          schema + 'Recipe',
          schema + 'DigitalDocument',
          rv + 'SkillPackage',
        ],
        false,
      ],
    ];
    const graph = new Store(
      new Parser().parse(profileSource(profiles.find((profile) => profile.id === id)!)),
    );
    const sh = 'http://www.w3.org/ns/shacl#';
    const rdf = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
    const typeProperty = graph
      .getObjects(definition + id + '/work-shape', sh + 'property', null)
      .find(
        (property) => graph.getObjects(property, sh + 'path', null)[0]?.value === rdf + 'type',
      )!;
    const fixed = graph.getObjects(typeProperty, sh + 'hasValue', null)[0]!;
    const minimum = Number(graph.getObjects(typeProperty, sh + 'minCount', null)[0]!.value);
    const maximum = Number(graph.getObjects(typeProperty, sh + 'maxCount', null)[0]!.value);
    let head = graph.getObjects(typeProperty, sh + 'in', null)[0];
    const enumeration: ReturnType<typeof graph.getObjects> = [];
    while (head && head.value !== rdf + 'nil') {
      enumeration.push(graph.getObjects(head, rdf + 'first', null)[0]!);
      head = graph.getObjects(head, rdf + 'rest', null)[0]!;
    }
    expect(enumeration.length > 0).toBe(!id.endsWith('v3'));
    for (const [types, expected] of cases) {
      const terms = types.map((type) => DataFactory.namedNode(type));
      const graphConforms =
        terms.length >= minimum &&
        terms.length <= maximum &&
        terms.some((term) => term.equals(fixed)) &&
        (!enumeration.length ||
          terms.every((term) => enumeration.some((member) => member.equals(term))));
      expect(graphConforms).toBe(expected);
      expect(await accepts(id, 'work', work(types))).toBe(expected);
    }
    expect(await accepts(id, 'work', { ...work([creativeWork]), 'rv:mainVersion': [] })).toBe(
      false,
    );
    expect(
      await accepts(id, 'work', {
        ...work([creativeWork]),
        'rv:mainVersion': ['urn:one', 'urn:two'],
      }),
    ).toBe(false);
    expect(await accepts(id, 'work', work([creativeWork, creativeWork]))).toBe(false);
    expect(await accepts(id, 'work', work(['CreativeWork']))).toBe(false);
    const property = profiles.find((profile) => profile.id === id)!.shapes[0]!.properties[0]!;
    expect(property.hasValue).toBe('schema:CreativeWork');
    expect(property.in?.length ?? 0).toBe(enumeration.length);
  }
});

test('All Work type revisions retain their metadata identity, required references and sequence bounds', async () => {
  const revision = {
    '@id': 'urn:work:type-revision',
    'rdf:type': [rv + 'RevisionAnchor'],
    'rv:component': ['urn:work:test'],
    'rv:operation': ['urn:operation:retype'],
    'rv:manifest': ['urn:manifest:type'],
    'rv:modelRevision': [definition + 'work-metadata-v1'],
    'rv:shapeRevision': [definition + 'work-metadata-v1'],
    'rv:datasetId': ['urn:rezics:dataset:product'],
    'rv:dataEpoch': ['epoch-1'],
    'rv:sequence': [1],
  };
  for (const id of ids.filter((profile) => profile.startsWith('work-type'))) {
    expect(await accepts(id, 'work-revision', revision)).toBe(true);
    for (const change of [
      { 'rv:sequence': [0] },
      { 'rv:sequence': ['1'] },
      { 'rv:component': [] },
      { 'rdf:type': [schema + 'CreativeWork'] },
      { 'rv:modelRevision': [definition + id] },
      { 'rv:shapeRevision': [definition + id] },
      { 'rv:datasetId': ['urn:one', 'urn:two'] },
      { 'rv:dataEpoch': [null] },
    ])
      expect(await accepts(id, 'work-revision', { ...revision, ...change })).toBe(false);
  }
});
