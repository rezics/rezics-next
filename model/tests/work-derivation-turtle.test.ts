import { afterAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { TSchema } from 'typebox';
import { Value } from 'typebox/value';
import { authoredProfiles, commandProfiles, discoverProfiles } from '../compiler/generate.ts';
import { renderProfile, type PropertyDefinition } from '../compiler/ir.ts';
import { buildModelOutputs } from '../compiler/outputs.ts';
import { profileSource } from '../compiler/shacl.ts';
import * as workDerivation from '../definitions/work-derivation-v1.ts';
import * as unresolvedWorkDerivation from '../definitions/work-derivation-unresolved-v1.ts';
import * as workTitleControl from '../definitions/work-title-control-v1.ts';

const root = resolve(import.meta.dir, '../..');
const rv = 'https://rezics.com/vocab/';
const definition = 'https://rezics.com/definition/';
const ids = [
  'work-derivation-unresolved-v1',
  'work-derivation-v1',
  'work-title-control-v1',
];
const modules = [
  ['work-derivation-unresolved-v1.ts', unresolvedWorkDerivation],
  ['work-derivation-v1.ts', workDerivation],
  ['work-title-control-v1.ts', workTitleControl],
] as const;
const profiles = authoredProfiles.filter((profile) => ids.includes(profile.id));
const options = { established: {}, canonicalOrder: [], demandOrder: [] };
const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

function directory(): string {
  mkdirSync(join(root, '.temp'), { recursive: true });
  const path = mkdtempSync(join(root, '.temp/work-derivation-turtle-'));
  temporary.push(path);
  return path;
}

const digest = (source: string) => createHash('sha256').update(source).digest('hex');
const normalize = (properties: readonly PropertyDefinition[]) =>
  properties
    .map((property) =>
      Object.fromEntries(Object.entries(property).sort(([a], [b]) => a.localeCompare(b))),
    )
    .sort((a, b) => String(a.path).localeCompare(String(b.path)));

const original = {
  'work-derivation-unresolved-v1': {
    source: '6c703f04dde8586aa0d5fbb5601fc532c0d572c2097eb18e927e4b601f8f71d2',
    count: 17,
    constraints: '3ae9c5948cfe144910914307ae0bdf887ff13d27fd9fdf10499805cfaa88f122',
    roles: ['derivation'],
    comments: [
      'One explicitly declared derivation of a target Work revision whose source version is not yet known.',
      'The source names a Work, optionally its Main Version, without an exact revision; it is never an exact declaration.',
      'A later exact declaration resolves it through rv:corrects; this relation stays unchanged and readable.',
    ],
    canonical: { types: ['rv:UnresolvedWorkDerivation'] },
    binding: {
      required: ['derivation', 'target-work', 'target-main', 'target-revision', 'source-work',
        'kind', 'evidence', 'actor', 'receipt', 'scope', 'epoch'],
      optional: ['source-main'],
      roles: ['derivation'],
      demandedBy: ['rv:UnresolvedWorkDerivation'],
    },
  },
  'work-derivation-v1': {
    source: 'b86e60ef69cf6a20088119dbb582154c7f27cbf30f1a8334869603e49b0dea1b',
    count: 15,
    constraints: 'a695eac5bd07f706b1626af10065a51f1ecb990ce2eb90619417733713eea5ce',
    roles: ['derivation'],
    comments: [
      'One explicitly declared derivation of a separately maintained target Work revision.',
      'The source is an exact retained Main Version revision; names and bodies do not establish continuity.',
      'The relation does not transfer rights, authority, ratings, or future revisions.',
    ],
    canonical: { types: ['rv:WorkDerivation'] },
    binding: {
      required: ['derivation', 'target-work', 'target-main', 'target-revision', 'source-work',
        'source-main', 'source-revision', 'kind', 'evidence', 'actor', 'receipt', 'scope', 'epoch'],
      roles: ['derivation'],
      demandedBy: ['rv:WorkDerivation'],
    },
  },
  'work-title-control-v1': {
    source: '100dddad43cac4fd47c3090e987ef9dc9aa272d189fc4240cc08302340c5d42d',
    count: 14,
    constraints: '3c87f610514d9864f09b0fdd1f52440b1023901aebde123d7799abae7c3363e4',
    roles: ['control'],
    comments: ['One native Work English title control epoch. No generic protection or source rights claim.'],
    canonical: { types: ['rv:EditorialControlRevision'] },
  },
} as const;

const outputs = buildModelOutputs(profiles);
let schemaPromise: Promise<Record<string, TSchema>> | undefined;
function schemas(): Promise<Record<string, TSchema>> {
  if (!schemaPromise) {
    const path = join(directory(), 'schemas.ts');
    writeFileSync(path, outputs.get('packages/model/src/generated/schemas.ts')!);
    schemaPromise = import(path).then((module) => module.shapeSchemas as Record<string, TSchema>);
  }
  return schemaPromise;
}
async function accepts(id: string, role: string, value: Record<string, unknown>): Promise<boolean> {
  const shape = (await schemas())[`${definition}${id}/${role}-shape`];
  return Value.Check(shape, value);
}

const titleControl = () => ({
  '@id': 'urn:work:title-control',
  'rdf:type': [`${rv}EditorialControlRevision`, `${rv}RevisionAnchor`],
  'rv:component': ['urn:work:target'],
  'rv:controlField': ['title:en'],
  'rv:controlMode': [`${rv}HumanControlled`],
  'rv:controlEpoch': [1],
  'rv:workRevision': ['urn:work:revision'],
  'rv:operation': ['urn:operation:title-control'],
  'rv:controlIntent': ['Set the English title.'],
  'rv:manifest': ['urn:manifest:title-control'],
  'rv:modelRevision': [`${definition}work-title-control-v1`],
  'rv:shapeRevision': [`${definition}work-title-control-v1`],
  'rv:dataEpoch': ['epoch-1'],
  'rv:sequence': [1],
});

const exactDerivation = () => ({
  '@id': 'urn:work:derivation',
  'rdf:type': [`${rv}WorkDerivation`],
  'rv:targetWork': ['urn:work:target'],
  'rv:targetMainVersion': ['urn:work:target-main'],
  'rv:targetMainRevision': ['urn:work:target-revision'],
  'rv:sourceWork': ['urn:work:source'],
  'rv:sourceMainVersion': ['urn:work:source-main'],
  'rv:sourceMainRevision': ['urn:work:source-revision'],
  'rv:derivationKind': [`${rv}Adaptation`],
  'rv:evidence': ['https://publisher.example/translation'],
  'rv:linkedBy': ['urn:actor:editor'],
  'rv:modelRevision': [`${definition}work-derivation-v1`],
  'rv:shapeRevision': [`${definition}work-derivation-v1`],
  'rv:datasetId': ['urn:rezics:dataset:product'],
  'rv:dataEpoch': ['01234567-89ab-cdef-0123-456789abcdef'],
  'rv:sequence': [1],
});

const unresolvedDerivation = () => ({
  '@id': 'urn:work:unresolved-derivation',
  'rdf:type': [`${rv}UnresolvedWorkDerivation`],
  'rv:targetWork': ['urn:work:target'],
  'rv:targetMainVersion': ['urn:work:target-main'],
  'rv:targetMainRevision': ['urn:work:target-revision'],
  'rv:sourceWork': ['urn:work:source'],
  'rv:sourceVersionStatus': [`${rv}Unresolved`],
  'rv:derivationKind': [`${rv}SoftwareFork`],
  'rv:evidence': ['https://publisher.example/project'],
  'rv:linkedBy': ['urn:actor:editor'],
  'rv:modelRevision': [`${definition}work-derivation-unresolved-v1`],
  'rv:shapeRevision': [`${definition}work-derivation-unresolved-v1`],
  'rv:datasetId': ['urn:rezics:dataset:product'],
  'rv:dataEpoch': ['01234567-89ab-cdef-0123-456789abcdef'],
  'rv:sequence': [1],
});

test('Turtle profiles preserve every constraint, focus role, command declaration and historical byte pin', () => {
  expect(profiles.map((profile) => profile.id)).toEqual(ids);
  expect(workTitleControl.workTitleControlProfile.id).toBe('work-title-control-v1');
  expect(workDerivation.workDerivationProfile.id).toBe('work-derivation-v1');
  expect(unresolvedWorkDerivation.workDerivationUnresolvedProfile.id)
    .toBe('work-derivation-unresolved-v1');
  const command = commandProfiles(profiles, options);
  const manifest = command.manifest as {
    profiles: { id: string; sha256: string; file: string; binding?: unknown }[];
    canonical: { type: string; routes: { profile: string; shape: string; when: unknown[] }[] }[];
    bindingDemands: { type: string; profile: string }[];
  };

  for (const profile of profiles) {
    const baseline = original[profile.id as keyof typeof original];
    const shape = profile.shapes[0]!;
    expect(profile.shapes.map((item) => item.iri)).toEqual(
      baseline.roles.map((role) => `${definition}${profile.id}/${role}-shape`),
    );
    expect(shape.properties).toHaveLength(baseline.count);
    expect(digest(JSON.stringify(normalize(shape.properties)))).toBe(baseline.constraints);
    expect(shape.canonical).toEqual(baseline.canonical);
    if ('binding' in baseline) expect(profile.binding).toEqual(baseline.binding);
    else expect(profile.binding).toBeUndefined();

    const published = manifest.profiles.find((item) => item.id === profile.id)!;
    const publishedSource = command.shapes.get(published.file)!;
    expect(profileSource(profile)).toBe(publishedSource);
    expect(published.sha256).toBe(digest(publishedSource));
    expect(published.sha256).not.toBe(baseline.source);
    const historical = { ...profile, comments: [...baseline.comments] };
    expect(digest(renderProfile(historical))).toBe(baseline.source);
  }

  expect(command.profiles.map((item) => [item.id, item.focusRoles])).toEqual([
    ['work-derivation-unresolved-v1', ['derivation']],
    ['work-derivation-v1', ['derivation']],
    ['work-title-control-v1', ['control']],
  ]);
  expect(manifest.profiles.find((item) => item.id === 'work-derivation-v1')?.binding).toEqual({
    required: original['work-derivation-v1'].binding.required,
    optional: [],
    roles: ['derivation'],
  });
  expect(manifest.profiles.find((item) => item.id === 'work-derivation-unresolved-v1')?.binding)
    .toEqual({
      required: original['work-derivation-unresolved-v1'].binding.required,
      optional: ['source-main'],
      roles: ['derivation'],
    });
  expect(manifest.canonical).toEqual(expect.arrayContaining([
    {
      type: `${rv}EditorialControlRevision`,
      routes: [{
        profile: 'work-title-control-v1',
        shape: `${definition}work-title-control-v1/control-shape`,
        when: [],
      }],
    },
    {
      type: `${rv}WorkDerivation`,
      routes: [{
        profile: 'work-derivation-v1',
        shape: `${definition}work-derivation-v1/derivation-shape`,
        when: [],
      }],
    },
    {
      type: `${rv}UnresolvedWorkDerivation`,
      routes: [{
        profile: 'work-derivation-unresolved-v1',
        shape: `${definition}work-derivation-unresolved-v1/derivation-shape`,
        when: [],
      }],
    },
  ]));
  expect(manifest.bindingDemands).toEqual(expect.arrayContaining([
    { type: `${rv}WorkDerivation`, profile: 'work-derivation-v1' },
    { type: `${rv}UnresolvedWorkDerivation`, profile: 'work-derivation-unresolved-v1' },
  ]));
});

test('title control Turtle rejects malformed field, cardinality, epoch and bounded intent values', async () => {
  const valid = titleControl();
  expect(await accepts('work-title-control-v1', 'control', valid)).toBe(true);
  for (const value of [
    { ...valid, 'rv:controlField': ['title:ja'] },
    { ...valid, 'rv:controlEpoch': [0] },
    { ...valid, 'rv:sequence': [-1] },
    { ...valid, 'rv:controlIntent': ['x'.repeat(8001)] },
    { ...valid, 'rv:controlMode': [`${rv}SourceManaged`, `${rv}HumanControlled`] },
    { ...valid, 'rv:modelRevision': ['urn:work:wrong-revision'] },
    { ...valid, 'rdf:type': [`${rv}EditorialControlRevision`] },
  ])
    expect(await accepts('work-title-control-v1', 'control', value)).toBe(false);
});

test('exact derivation Turtle rejects malformed kind, evidence, dataset and revision values', async () => {
  const valid = exactDerivation();
  expect(await accepts('work-derivation-v1', 'derivation', valid)).toBe(true);
  for (const value of [
    { ...valid, 'rv:derivationKind': [`${rv}Translation`] },
    { ...valid, 'rv:evidence': ['http://publisher.example/translation'] },
    { ...valid, 'rv:evidence': ['https://publisher.example/with space'] },
    { ...valid, 'rv:datasetId': ['urn:rezics:dataset:staging'] },
    { ...valid, 'rv:dataEpoch': ['01234567-89ab-cdef-0123-456789ABCDEf'] },
    { ...valid, 'rv:sequence': [0] },
    { ...valid, 'rv:sourceMainRevision': [] },
  ])
    expect(await accepts('work-derivation-v1', 'derivation', value)).toBe(false);
});

test('unresolved derivation Turtle rejects exact-source revisions and malformed evidence metadata', async () => {
  const valid = unresolvedDerivation();
  expect(await accepts('work-derivation-unresolved-v1', 'derivation', valid)).toBe(true);
  for (const value of [
    { ...valid, 'rv:sourceMainRevision': ['urn:work:source-revision'] },
    { ...valid, 'rv:sourceVersionStatus': [`${rv}Exact`] },
    { ...valid, 'rv:derivationKind': [`${rv}Adaptation`, `${rv}SoftwareFork`] },
    { ...valid, 'rv:evidence': ['https://'] },
    { ...valid, 'rv:corrects': ['urn:correction:one', 'urn:correction:two'] },
    { ...valid, 'rv:dataEpoch': ['not-an-epoch'] },
  ])
    expect(await accepts('work-derivation-unresolved-v1', 'derivation', value)).toBe(false);
});

test('Turtle discovery keeps profile exports only when their bytes match the authored source', () => {
  const path = directory();
  for (const id of ids)
    writeFileSync(
      join(path, `${id}.ttl`),
      readFileSync(join(root, `model/definitions/${id}.ttl`), 'utf8'),
    );
  expect(discoverProfiles(path, modules).map((profile) => profile.id)).toEqual(ids);

  const sourcePath = join(path, 'work-derivation-unresolved-v1.ttl');
  writeFileSync(sourcePath, `${readFileSync(sourcePath, 'utf8')}\n# changed bytes\n`);
  expect(() => discoverProfiles(path, modules)).toThrow('Duplicate profile ID work-derivation-unresolved-v1');
});
