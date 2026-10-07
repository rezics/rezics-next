import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { registryProbeDirectory, registryProbeFiles, registryProbeProfile }
  from '../tests/fixtures/registry-probe.ts';
import { facetId } from './facet.ts';
import { authoredFacets, authoredProfiles, buildArtifacts, commandModuleVersion, generate } from './generate.ts';
import { profileSnapshot, renderProfile, type ProfileDefinition } from './ir.ts';
import { buildModelOutputs } from './outputs.ts';
import { buildCommandRegistry, canonicalTypeOrder, shapeRole, type RegistryOptions } from './registry.ts';
import { profileSource } from './shacl.ts';

const repo = resolve(import.meta.dir, '../..');
const temporary: string[] = [];
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test('consumer inspection cannot replace the loaded authored constraint basis', () => {
  const profile = structuredClone(profileSnapshot(authoredProfiles
    .find(item => item.id === 'semantic-annotation-v1')!));
  const before = buildModelOutputs([profile]);
  const shape = renderProfile(profile);
  const motivation = profile.shapes.flatMap(item => item.properties)
    .find(property => property.path === 'oa:motivatedBy')!;
  expect(motivation).toMatchObject({ in: expect.arrayContaining(['oa:commenting']) });
  expect(renderProfile(profile)).toBe(shape);
  expect(buildModelOutputs([profile])).toEqual(before);
});

test('MODEL14: compiler closes owner shapes and keeps the shared Resource shape open', () => {
  const profile = authoredProfiles.find(item => item.id === 'semantic-resource-v1')!;
  const rendered = renderProfile(profile);
  const [resource, revision] = rendered.split('<https://rezics.com/definition/semantic-resource-v1/revision-shape>');
  expect(resource).not.toContain('sh:closed');
  expect(revision).toContain('sh:closed true');
  expect(revision).toContain('sh:path rv:component');
});

