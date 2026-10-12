import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { TSchema } from 'typebox';
import { Value } from 'typebox/value';
import { authoredProfiles, commandProfiles } from '../compiler/generate.ts';
import { buildModelOutputs } from '../compiler/outputs.ts';

const root = resolve(import.meta.dir, '../..');
const rv = 'https://rezics.com/vocab/';
const definition = 'https://rezics.com/definition/';
const id = 'content-withdrawal-v1';
const profiles = authoredProfiles.filter(profile => profile.id === id);
const outputs = buildModelOutputs(profiles);
const temporary: string[] = [];
afterAll(() => { for (const path of temporary) rmSync(path, { recursive: true, force: true }); });

let schemaPromise: Promise<Record<string, TSchema>> | undefined;
async function schemas(): Promise<Record<string, TSchema>> {
  if (!schemaPromise) {
    mkdirSync(join(root, '.temp'), { recursive: true });
    const directory = mkdtempSync(join(root, '.temp/content-withdrawal-'));
    temporary.push(directory);
    const path = join(directory, 'schemas.ts');
    writeFileSync(path, outputs.get('packages/model/src/generated/schemas.ts')!);
    schemaPromise = import(path).then(module => module.shapeSchemas as Record<string, TSchema>);
  }
  return schemaPromise;
}

async function accepts(role: string, value: Record<string, unknown>): Promise<boolean> {
  return Value.Check((await schemas())[`${definition}${id}/${role}-shape`]!, value);
}

function withdrawal(): Record<string, unknown> {
  return {
    '@id': 'urn:content:withdrawal:one',
    'rdf:type': [`${rv}ContentWithdrawalDecision`, `${rv}RevisionAnchor`],
    'rv:component': ['urn:content:variant:one'],
    'rv:operation': [`urn:rezics:operation:${'a'.repeat(64)}`],
    'rv:predecessor': ['urn:content:publication:one'],
    'rv:contentRevision': ['urn:rezics:content:revision:12345678-1234-1234-1234-123456789abc'],
    'rv:contentPreparation': ['accepted'],
    'rv:resource': ['urn:content:resource:one'],
    'rv:byteDigest': ['b'.repeat(64)],
    'rv:contentFormat': ['rezics-content-json-v1'],
    'rv:contentModel': ['content-v1'],
    'rv:contentLanguageKind': ['tag'],
    'rv:contentLanguage': ['en'],
    'rv:contentDirection': ['ltr'],
    'rv:ownerDataEpoch': ['12345678-1234-1234-1234-123456789abc'],
    'rv:ownerSequence': ['0'],
    'rv:modelRevision': [`${definition}${id}`],
    'rv:shapeRevision': [`${definition}${id}`],
    'rv:datasetId': ['urn:rezics:dataset:product'],
    'rv:dataEpoch': ['12345678-1234-1234-1234-123456789abc'],
    'rv:sequence': [1],
  };
}

test('Content withdrawal emits both focus roles and only the distinct decision canonical route', async () => {
  expect(profiles.map(profile => profile.id)).toEqual([id]);
  const command = commandProfiles(authoredProfiles);
  const entry = command.profiles.find(profile => profile.id === id)!;
  expect(entry.focusRoles).toEqual(['variant', 'decision']);
  expect(entry.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(command.shapes.get(entry.file)).toContain(
    'sh:path rv:predecessor ; sh:minCount 1 ; sh:maxCount 1 ; sh:nodeKind sh:IRI',
  );
  const manifest = command.manifest as {
    canonical: { type: string; routes: { profile: string; shape: string }[] }[];
  };
  expect(manifest.canonical.find(entry => entry.type === `${rv}ContentWithdrawalDecision`)?.routes)
    .toEqual([{ profile: id, shape: `${definition}${id}/decision-shape`, when: [] }]);
  expect(manifest.canonical.find(entry => entry.type === `${rv}ContentVariant`)?.routes)
    .toEqual([{
      profile: 'content-publication-v1',
      shape: `${definition}content-publication-v1/variant-shape`,
      when: [],
    }]);
  const variant = {
    '@id': 'urn:content:variant:one',
    'rdf:type': [`${rv}ContentVariant`],
    'rv:resource': ['urn:content:resource:one'],
    'rv:contentPublicationHead': ['urn:content:withdrawal:one'],
  };
  expect(await accepts('variant', variant)).toBe(true);
  expect(await accepts('variant', { ...variant, 'rv:contentPublicationHead': [] })).toBe(false);
  expect(await accepts('variant', {
    ...variant, 'rv:contentPublicationHead': ['urn:head:one', 'urn:head:two'],
  })).toBe(false);
});

test('Content withdrawal requires one predecessor IRI and every publication revision source pin', async () => {
  expect(await accepts('decision', withdrawal())).toBe(true);
  for (const property of [
    'rv:component', 'rv:operation', 'rv:predecessor', 'rv:contentRevision',
    'rv:contentPreparation', 'rv:resource', 'rv:byteDigest', 'rv:contentModel',
    'rv:contentLanguageKind', 'rv:contentDirection', 'rv:ownerDataEpoch',
    'rv:ownerSequence', 'rv:dataEpoch', 'rv:sequence',
  ]) {
    const missing = withdrawal();
    delete missing[property];
    expect(await accepts('decision', missing)).toBe(false);
  }
  for (const predecessor of [[], ['urn:publication:one', 'urn:publication:two'], [1]]) {
    expect(await accepts('decision', { ...withdrawal(), 'rv:predecessor': predecessor })).toBe(false);
  }
  expect(await accepts('decision', {
    ...withdrawal(), 'rdf:type': [`${rv}ContentPublicationDecision`, `${rv}RevisionAnchor`],
  })).toBe(false);
  expect(await accepts('decision', {
    ...withdrawal(), 'rdf:type': [`${rv}ContentWithdrawalDecision`],
  })).toBe(false);
});

test('Content withdrawal preserves publication language alternatives and constrained pin values', async () => {
  expect(await accepts('decision', { ...withdrawal(), 'rv:contentLanguage': [] })).toBe(false);
  expect(await accepts('decision', { ...withdrawal(), 'rv:contentLanguage': ['invalid_tag'] })).toBe(false);
  for (const kind of ['missing', 'und', 'mul', 'zxx']) {
    const nonTagged = { ...withdrawal(), 'rv:contentLanguageKind': [kind] };
    expect(await accepts('decision', nonTagged)).toBe(false);
    expect(await accepts('decision', { ...nonTagged, 'rv:contentLanguage': [] })).toBe(true);
  }
  for (const [property, value] of [
    ['rv:operation', 'urn:rezics:operation:short'],
    ['rv:contentRevision', 'urn:rezics:content:revision:short'],
    ['rv:contentPreparation', ''],
    ['rv:byteDigest', 'short'],
    ['rv:contentFormat', 'wrong-format'],
    ['rv:contentModel', ''],
    ['rv:contentLanguageKind', 'invalid'],
    ['rv:contentDirection', 'invalid'],
    ['rv:ownerDataEpoch', 'invalid'],
    ['rv:ownerSequence', '-1'],
    ['rv:modelRevision', `${definition}content-publication-v1`],
    ['rv:shapeRevision', `${definition}content-publication-v1`],
    ['rv:datasetId', 'urn:rezics:dataset:other'],
    ['rv:dataEpoch', 'invalid'],
  ]) {
    expect(await accepts('decision', { ...withdrawal(), [property!]: [value] })).toBe(false);
  }
  expect(await accepts('decision', { ...withdrawal(), 'rv:sequence': [0] })).toBe(false);
});
