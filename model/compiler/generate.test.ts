import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
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
  expect(manifest.profiles).toHaveLength(19);
  const work = manifest.profiles.find(profile => profile.id === 'work-metadata-v1');
  expect(work).toBeDefined();
  const shape = artifacts.get(`generated/model/${work!.file}`)!;
  expect(createHash('sha256').update(shape).digest('hex')).toBe(work!.sha256);
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
    'content-match-unit-v1', 'content-publication-v1', 'content-search-eligibility-v1',
    'fixed-native-text-release-v1', 'main-default-selection-v1',
    'realm-local-rejection-v1', 'realm-local-selection-v1',
    'realm-standing-rating-context-v1', 'realm-standing-rating-observation-v1',
    'space-realm-v1', 'text-contribution-v1', 'text-publication-v1',
    'translation-link-v1', 'work-address-claim-v1', 'work-derivation-v1', 'work-metadata-v1',
  ]);
  for (const profile of authoredProfiles.filter(item => ![
    'content-match-unit-v1', 'content-publication-v1', 'content-search-eligibility-v1',
    'fixed-native-text-release-v1', 'translation-link-v1', 'work-address-claim-v1',
    'work-derivation-v1',
  ].includes(item.id))) {
    const rendered = renderProfile(profile);
    const evidenceName = profile.id === 'work-metadata-v1' ? 'work-profile' : `${profile.id.slice(0, -3)}-profile`;
    const evidence = JSON.parse(readFileSync(join(repo, `model/tests/evidence/2026-09-24-${evidenceName}.json`), 'utf8')) as {
      profile_sha256: string;
      outcomes: Record<string, { conforms: boolean }>;
    };
    const published = manifest.profiles.find(entry => entry.id === profile.id);
    expect(published).toBeDefined();
    expect(createHash('sha256').update(rendered).digest('hex')).toBe(evidence.profile_sha256);
    expect(artifacts.get(`generated/model/${published!.file}`)).toBe(rendered);
    expect(published!.sha256).toBe(evidence.profile_sha256);
    expect(Object.values(evidence.outcomes).some(outcome => outcome.conforms)).toBe(true);
    expect(Object.values(evidence.outcomes).some(outcome => !outcome.conforms)).toBe(true);
  }
});

test('P0.8: Content publication emits distinct current and revision focus roles', () => {
  const artifacts = buildArtifacts(repo);
  const registry = artifacts.get('packages/model/src/generated/profiles.ts')!;
  const manifest = JSON.parse(artifacts.get('generated/model/manifest.json')!) as {
    profiles: { id: string; sha256: string; file: string }[];
  };
  const entry = manifest.profiles.find(item => item.id === 'content-publication-v1');
  expect(entry?.sha256).toMatch(/^[0-9a-f]{64}$/);
  const shape = artifacts.get(`generated/model/${entry!.file}`)!;
  expect(shape).toContain('content-publication-v1/variant-shape');
  expect(shape).toContain('content-publication-v1/decision-shape');
  expect(shape).toContain('sh:path rv:contentPublicationHead ; sh:minCount 1 ; sh:maxCount 1 ; sh:nodeKind sh:IRI');
  expect(shape).toContain('sh:path rv:contentRevision');
  expect(shape).toContain('sh:or (');
  expect(registry).toContain('"focusRoles": [\n      "variant",\n      "decision"');
});

test('VIEW01: Work address profile constrains the normalized route and revision anchor', () => {
  const artifacts = buildArtifacts(repo);
  const shape = artifacts.get('generated/model/shapes/work-address-claim-v1.ttl')!;
  expect(shape).toContain('work-address-claim-v1/binding-shape');
  expect(shape).toContain('work-address-claim-v1/revision-shape');
  expect(shape).toContain('sh:hasValue rv:RouteBinding');
  expect(shape).toContain('sh:hasValue "work"');
  expect(shape).toContain('^[a-z0-9]+(-[a-z0-9]+)*$');
  expect(shape).toContain('sh:path rv:targetWork ; sh:minCount 1 ; sh:maxCount 1 ; sh:nodeKind sh:IRI');
});

