import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { registryProbeDirectory, registryProbeFiles, registryProbeProfile }
  from '../tests/fixtures/registry-probe.ts';
import { compileFacet, facetId } from './facet.ts';
import { authoredFacets, authoredProfiles, buildArtifacts, commandModuleVersion, generate } from './generate.ts';
import { renderProfile, type ProfileDefinition } from './ir.ts';
import { buildCommandRegistry, canonicalTypeOrder, shapeRole, type RegistryOptions } from './registry.ts';

const repo = resolve(import.meta.dir, '../..');
const temporary: string[] = [];
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }); });

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

test('P0.3: authored constraints emit the exact recorded candidate profiles', () => {
  const artifacts = buildArtifacts(repo);
  const manifest = JSON.parse(artifacts.get('generated/model/manifest.json')!) as {
    profiles: { id: string; sha256: string; file: string }[];
  };
  const ids = authoredProfiles.map(profile => profile.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(manifest.profiles).toHaveLength(ids.length);
  expect(ids).toEqual(expect.arrayContaining([...lockedProfiles(repo).keys()]));
  const evidence = latestEvidence();
  expect(evidence.size).toBeGreaterThan(0);
  for (const [id, recorded] of evidence) {
    const profile = authoredProfiles.find(item => item.id === id);
    if (!profile) throw new Error(`evidence names unknown profile ${id}`);
    const rendered = renderProfile(profile);
    const published = manifest.profiles.find(entry => entry.id === id);
    expect(published).toBeDefined();
    expect(createHash('sha256').update(rendered).digest('hex')).toBe(recorded.profile_sha256);
    expect(artifacts.get(`generated/model/${published!.file}`)).toBe(rendered);
    expect(published!.sha256).toBe(recorded.profile_sha256);
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

interface LockedProfile { sha256: string; binding?: { required: string[]; optional?: string[]; roles: string[] } }
type Manifest = {
  commandModule: string;
  profiles: { id: string; sha256: string; file: string; binding?: LockedProfile['binding'] }[];
  canonical: { type: string; routes: { profile: string; shape: string; when: { path: string; value: string }[] }[] }[];
  bindingDemands: { type: string; profile: string }[];
};
const manifestOf = (artifacts: Map<string, string>) =>
  JSON.parse(artifacts.get('generated/model/manifest.json')!) as Manifest;

function lockedProfiles(root: string): Map<string, LockedProfile> {
  const profiles = new Map<string, LockedProfile>();
  for (const [path, text] of acceptedFiles(root)) {
    if (!path.includes('/profiles/')) continue;
    profiles.set(path.split('/').pop()!.replace(/\.json$/, ''), JSON.parse(text) as LockedProfile);
  }
  return profiles;
}

function lockedFacets(root: string): Map<string, string> {
  const facets = new Map<string, string>();
  for (const [path, text] of acceptedFiles(root)) {
    if (!path.includes('/facets/')) continue;
    facets.set(path.split('/').pop()!.replace(/\.json$/, ''), JSON.parse(text) as string);
  }
  return facets;
}

/** Digests and bindings come from the lock files; routes come from the compiled manifest. */
function assertRecordedRegistry(recorded: Manifest, built: Manifest, shapes: ReadonlyMap<string, string>,
  profiles: ReadonlyMap<string, LockedProfile>, facets: ReadonlyMap<string, string>): void {
  if (JSON.stringify(recorded.canonical) !== JSON.stringify(built.canonical)) {
    throw new Error('Canonical route differs from the compiled manifest');
  }
  if (JSON.stringify(recorded.bindingDemands) !== JSON.stringify(built.bindingDemands)) {
    throw new Error('Binding demand differs from the compiled manifest');
  }
  for (const [id, locked] of profiles) {
    const profile = built.profiles.find(item => item.id === id);
    const shape = profile && shapes.get(id);
    const same = profile && shape
      && profile.sha256 === locked.sha256
      && createHash('sha256').update(shape).digest('hex') === locked.sha256
      && JSON.stringify(profile.binding ?? null) === JSON.stringify(locked.binding ?? null);
    if (!same) throw new Error(`Accepted profile ${id} changed; add a new version instead`);
  }
  for (const entry of built.canonical) {
    for (const route of entry.routes) {
      const shape = shapes.get(route.profile);
      if (!shape?.includes(`<${route.shape}>`)) {
        throw new Error(`Canonical route for ${entry.type} names a shape ${route.profile} does not declare`);
      }
      if (!profiles.has(route.profile)) throw new Error(`Canonical route names unaccepted profile ${route.profile}`);
    }
  }
  for (const demand of built.bindingDemands) {
    if (!profiles.has(demand.profile)) throw new Error(`Binding demand names unaccepted profile ${demand.profile}`);
  }
  for (const facet of authoredFacets) {
    const id = facetId(facet);
    if (facets.get(id) !== String(compileFacet(facet).digest)) {
      throw new Error(`Accepted facet ${id} changed; add a new version instead`);
    }
  }
  for (const id of facets.keys()) {
    if (!authoredFacets.some(facet => facetId(facet) === id)) {
      throw new Error(`Accepted facet ${id} changed; add a new version instead`);
    }
  }
}

test('G-071: the generated registry keeps the historical canonical routes and binding demands', () => {
  const artifacts = buildArtifacts(repo);
  const built = manifestOf(artifacts);
  const recorded = JSON.parse(readFileSync(join(repo, 'generated/model/manifest.json'), 'utf8')) as Manifest;
  const shapes = new Map(built.profiles.map(profile =>
    [profile.id, artifacts.get(`generated/model/${profile.file}`)!]));
  const profiles = lockedProfiles(repo);
  const facets = lockedFacets(repo);
  expect(() => assertRecordedRegistry(recorded, built, shapes, profiles, facets)).not.toThrow();
  const drifted = JSON.parse(JSON.stringify(built)) as Manifest;
  drifted.canonical[0]!.routes[0]!.profile = 'zz-test-wrong-route';
  expect(() => assertRecordedRegistry(recorded, drifted, shapes, profiles, facets))
    .toThrow('Canonical route differs from the compiled manifest');
  const undeclared = JSON.parse(JSON.stringify(built)) as Manifest;
  undeclared.canonical[0]!.routes[0]!.shape = 'https://rezics.com/definition/zz-test-wrong-route/missing-shape';
  expect(() => assertRecordedRegistry(undeclared, undeclared, shapes, profiles, facets))
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
  cpSync(join(repo, 'model/accepted'), join(root, 'model/accepted'), { recursive: true });
  symlinkSync(join(repo, 'infra'), join(root, 'infra'));
  mutate(root);
  const loaded = await import(join(root, 'model/compiler/generate.ts')) as { generate: typeof generate };
  return { root, generate: loaded.generate };
}

function acceptedFiles(root: string): Map<string, string> {
  const files = new Map<string, string>();
  for (const kind of ['profiles', 'facets']) {
    const directory = join(root, 'model/accepted', kind);
    for (const name of readdirSync(directory).filter(item => item.endsWith('.json')).sort()) {
      files.set(`model/accepted/${kind}/${name}`, readFileSync(join(directory, name), 'utf8'));
    }
  }
  return files;
}

function replaceIn(root: string, relative: string, from: string, to: string): void {
  const path = join(root, relative);
  const source = readFileSync(path, 'utf8');
  if (!source.includes(from)) throw new Error(`missing ${from} in ${relative}`);
  writeFileSync(path, source.replace(from, to));
}

/** First accepted profile whose definition contains `token`, in lock-file order. */
function lockedProfileWith(root: string, token: string): string {
  for (const id of [...lockedProfiles(root).keys()].sort()) {
    if (readFileSync(join(root, `model/definitions/${id}.ts`), 'utf8').includes(token)) return id;
  }
  throw new Error(`no accepted profile definition contains ${token}`);
}

/** An accepted profile generate.ts does not import by path, so deleting its file still loads. */
function deletableProfile(root: string): string {
  const generator = readFileSync(join(root, 'model/compiler/generate.ts'), 'utf8');
  for (const id of [...lockedProfiles(root).keys()].sort()) {
    if (!generator.includes(`definitions/${id}.ts`)) return id;
  }
  throw new Error('no accepted profile is safe to delete in the compiler copy');
}

function lockedFacetPredicate(root: string): { id: string; predicate: string } {
  for (const id of [...lockedFacets(root).keys()].sort()) {
    const predicate = /predicate: '([^']+)'/.exec(readFileSync(join(root, `model/definitions/${id}.ts`), 'utf8'))?.[1];
    if (predicate) return { id, predicate };
  }
  throw new Error('no accepted facet definition has a predicate');
}

test('accepted profiles reject an edited constraint before writing', async () => {
  const id = lockedProfileWith(repo, 'maxCount: 1');
  const { root, generate: copied } = await copiedProject(copy => replaceIn(copy,
    `model/definitions/${id}.ts`, 'maxCount: 1', 'maxCount: 2'));
  expect(() => copied(root, false)).toThrow(`Accepted profile ${id} changed; add a new version instead`);
  expect(() => copied(root, true)).toThrow(`Accepted profile ${id} changed; add a new version instead`);
  expect(existsSync(join(root, 'generated/model/manifest.json'))).toBe(false);
});

test('a shared compiler helper that changes rendered shapes fails generation', async () => {
  const id = [...lockedProfiles(repo).keys()].sort()[0]!;
  const { root, generate: copied } = await copiedProject(copy => replaceIn(copy,
    'model/compiler/ir.ts', 'a sh:NodeShape ;', 'a sh:NodeShape  ;'));
  expect(() => copied(root, false)).toThrow(`Accepted profile ${id} changed; add a new version instead`);
  expect(existsSync(join(root, `generated/model/shapes/${id}.ttl`))).toBe(false);
});

test('deleting an accepted profile fails generation', async () => {
  const id = deletableProfile(repo);
  const { root, generate: copied } = await copiedProject(copy => rmSync(join(copy, `model/definitions/${id}.ts`)));
  expect(() => copied(root, true)).toThrow(`Accepted profile ${id} changed; add a new version instead`);
});

test('changing an accepted Facet path fails generation', async () => {
  const { id, predicate } = lockedFacetPredicate(repo);
  const replacement = predicate === 'rdf:value' ? 'rdf:type' : 'rdf:value';
  const { root, generate: copied } = await copiedProject(copy => replaceIn(copy,
    `model/definitions/${id}.ts`, `predicate: '${predicate}'`, `predicate: '${replacement}'`));
  expect(() => copied(root, false)).toThrow(`Accepted facet ${id} changed; add a new version instead`);
});

test('whitespace in an accepted definition still generates and leaves the lock untouched', async () => {
  const id = [...lockedProfiles(repo).keys()].sort()[0]!;
  const { root, generate: copied } = await copiedProject(copy => {
    const path = join(copy, `model/definitions/${id}.ts`);
    writeFileSync(path, `${readFileSync(path, 'utf8')}\n`);
  });
  const lock = [...acceptedFiles(root)];
  expect(() => copied(root, false)).not.toThrow();
  expect(() => copied(root, true)).not.toThrow();
  expect([...acceptedFiles(root)]).toEqual(lock);
});

test('an unaccepted profile is refused until its lock entry is appended', async () => {
  const id = 'zz-test-unaccepted-v1';
  const { root, generate: copied } = await copiedProject(copy => writeFileSync(join(copy, `model/definitions/${id}.ts`),
    `import type { ProfileDefinition } from '../compiler/ir.ts';

export const zzTestUnacceptedProfile = {
  id: '${id}',
  comments: ['A new version is admitted only with its own lock entry.'],
  prefixes: [
    ['sh', 'http://www.w3.org/ns/shacl#'],
    ['rdf', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'],
    ['rv', 'https://rezics.com/vocab/'],
  ],
  layout: 'compact',
  shapes: [{
    iri: 'https://rezics.com/definition/${id}/release-shape',
    canonical: { types: ['rv:ZzTestUnaccepted'] },
    properties: [{ path: 'rdf:type', hasValue: 'rv:ZzTestUnaccepted', maxCount: 1 }],
  }],
} as const satisfies ProfileDefinition;
`));
  let message = '';
  try { copied(root, false); } catch (error) { message = error instanceof Error ? error.message : String(error); }
  const file = `model/accepted/profiles/${id}.json`;
  const marker = `Unaccepted profile ${id}: add ${file} with exactly:\n`;
  expect(message.startsWith(marker)).toBe(true);
  const content = message.slice(marker.length);
  expect(JSON.parse(content)).toEqual({ sha256: expect.any(String) });
  expect(existsSync(join(root, 'generated/model/manifest.json'))).toBe(false);
  writeFileSync(join(root, file), content);
  expect(() => copied(root, false)).not.toThrow();
  expect(() => copied(root, true)).not.toThrow();
});

function gitText(args: string[]): string | undefined {
  try { return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
  catch { return undefined; }
}

function assertBaselineUnchanged(baseline: readonly { path: string; text: string }[],
  current: ReadonlyMap<string, string>): void {
  for (const file of baseline) {
    const id = file.path.split('/').pop()!.replace(/\.json$/, '');
    const now = current.get(file.path);
    if (file.path.includes('/profiles/')) {
      const before = JSON.parse(file.text) as { sha256: string; binding?: unknown };
      const after = now === undefined ? undefined : JSON.parse(now) as { sha256: string; binding?: unknown };
      if (!after || after.sha256 !== before.sha256
        || JSON.stringify(after.binding ?? null) !== JSON.stringify(before.binding ?? null)) {
        throw new Error(`Accepted profile ${id} changed; the merge-base lock entry must stay unchanged`);
      }
    } else {
      const before = JSON.parse(file.text) as string;
      const after = now === undefined ? undefined : JSON.parse(now) as string;
      if (after !== before) throw new Error(`Accepted facet ${id} changed; the merge-base lock entry must stay unchanged`);
    }
  }
}

test('accepted lock entries recorded at the merge-base stay unchanged', () => {
  const mergeBase = gitText(['merge-base', 'HEAD', 'main']);
  if (!mergeBase) {
    console.log('notice: skip accepted-lock merge-base guard; git or main is unavailable');
    return;
  }
  const listed = gitText(['ls-tree', '-r', '--name-only', mergeBase, 'model/accepted']);
  if (listed === undefined) {
    console.log('notice: skip accepted-lock merge-base guard; git or main is unavailable');
    return;
  }
  const paths = listed.split('\n').filter(path => path.endsWith('.json'));
  if (!paths.length) {
    console.log('notice: skip accepted-lock merge-base guard; model/accepted is absent from the merge-base');
    return;
  }
  const baseline = paths.map(path => {
    const text = gitText(['show', `${mergeBase}:${path}`]);
    if (text === undefined) throw new Error(`cannot read ${path} at the merge-base`);
    return { path, text };
  });
  expect(() => assertBaselineUnchanged(baseline, acceptedFiles(repo))).not.toThrow();
});

test('rewriting an existing accepted lock entry fails the merge-base guard', () => {
  const current = acceptedFiles(repo);
  const baseline = [...current].map(([path, text]) => ({ path, text }));
  const profilePaths = [...current.keys()].filter(path => path.includes('/profiles/')).sort();
  const facetPaths = [...current.keys()].filter(path => path.includes('/facets/')).sort();
  const profilePath = profilePaths[0]!;
  const profileId = profilePath.split('/').pop()!.replace(/\.json$/, '');
  const rewritten = new Map(current);
  const profile = JSON.parse(rewritten.get(profilePath)!) as { sha256: string };
  rewritten.set(profilePath, JSON.stringify({ ...profile, sha256: '0'.repeat(64) }));
  expect(() => assertBaselineUnchanged(baseline, rewritten))
    .toThrow(`Accepted profile ${profileId} changed; the merge-base lock entry must stay unchanged`);
  const bindingPath = profilePaths.find(path => {
    const value = JSON.parse(current.get(path)!) as { binding?: { roles: string[] } };
    return (value.binding?.roles.length ?? 0) > 1;
  });
  if (!bindingPath) throw new Error('no accepted profile lock has a multi-role binding');
  const bindingId = bindingPath.split('/').pop()!.replace(/\.json$/, '');
  const binding = new Map(current);
  const context = JSON.parse(binding.get(bindingPath)!) as { sha256: string; binding: { roles: string[] } };
  binding.set(bindingPath, JSON.stringify({ ...context, binding: { ...context.binding, roles: [context.binding.roles[0]] } }));
  expect(() => assertBaselineUnchanged(baseline, binding))
    .toThrow(`Accepted profile ${bindingId} changed; the merge-base lock entry must stay unchanged`);
  const facetPath = facetPaths[0]!;
  const facetName = facetPath.split('/').pop()!.replace(/\.json$/, '');
  const facet = new Map(current);
  facet.set(facetPath, JSON.stringify('0'.repeat(64)));
  expect(() => assertBaselineUnchanged(baseline, facet))
    .toThrow(`Accepted facet ${facetName} changed; the merge-base lock entry must stay unchanged`);
  const removed = new Map(current);
  removed.delete(profilePath);
  expect(() => assertBaselineUnchanged(baseline, removed))
    .toThrow(`Accepted profile ${profileId} changed; the merge-base lock entry must stay unchanged`);
  const appended = new Map(current);
  appended.set('model/accepted/profiles/zz-test-extra-v1.json', JSON.stringify({ sha256: 'a'.repeat(64) }));
  appended.set('model/accepted/facets/zz-test-facet-v1.json', JSON.stringify('b'.repeat(64)));
  expect(() => assertBaselineUnchanged(baseline, appended)).not.toThrow();
});
