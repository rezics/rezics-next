import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { authoredProfiles, buildArtifacts, generate } from './generate.ts';
import { renderProfile } from './ir.ts';

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
  expect(registry).toContain('"focusRoles": [');
});

test('P0.3: generation check detects emitted artifact drift in a clean checkout', () => {
  mkdirSync(join(repo, '.temp'), { recursive: true });
  const root = mkdtempSync(join(repo, '.temp/model-generation-')); temporary.push(root);
  generate(root, false);
  expect(() => generate(root, true)).not.toThrow();
  const shape = join(root, 'generated/model/shapes/work-metadata-v1.ttl');
  writeFileSync(shape, readFileSync(shape, 'utf8').replace('sh:minCount 1', 'sh:minCount 2'));
  expect(() => generate(root, true)).toThrow('Generated artifact differs');
  generate(root, false);
  const context = join(root, 'generated/model/contexts/work-metadata-v1.jsonld');
  writeFileSync(context, readFileSync(context, 'utf8').replace('https://rezics.com/vocab/', 'https://wrong.example/'));
  expect(() => generate(root, true)).toThrow('Generated artifact differs');
  generate(root, false);
  const schema = join(root, 'packages/model/src/generated/schemas.ts');
  writeFileSync(schema, readFileSync(schema, 'utf8').replace('Type.Array', 'Type.Unknown'));
  expect(() => generate(root, true)).toThrow('Generated artifact differs');
});

test('P0.3: authored constraints emit the exact recorded candidate profiles', () => {
  const artifacts = buildArtifacts(repo);
  const manifest = JSON.parse(artifacts.get('generated/model/manifest.json')!) as {
    profiles: { id: string; sha256: string; file: string }[];
  };
  expect(authoredProfiles.map(profile => profile.id).sort()).toEqual([
    'classification-context-v1', 'classification-direct-decision-v1', 'classification-proposition-v1',
    'main-default-selection-v1', 'realm-local-rejection-v1', 'realm-local-selection-v1',
    'realm-standing-rating-context-v1', 'realm-standing-rating-observation-v1',
    'space-realm-v1', 'text-contribution-v1', 'text-publication-v1', 'work-metadata-v1',
  ]);
  for (const profile of authoredProfiles) {
    const rendered = renderProfile(profile);
    const reviewed = readFileSync(join(repo, `model/definitions/${profile.id}.ttl`), 'utf8');
    const evidenceName = profile.id === 'work-metadata-v1' ? 'work-profile' : `${profile.id.slice(0, -3)}-profile`;
    const evidence = JSON.parse(readFileSync(join(repo, `model/tests/evidence/2026-09-24-${evidenceName}.json`), 'utf8')) as {
      profile_sha256: string;
      outcomes: Record<string, { conforms: boolean }>;
    };
    const published = manifest.profiles.find(entry => entry.id === profile.id);
    expect(published).toBeDefined();
    expect(rendered).toBe(reviewed);
    expect(artifacts.get(`generated/model/${published!.file}`)).toBe(rendered);
    expect(published!.sha256).toBe(evidence.profile_sha256);
    expect(Object.values(evidence.outcomes).some(outcome => outcome.conforms)).toBe(true);
    expect(Object.values(evidence.outcomes).some(outcome => !outcome.conforms)).toBe(true);
  }
});

test('P0.3: invalid or changed authored constraints cannot silently reuse the profile digest', () => {
  const profile = authoredProfiles.find(item => item.id === 'work-metadata-v1')!;
  expect(() => renderProfile({ ...profile, shapes: [profile.shapes[0]!, profile.shapes[0]!] })).toThrow('distinct named NodeShapes');
  expect(() => renderProfile({
    ...profile,
    shapes: [{ ...profile.shapes[0]!, properties: [{ path: 'rv:mainVersion', minCount: 2, maxCount: 1 }] }],
  })).toThrow('minCount exceeds maxCount');
  const observation = authoredProfiles.find(item => item.id === 'realm-standing-rating-observation-v1')!;
  expect(() => renderProfile({
    ...observation,
    shapes: [{ ...observation.shapes[5]!, or: [[{ path: 'rv:ratingValue', minCount: 2, maxCount: 1 }],
      [{ path: 'rv:ratingValue', maxCount: 0 }]] }],
  })).toThrow('minCount exceeds maxCount');
  const changed = renderProfile({
    ...profile,
    shapes: [{ ...profile.shapes[0]!, properties: [
      ...profile.shapes[0]!.properties,
      { path: 'rv:unexpected', minCount: 1 },
    ] }, ...profile.shapes.slice(1)],
  });
  expect(changed).not.toBe(renderProfile(profile));
});