test('WORK02: reviewed translation profile requires exact official provenance', () => {
  const artifacts = buildArtifacts(repo);
  const manifest = JSON.parse(artifacts.get('generated/model/manifest.json')!) as {
    profiles: { id: string; sha256: string; file: string }[];
  };
  const entry = manifest.profiles.find(item => item.id === 'translation-link-v1');
  expect(entry?.sha256).toMatch(/^[0-9a-f]{64}$/);
  const shape = artifacts.get(`generated/model/${entry!.file}`)!;
  expect(shape).toContain('translation-link-v1/link-shape');
  expect(shape).toContain('rv:sourceVersionStatus ; sh:minCount 1 ; sh:maxCount 1');
  expect(shape).toContain('sh:hasValue rv:Official');
  expect(shape).toContain('sh:hasValue rv:Unresolved');
  expect(shape).toContain('rv:sourceMainRevision ; sh:maxCount 0');
  expect(shape).toContain('rv:authorizationScope ; sh:maxCount 0');
  expect(shape).toContain('sh:or (');
  const registry = artifacts.get('packages/model/src/generated/profiles.ts')!;
  expect(registry).toContain('"translation-link-v1"');
  expect(registry).toContain(entry!.sha256);
});

test('WORK04: derivation profile binds explicit kind and exact source and target revisions', () => {
  const artifacts = buildArtifacts(repo);
  const manifest = JSON.parse(artifacts.get('generated/model/manifest.json')!) as {
    profiles: { id: string; sha256: string; file: string }[];
  };
  const entry = manifest.profiles.find(item => item.id === 'work-derivation-v1');
  expect(entry?.sha256).toMatch(/^[0-9a-f]{64}$/);
  const shape = artifacts.get(`generated/model/${entry!.file}`)!;
  expect(shape).toContain('work-derivation-v1/derivation-shape');
  expect(shape).toContain('rv:sourceMainRevision ; sh:minCount 1 ; sh:maxCount 1');
  expect(shape).toContain('rv:targetMainRevision ; sh:minCount 1 ; sh:maxCount 1');
  expect(shape).toContain('rv:derivationKind ; sh:minCount 1 ; sh:maxCount 1');
  expect(shape).toContain('rv:SoftwareFork');
});

test('WORK05: fixed text release profile binds every selected dependency and byte digest', () => {
  const artifacts = buildArtifacts(repo);
  const manifest = JSON.parse(artifacts.get('generated/model/manifest.json')!) as {
    profiles: { id: string; sha256: string; file: string }[];
  };
  const entry = manifest.profiles.find(item => item.id === 'fixed-native-text-release-v1');
  expect(entry?.sha256).toMatch(/^[0-9a-f]{64}$/);
  const shape = artifacts.get(`generated/model/${entry!.file}`)!;
  for (const path of ['mainRevision', 'selection', 'publicationDecision', 'selectedDraft',
    'bodyDigest', 'manifest']) {
    expect(shape).toContain(`rv:${path} ; sh:minCount 1 ; sh:maxCount 1`);
  }
  expect(shape).toContain('rv:FixedRelease');
});

test('P0.8: Content search profiles emit projection, unit and eligibility roles', () => {
  const artifacts = buildArtifacts(repo);
  const manifest = JSON.parse(artifacts.get('generated/model/manifest.json')!) as {
    profiles: { id: string; sha256: string; file: string }[];
  };
  const profile = (id: string) => manifest.profiles.find(item => item.id === id)!;
  const projection = artifacts.get(`generated/model/${profile('content-match-unit-v1').file}`)!;
  const eligibility = artifacts.get(`generated/model/${profile('content-search-eligibility-v1').file}`)!;
  expect(projection).toContain('content-match-unit-v1/projection-shape');
  expect(projection).toContain('content-match-unit-v1/unit-shape');
  expect(projection).toContain('rv:searchBody');
  expect(eligibility).toContain('content-search-eligibility-v1/decision-shape');
  expect(eligibility).toContain('rv:rightsBasis ; sh:maxCount 1 ; sh:hasValue rv:OriginalContribution');
  expect(eligibility).toContain('rv:actingSubject');
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
