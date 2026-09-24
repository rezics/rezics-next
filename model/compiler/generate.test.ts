import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildArtifacts, generate } from './generate.ts';

const repo = resolve(import.meta.dir, '../..');
const temporary: string[] = [];
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test('P0.3: reviewed profiles publish matching shape bytes and digests', () => {
  const artifacts = buildArtifacts(repo);
  const manifest = JSON.parse(artifacts.get('generated/model/manifest.json')!) as {
    profiles: { id: string; sha256: string; file: string }[];
  };
  expect(manifest.profiles).toHaveLength(12);
  const work = manifest.profiles.find(profile => profile.id === 'work-metadata-v1');
  expect(work).toBeDefined();
  const shape = artifacts.get(`generated/model/${work!.file}`)!;
  expect(shape).toBe(readFileSync(join(repo, 'model/definitions/work-metadata-v1.ttl'), 'utf8'));
  expect(shape).toContain('main-version-shape');
  expect(work!.sha256).toMatch(/^[a-f0-9]{64}$/);
  const registry = artifacts.get('packages/model/src/generated/profiles.ts')!;
  expect(registry).toContain(work!.sha256);
  expect(registry).toContain('https://rezics.com/definition/work-metadata-v1/work-shape');
});

test('P0.3: generation check detects source drift and rejects an unshaped profile', () => {
  const root = mkdtempSync(join(repo, '.temp/model-generation-')); temporary.push(root);
  const definitions = join(root, 'model/definitions');
  mkdirSync(definitions, { recursive: true });
  const source = '<https://rezics.com/shape/test> a sh:NodeShape ;\n  sh:property [] .\n';
  const profile = join(definitions, 'test-v1.ttl');
  writeFileSync(profile, source);
  generate(root, false);
  expect(() => generate(root, true)).not.toThrow();
  writeFileSync(profile, source.replace('sh:property', 'sh:minCount'));
  expect(() => generate(root, true)).toThrow('Generated artifact differs');
  writeFileSync(profile, '@prefix sh: <http://www.w3.org/ns/shacl#> .\n');
  expect(() => buildArtifacts(root)).toThrow('distinct named NodeShapes');
});