test('P0.3: reviewed profiles publish matching shape bytes and digests', () => {
  const artifacts = buildArtifacts(repo);
  const manifest = JSON.parse(artifacts.get('generated/model/manifest.json')!) as {
    profiles: { id: string; sha256: string; file: string }[];
  };
  expect(manifest.profiles).toHaveLength(authoredProfiles.length);
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

/** Latest recorded evidence per profile. `work-profile` is the historical file name of work-metadata-v1. */
function latestEvidence(): Map<string, { profile_sha256: string; outcomes: Record<string, { conforms: boolean }> }> {
  const directory = join(repo, 'model/tests/evidence');
  const latest = new Map<string, { date: string; name: string }>();
  for (const name of readdirSync(directory).filter(item => item.endsWith('.json')).sort()) {
    const match = /^(\d{4}-\d{2}-\d{2})-(.+)-profile\.json$/.exec(name);
    if (!match) throw new Error(`unexpected evidence file ${name}`);
    const id = match[2] === 'work' ? 'work-metadata-v1' : `${match[2]}-v1`;
    const current = latest.get(id);
    if (!current || current.date < match[1]!) latest.set(id, { date: match[1]!, name });
  }
  const evidence = new Map<string, { profile_sha256: string; outcomes: Record<string, { conforms: boolean }> }>();
  for (const [id, file] of latest) {
    evidence.set(id, JSON.parse(readFileSync(join(directory, file.name), 'utf8')) as {
      profile_sha256: string; outcomes: Record<string, { conforms: boolean }>;
    });
  }
  return evidence;
}

test('P0.3: authored constraints emit current profiles with recorded candidate coverage', () => {
  const artifacts = buildArtifacts(repo);
  const manifest = JSON.parse(artifacts.get('generated/model/manifest.json')!) as {
    profiles: { id: string; sha256: string; file: string }[];
  };
  const ids = authoredProfiles.map(profile => profile.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(manifest.profiles).toHaveLength(ids.length);
  const evidence = latestEvidence();
  expect(evidence.size).toBeGreaterThan(0);
  for (const [id, recorded] of evidence) {
    const profile = authoredProfiles.find(item => item.id === id);
    if (!profile) throw new Error(`evidence names unknown profile ${id}`);
    const rendered = profileSource(profile);
    const published = manifest.profiles.find(entry => entry.id === id);
    expect(published).toBeDefined();
    expect(recorded.profile_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(createHash('sha256').update(rendered).digest('hex')).toBe(published!.sha256);
    expect(artifacts.get(`generated/model/${published!.file}`)).toBe(rendered);
    expect(Object.values(recorded.outcomes).some(outcome => outcome.conforms)).toBe(true);
    expect(Object.values(recorded.outcomes).some(outcome => !outcome.conforms)).toBe(true);
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

test('VIEW02: Work address lifecycle profile preserves the original route target', () => {
  const artifacts = buildArtifacts(repo);
  const shape = artifacts.get('generated/model/shapes/work-address-lifecycle-v1.ttl')!;
  expect(shape).toContain('work-address-lifecycle-v1/redirect-shape');
  expect(shape).toContain('work-address-lifecycle-v1/revision-shape');
  expect(shape).toContain('sh:hasValue rv:Redirected');
  expect(shape).toContain('sh:path rv:targetWork ; sh:minCount 1 ; sh:maxCount 1 ; sh:nodeKind sh:IRI');
  expect(shape).toContain('sh:path rv:previousRevision ; sh:minCount 1 ; sh:maxCount 1 ; sh:nodeKind sh:IRI');
  expect(shape).toContain('sh:hasValue rv:Renamed');
});

test('VIEW02: disposition shapes distinguish merged redirects from retired tombstones', () => {
  const artifacts = buildArtifacts(repo);
  const shape = artifacts.get('generated/model/shapes/work-address-disposition-v1.ttl')!;
  for (const role of ['merged-route', 'retired-route', 'merged-revision', 'retired-revision']) {
    expect(shape).toContain(`work-address-disposition-v1/${role}-shape`);
  }
  expect(shape).toContain('sh:hasValue rv:Merged');
  expect(shape).toContain('sh:hasValue rv:Retired');
  expect(shape).toContain('sh:path rv:redirectWork ; sh:maxCount 0');
  expect(shape).toContain('sh:path rv:previousRevision ; sh:minCount 1');
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

interface ManifestProfile { sha256: string; binding?: { required: string[]; optional?: string[]; roles: string[] } }
type Manifest = {
  commandModule: string;
  profiles: { id: string; sha256: string; file: string; binding?: ManifestProfile['binding'] }[];
  canonical: { type: string; routes: { profile: string; shape: string; when: { path: string; value: string }[] }[] }[];
  bindingDemands: { type: string; profile: string }[];
};
const manifestOf = (artifacts: Map<string, string>) =>
  JSON.parse(artifacts.get('generated/model/manifest.json')!) as Manifest;

/** Routes, binding demands and shape digests must agree with the current authored basis. */
function assertRecordedRegistry(recorded: Manifest, built: Manifest, shapes: ReadonlyMap<string, string>): void {
  if (JSON.stringify(recorded.canonical) !== JSON.stringify(built.canonical)) {
    throw new Error('Canonical route differs from the compiled manifest');
  }
  if (JSON.stringify(recorded.bindingDemands) !== JSON.stringify(built.bindingDemands)) {
    throw new Error('Binding demand differs from the compiled manifest');
  }
  for (const profile of built.profiles) {
    const shape = shapes.get(profile.id);
    if (!shape || createHash('sha256').update(shape).digest('hex') !== profile.sha256) {
      throw new Error(`Profile digest differs: ${profile.id}`);
    }
  }
  for (const entry of built.canonical) {
    for (const route of entry.routes) {
      if (!shapes.get(route.profile)?.includes(`<${route.shape}>`)) {
        throw new Error(`Canonical route for ${entry.type} names a shape ${route.profile} does not declare`);
      }
    }
  }
  for (const demand of built.bindingDemands) {
    if (!shapes.has(demand.profile)) throw new Error(`Binding demand names unknown profile ${demand.profile}`);
  }
}

test('G-071: the generated registry keeps the historical canonical routes and binding demands', () => {
  const artifacts = buildArtifacts(repo);
  const built = manifestOf(artifacts);
  const recorded = JSON.parse(readFileSync(join(repo, 'generated/model/manifest.json'), 'utf8')) as Manifest;
  const shapes = new Map(built.profiles.map(profile =>
    [profile.id, artifacts.get(`generated/model/${profile.file}`)!]));
  expect(() => assertRecordedRegistry(recorded, built, shapes)).not.toThrow();
  const drifted = JSON.parse(JSON.stringify(built)) as Manifest;
  drifted.canonical[0]!.routes[0]!.profile = 'zz-test-wrong-route';
  expect(() => assertRecordedRegistry(recorded, drifted, shapes))
    .toThrow('Canonical route differs from the compiled manifest');
  const undeclared = JSON.parse(JSON.stringify(built)) as Manifest;
  undeclared.canonical[0]!.routes[0]!.shape = 'https://rezics.com/definition/zz-test-wrong-route/missing-shape';
  expect(() => assertRecordedRegistry(undeclared, undeclared, shapes))
    .toThrow(`Canonical route for ${undeclared.canonical[0]!.type} names a shape`);
});

test('G-071: the manifest pins the command-module version defined once in pom.xml', () => {
  const pom = readFileSync(join(repo, 'infra/jena/command-module/pom.xml'), 'utf8');
  const manifest = manifestOf(buildArtifacts(repo));
  expect(manifest.commandModule).toBe(commandModuleVersion(repo));
  expect(pom).toContain(`<artifactId>fuseki-command</artifactId><version>${manifest.commandModule}</version>`);
  expect(readFileSync(join(repo, 'infra/jena/Dockerfile'), 'utf8')).toContain('target/fuseki-command.jar ');
});

test('G-071: a profile declared in its definition joins the registry after the established types', () => {
  const registry = buildCommandRegistry([...authoredProfiles, registryProbeProfile]);
  const types = registry.canonical.map(entry => entry.type);
  const probe = types.indexOf('https://rezics.com/vocab/RegistryProbe');
  expect(probe).toBeGreaterThanOrEqual(canonicalTypeOrder.length);
  expect(types[probe + 1]).toBe('https://rezics.com/vocab/RegistryProbeRecord');
  expect(registry.canonical[probe]!.routes.map(route => shapeRole(route.profile, route.shape)))
    .toEqual(['sealed-item', 'item']);
  expect(registry.bindingDemands).toContainEqual({ type: 'https://rezics.com/vocab/RegistryProbeRecord',
    profile: registryProbeProfile.id });
  expect(registry.bindings.get(registryProbeProfile.id)).toEqual({ required: ['item', 'record', 'label'],
    optional: ['note'], roles: ['item', 'record'] });
  // The Java registry test loads exactly this generator output.
  for (const [file, content] of registryProbeFiles()) {
    expect(readFileSync(join(registryProbeDirectory, file), 'utf8')).toBe(content);
  }
});

test('G-071: ambiguous, duplicate or stale registry declarations fail generation', () => {
  const probe = registryProbeProfile;
  const alone = { established: {}, canonicalOrder: [], demandOrder: [] };
  const [item, sealed, record] = probe.shapes;
  const build = (profile: ProfileDefinition, options: RegistryOptions = alone) => () =>
    buildCommandRegistry([profile], options);
  expect(build({ ...probe, shapes: [item, { ...sealed, canonical: { types: ['rv:RegistryProbe'] } }, record] }))
    .toThrow('Ambiguous canonical routing');
  expect(build({ ...probe, shapes: [item, { ...sealed, canonical: { types: ['rv:RegistryProbe'],
    when: [{ path: 'rv:probeState', value: 'rv:Sealed' }] } }, { ...record, canonical: { types: ['rv:RegistryProbe'],
    when: [{ path: 'rv:item', value: 'rv:Other' }] } }] })).toThrow('Ambiguous canonical routing');
  expect(build({ ...probe, binding: { ...probe.binding, roles: ['item', 'missing'] } }))
    .toThrow('binding names unknown role missing');
  expect(build({ ...probe, binding: { ...probe.binding, optional: ['item'] } }))
    .toThrow('invalid binding keys or roles');
  expect(build(probe, { ...alone, established: { [probe.id]: { canonical: { item: { types: ['<urn:x:T>'] } } } } }))
    .toThrow('declares canonical routing twice');
  expect(build(probe, { ...alone, established: { [probe.id]: { binding: probe.binding } } }))
    .toThrow('declares its binding twice');
  expect(build(probe, { ...alone, canonicalOrder: ['<https://rezics.com/vocab/Retired>'] }))
    .toThrow('Canonical precedence names undeclared type');
  expect(() => buildCommandRegistry([probe, { ...probe, id: 'zz-test-twin-v1', shapes: probe.shapes.map(shape =>
    ({ ...shape, iri: shape.iri.replace(probe.id, 'zz-test-twin-v1'), canonical: undefined })) }], alone))
    .toThrow('demands bindings of both');
  expect(() => buildCommandRegistry(authoredProfiles, { established: { 'zz-test-retired-v1': {} } }))
    .toThrow('unknown profile zz-test-retired-v1');
});

/** A temp project with this compiler, so a mutation cannot touch the worktree. */
async function copiedProject(mutate: (root: string) => void): Promise<{ root: string; generate: typeof generate }> {
  mkdirSync(join(repo, '.temp'), { recursive: true });
  const root = mkdtempSync(join(repo, '.temp/model-generation-'));
  temporary.push(root);
  cpSync(join(repo, 'model/compiler'), join(root, 'model/compiler'), {
    recursive: true, filter: source => !source.endsWith('generate.test.ts'),
  });
  cpSync(join(repo, 'model/definitions'), join(root, 'model/definitions'), { recursive: true });
  symlinkSync(join(repo, 'infra'), join(root, 'infra'));
  mutate(root);
  const loaded = await import(join(root, 'model/compiler/generate.ts')) as { generate: typeof generate };
  return { root, generate: loaded.generate };
}

function replaceIn(root: string, relative: string, from: string, to: string): void {
  const path = join(root, relative);
  const source = readFileSync(path, 'utf8');
  if (!source.includes(from)) throw new Error(`missing ${from} in ${relative}`);
  writeFileSync(path, source.replace(from, to));
}

test('an in-place profile relaxation regenerates its bytes and digest and detects hand-edited output', async () => {
  const id = 'relation-occurrence-v1';
  const { root, generate: copied } = await copiedProject(copy => replaceIn(copy,
    `model/definitions/${id}.ts`, 'maxLength: 200', 'maxLength: 201'));
  expect(() => copied(root, false)).not.toThrow();
  expect(() => copied(root, true)).not.toThrow();
  const manifest = JSON.parse(readFileSync(join(root, 'generated/model/manifest.json'), 'utf8')) as Manifest;
  const current = manifestOf(buildArtifacts(repo)).profiles.find(profile => profile.id === id)!;
  const changed = manifest.profiles.find(profile => profile.id === id)!;
  const shape = readFileSync(join(root, `generated/model/${changed.file}`), 'utf8');
  expect(shape).toContain('sh:maxLength 201');
  expect(changed.sha256).not.toBe(current.sha256);
  expect(changed.sha256).toBe(createHash('sha256').update(shape).digest('hex'));
  writeFileSync(join(root, `generated/model/${changed.file}`), `${shape}# hand edit\n`);
  expect(() => copied(root, true)).toThrow(`Generated artifact differs: generated/model/${changed.file}`);
  expect(() => copied(root, false)).not.toThrow();
  expect(() => copied(root, true)).not.toThrow();
});

test('a compiler rendering change regenerates the current basis', async () => {
  const { root, generate: copied } = await copiedProject(copy => replaceIn(copy,
    'model/compiler/ir.ts', 'a sh:NodeShape ;', 'a sh:NodeShape  ;'));
  expect(() => copied(root, false)).not.toThrow();
  expect(() => copied(root, true)).not.toThrow();
});

test('an authored profile can be removed without a digest lock', async () => {
  const id = 'relation-occurrence-v1';
  const { root, generate: copied } = await copiedProject(copy => {
    generate(copy, false);
    rmSync(join(copy, `model/definitions/${id}.ts`));
  });
  expect(() => copied(root, true)).toThrow(`Unexpected generated artifact: generated/model/shapes/${id}.ttl`);
  expect(() => copied(root, false)).not.toThrow();
  expect(() => copied(root, true)).not.toThrow();
  const manifest = JSON.parse(readFileSync(join(root, 'generated/model/manifest.json'), 'utf8')) as Manifest;
  expect(manifest.profiles.some(profile => profile.id === id)).toBe(false);
  expect(existsSync(join(root, `generated/model/shapes/${id}.ttl`))).toBe(false);
  expect(existsSync(join(root, `generated/model/contexts/${id}.jsonld`))).toBe(false);
});

test('an in-place Facet refinement regenerates its registry', async () => {
  const facet = authoredFacets.find(item => item.path.some(step => step.kind === 'triple'))!;
  const step = facet.path.find(item => item.kind === 'triple')!;
  const id = facetId(facet);
  const { root, generate: copied } = await copiedProject(copy => replaceIn(copy,
    `model/definitions/${id}.ts`, `predicate: '${step.predicate}'`, "predicate: 'rdf:value'"));
  expect(() => copied(root, false)).not.toThrow();
  expect(() => copied(root, true)).not.toThrow();
  expect(readFileSync(join(root, 'packages/model/src/generated/facets.ts'), 'utf8'))
    .not.toBe(buildArtifacts(repo).get('packages/model/src/generated/facets.ts'));
});


test('a new authored profile joins generation without a separate digest file', async () => {
  const id = 'reviewed-example-v1';
  const { root, generate: copied } = await copiedProject(copy => writeFileSync(join(copy, `model/definitions/${id}.ts`),
    `export const reviewedExampleProfile = {
      id: '${id}', comments: ['A reviewed current basis.'],
      prefixes: [['sh', 'http://www.w3.org/ns/shacl#'], ['rv', 'https://rezics.com/vocab/']],
      shapes: [{ iri: 'https://rezics.com/definition/${id}/example-shape',
        properties: [{ path: 'rv:example', maxCount: 1, nodeKind: 'sh:IRI' }] }],
    };`));
  expect(() => copied(root, false)).not.toThrow();
  expect(() => copied(root, true)).not.toThrow();
  const manifest = JSON.parse(readFileSync(join(root, 'generated/model/manifest.json'), 'utf8')) as Manifest;
  expect(manifest.profiles.some(profile => profile.id === id)).toBe(true);
});

test('an authored Facet can be removed from the current registry', async () => {
  const id = 'facet-author-v1';
  const { root, generate: copied } = await copiedProject(copy => rmSync(join(copy, `model/definitions/${id}.ts`)));
  expect(() => copied(root, false)).not.toThrow();
  expect(() => copied(root, true)).not.toThrow();
  expect(readFileSync(join(root, 'packages/model/src/generated/facets.ts'), 'utf8')).not.toContain(id);
});
