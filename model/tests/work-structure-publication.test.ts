import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { TSchema } from 'typebox';
import { Value } from 'typebox/value';
import { authoredProfiles, commandProfiles } from '../compiler/generate.ts';
import { buildModelOutputs } from '../compiler/outputs.ts';

const root = resolve(import.meta.dir, '../..');
const rv = 'https://rezics.com/vocab/';
const schema = 'https://schema.org/';
const definition = 'https://rezics.com/definition/';
const id = 'work-structure-publication-v1';
const profiles = authoredProfiles.filter(profile => profile.id === id);
const outputs = buildModelOutputs(profiles);
const temporary: string[] = [];
afterAll(() => { for (const path of temporary) rmSync(path, { recursive: true, force: true }); });

function directory(): string {
  mkdirSync(join(root, '.temp'), { recursive: true });
  const path = mkdtempSync(join(root, '.temp/work-structure-publication-'));
  temporary.push(path);
  return path;
}

let schemaPromise: Promise<Record<string, TSchema>> | undefined;
async function schemas(): Promise<Record<string, TSchema>> {
  if (!schemaPromise) {
    const path = join(directory(), 'schemas.ts');
    writeFileSync(path, outputs.get('packages/model/src/generated/schemas.ts')!);
    schemaPromise = import(path).then(module => module.shapeSchemas as Record<string, TSchema>);
  }
  return schemaPromise;
}

async function accepts(role: string, value: Record<string, unknown>): Promise<boolean> {
  return Value.Check((await schemas())[`${definition}${id}/${role}-shape`]!, value);
}

const node = (type: string, values: Record<string, unknown>) => ({
  '@id': 'urn:publication:focus',
  'rdf:type': [`${rv}${type}`],
  ...values,
});
const work = (values: Record<string, unknown>) => ({
  '@id': 'urn:publication:work:one',
  'rdf:type': [schema + 'CreativeWork'],
  ...values,
});
const source = () => node('WorkStructurePublicSource', {
  'rv:work': ['https://rezics.com/id/00000000-0000-4000-8000-000000000001'],
  'rv:structureProfile': [`${rv}RecipeComposition`],
  'rv:structure': ['https://rezics.com/id/00000000-0000-4000-8000-000000000002'],
  'rv:component': ['https://rezics.com/id/00000000-0000-4000-8000-000000000003'],
  'rv:structureRevision': ['urn:structure:revision:one'],
  'rv:selectedGeneration': ['urn:structure:generation:one'],
  'rv:sourceRoot': [`urn:rezics:sha256:${'a'.repeat(64)}`],
});
const decision = (outcome = 'Published', withSource = true) => node('WorkStructurePublicationDecision', {
  'rdf:type': [`${rv}WorkStructurePublicationDecision`, `${rv}RevisionAnchor`],
  'rv:component': ['https://rezics.com/id/00000000-0000-4000-8000-000000000001'],
  'rv:operation': [`urn:rezics:operation:${'b'.repeat(64)}`],
  'rv:publicationOutcome': [`${rv}${outcome}`],
  ...(withSource ? { 'rv:publicSource': ['urn:publication:source:one'] } : {}),
  'rv:modelRevision': [`${definition}${id}`],
  'rv:shapeRevision': [`${definition}${id}`],
  'rv:datasetId': ['urn:rezics:dataset:product'],
  'rv:dataEpoch': ['00000000-0000-4000-8000-000000000004'],
  'rv:sequence': [1],
  'rv:manifest': ['urn:publication:decision-manifest'],
});

test('Work Structure publication is a distinct source profile with exact local requirements', async () => {
  expect(profiles.map(profile => profile.id)).toEqual([id]);
  const command = commandProfiles(authoredProfiles);
  expect(command.profiles.some(profile => profile.id === id)).toBe(true);
  const manifest = command.manifest as { canonical: { routes: { profile: string; shape: string }[] }[] };
  const canonicalRoles = manifest.canonical.flatMap(entry => entry.routes)
    .filter(route => route.profile === id)
    .map(route => route.shape.slice(route.shape.lastIndexOf('/') + 1).replace(/-shape$/, '')).sort();
  expect(canonicalRoles).toEqual(['decision', 'source']);

  expect(await accepts('work', work({
    'rv:workStructurePublicationHead': ['urn:publication:decision:one'],
  }))).toBe(true);
  expect(await accepts('work', work({
    'rv:workStructurePublicationHead': ['urn:publication:decision:one', 'urn:publication:decision:two'],
  }))).toBe(false);

  expect(await accepts('source', source())).toBe(true);
  const missingRoot = source();
  delete missingRoot['rv:sourceRoot'];
  expect(await accepts('source', missingRoot)).toBe(false);
  expect(await accepts('source', { ...source(), 'rv:component': [] })).toBe(false);
  expect(await accepts('source', { ...source(), 'rv:sourceRoot': ['urn:rezics:sha256:short'] })).toBe(false);

  expect(await accepts('decision', decision())).toBe(true);
  expect(await accepts('decision', decision('Published', false))).toBe(false);
  expect(await accepts('decision', decision('Withdrawn', false))).toBe(true);
  expect(await accepts('decision', decision('Withdrawn', true))).toBe(false);
  expect(await accepts('decision', { ...decision(), 'rv:component': [] })).toBe(false);
});

test('publication shapes pin Work, MainVersion, Structure, revision, generation and root types', async () => {
  const definitionPath = join(root, 'model/definitions', `${id}.ttl`);
  const sourceText = await Bun.file(definitionPath).text();
  expect(sourceText).toContain('sh:class schema:CreativeWork');
  expect(sourceText).toContain('sh:class rv:MainVersion');
  expect(sourceText).toContain('sh:class rv:Structure');
  expect(sourceText).toContain('sh:class rv:StructureRevision');
  expect(sourceText).toContain('sh:class rv:StructureGeneration');
  expect(sourceText).toContain('rv:sourceRoot');
  expect(sourceText).toContain('sh:hasValue rv:Withdrawn');
  expect(sourceText).not.toContain('rv:ContentPublicationDecision');
});

test('sourced publication revision keeps original source-free and requires evidence for public-domain text', async () => {
  const profile = 'work-structure-publication-v2';
  const artifact = buildModelOutputs(authoredProfiles.filter(item => item.id === profile));
  const path = join(directory(), 'sourced-schemas.ts');
  writeFileSync(path, artifact.get('packages/model/src/generated/schemas.ts')!);
  const generated = (await import(path)).shapeSchemas as Record<string, TSchema>;
  const shape = generated[`${definition}${profile}/decision-shape`]!;
  const original = { ...decision(), 'rv:modelRevision': [definition + profile],
    'rv:shapeRevision': [definition + profile], 'rv:rightsBasis': [rv + 'OriginalContribution'] };
  expect(Value.Check(shape, original)).toBe(true);
  const sourced = { ...original, 'rv:rightsBasis': [rv + 'PublicDomain'] };
  expect(Value.Check(shape, sourced)).toBe(false);
  const observation = ['https://rezics.com/id/00000000-0000-4000-8000-000000000006'];
  expect(Value.Check(shape, { ...sourced, 'rv:sourceObservation': observation })).toBe(true);
  expect(Value.Check(shape, { ...original, 'rv:sourceObservation': observation })).toBe(false);
  expect(Value.Check((await schemas())[`${definition}${id}/decision-shape`]!, sourced)).toBe(false);
});
