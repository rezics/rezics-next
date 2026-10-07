import { afterAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { TSchema } from 'typebox';
import { Value } from 'typebox/value';
import { authoredProfiles, commandProfiles } from '../compiler/generate.ts';
import { buildModelOutputs } from '../compiler/outputs.ts';
import { profileWorkTypes } from '../compiler/type.ts';
import { isTurtleProfile, profileSource } from '../compiler/shacl.ts';
import { workKindV2Profile } from '../definitions/work-kind-v2.ts';
import { workTypeV2Profile } from '../definitions/work-type-v2.ts';

const root = resolve(import.meta.dir, '../..');
const rv = 'https://rezics.com/vocab/';
const schema = 'https://schema.org/';
const definition = 'https://rezics.com/definition/';
const ids = ['work-kind-v3', 'work-type-v3'];
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
  'work-kind-v3': {
    sha256: '08d0d5879c1810708f0bbd7eb1bd0ecc0a14c124cddfe202c66dd236e3b59f90',
    roles: ['work'],
  },
  'work-type-v3': {
    sha256: '86360e7c7ec939c8ce2283b16e2ae825113f07132eef4891e48e174c72d9a718',
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

test('Work v3 Turtle profiles preserve source pins, focus roles and the imported type registry', () => {
  expect(profiles.map((profile) => profile.id)).toEqual(ids);
  const command = commandProfiles(authoredProfiles);
  for (const profile of profiles) {
    const baseline = original[profile.id as keyof typeof original];
    const entry = command.profiles.find((candidate) => candidate.id === profile.id)!;
    expect(isTurtleProfile(profile)).toBe(true);
    expect(digest(profileSource(profile))).toBe(baseline.sha256);
    expect(entry.sha256).toBe(baseline.sha256);
    expect(command.shapes.get(entry.file)).toBe(profileSource(profile));
    expect(profile.shapes.map((shape) => shape.iri.split('/').at(-1)!.slice(0, -6)))
      .toEqual(baseline.roles);
    expect(profile.shapes.every((shape) => shape.canonical === undefined)).toBe(true);
    expect(profile.binding).toBeUndefined();
  }

  expect(workKindV2Profile.id).toBe('work-kind-v2');
  expect(workTypeV2Profile.id).toBe('work-type-v2');
  const admittedKinds = profileWorkTypes(workKindV2Profile);
  const editableTypes = profileWorkTypes(workTypeV2Profile);
  expect(admittedKinds).toContain(schema + 'BookSeries');
  expect(admittedKinds).toContain(schema + 'VideoGame');
  expect(editableTypes).toContain(schema + 'VideoGame');
  expect(editableTypes).not.toContain(schema + 'BookSeries');
  expect(digest(readFileSync(join(root, 'packages/model/src/generated/types.ts'), 'utf8')))
    .toBe('21979e70a03a6950adae46170c7fdf75833a715b73ce92cb7c4e08c8bb5c60ab');
});

test('Work kind and type values still require the CreativeWork base and preserve revision bounds', async () => {
  const work = (types: string[]) => ({
    '@id': 'urn:work:test',
    'rdf:type': types,
    'rv:mainVersion': ['urn:work:main'],
  });
  const creativeWork = schema + 'CreativeWork';
  for (const [id, extraType] of [
    ['work-kind-v3', schema + 'Book'],
    ['work-type-v3', schema + 'VideoGame'],
  ]) {
    expect(await accepts(id, 'work', work([creativeWork, extraType]))).toBe(true);
    expect(await accepts(id, 'work', work([extraType]))).toBe(false);
    expect(await accepts(id, 'work', { ...work([creativeWork, extraType]), 'rv:mainVersion': [] }))
      .toBe(false);
  }

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
  expect(await accepts('work-type-v3', 'work-revision', revision)).toBe(true);
  expect(await accepts('work-type-v3', 'work-revision', {
    ...revision, 'rv:sequence': [0],
  })).toBe(false);
});
