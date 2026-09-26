import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { registryProbeDirectory, registryProbeFiles, registryProbeProfile }
  from '../tests/fixtures/registry-probe.ts';
import { authoredProfiles, buildArtifacts, commandModuleVersion, generate } from './generate.ts';
import { renderProfile, type ProfileDefinition } from './ir.ts';
import { buildCommandRegistry, shapeRole, type RegistryOptions } from './registry.ts';

const repo = resolve(import.meta.dir, '../..');
const temporary: string[] = [];
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }); });

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

test('P0.3: authored constraints emit the exact recorded candidate profiles', () => {
  const artifacts = buildArtifacts(repo);
  const manifest = JSON.parse(artifacts.get('generated/model/manifest.json')!) as {
    profiles: { id: string; sha256: string; file: string }[];
  };
  // Profiles are discovered from model/definitions; the first twelve keep their recorded P0.3 evidence.
  const historical = [
    'classification-context-v1', 'classification-direct-decision-v1', 'classification-proposition-v1',
    'main-default-selection-v1', 'realm-local-rejection-v1', 'realm-local-selection-v1',
    'realm-standing-rating-context-v1', 'realm-standing-rating-observation-v1',
    'space-realm-v1', 'text-contribution-v1', 'text-publication-v1', 'work-metadata-v1',
  ];
  const ids = authoredProfiles.map(profile => profile.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids).toEqual(expect.arrayContaining([...historical, 'content-publication-v1', 'work-title-control-v1']));
  for (const profile of authoredProfiles.filter(item => historical.includes(item.id))) {
    const rendered = renderProfile(profile);
    const evidenceName = profile.id === 'work-metadata-v1' ? 'work-profile' : `${profile.id.slice(0, -3)}-profile`;
    const evidenceDate = profile.id === 'work-metadata-v1' ? '2026-09-26' : '2026-09-24';
    const evidence = JSON.parse(readFileSync(join(repo, `model/tests/evidence/${evidenceDate}-${evidenceName}.json`), 'utf8')) as {
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

// The command module's hand-written chains before G-071, in match order: the registry
// must route every type to the same shape and demand the same bound profile.
const historicalCanonical: [type: string, ...routes: string[]][] = [
  ['EditorialControlRevision', 'work-title-control-v1/control'],
  ['AuthorCredit', 'work-author-credit-v1/credit'],
  ['AuthorCreditRevision', 'work-author-credit-v1/revision'],
  ['https://schema.org/CreativeWork', 'work-metadata-v1/work'],
  ['MainVersion', 'work-metadata-v1/main-version'],
  ['ContentVariant', 'content-publication-v1/variant'],
  ['ContentPublicationDecision', 'content-publication-v1/decision'],
  ['ContentSearchEligibilityDecision', 'content-search-eligibility-v1/decision'],
  ['ContentProjection', 'content-match-unit-v1/projection'],
  ['Space', 'space-realm-v1/space'],
  ['Realm', 'space-realm-v1/realm'],
  ['ExperienceRatingContext', 'realm-experience-rating-context-v1/context'],
  ['ExperienceRatingObservation', 'realm-experience-rating-observation-v1/observation'],
  ['ExperienceRatingObservationRevision', 'realm-experience-rating-observation-v1/revision'],
  ['RatingPolicyRevision', 'rating-aggregate-default-policy-v1/revision'],
  ['DailyRatingContext', 'realm-daily-rating-context-v1/context'],
  ['DailyRatingObservation', 'realm-daily-rating-observation-v1/observation'],
  ['DailyRatingObservationRevision', 'realm-daily-rating-observation-v1/revision'],
  ['RatingContext', 'realm-standing-rating-context-v1/context'],
  ['RatingObservation', 'realm-standing-rating-observation-v1/observation'],
  ['RatingObservationRevision', 'realm-standing-rating-observation-v1/revision'],
  ['RouteBinding', 'work-address-disposition-v1/merged-route routeState=Redirected routeDisposition=Merged',
    'work-address-disposition-v1/retired-route routeState=Retired',
    'work-address-lifecycle-v1/redirect routeState=Redirected', 'work-address-claim-v1/binding'],
  ['TranslationLink', 'translation-link-v1/link'],
  ['WorkDerivation', 'work-derivation-v1/derivation'],
  ['FixedRelease', 'fixed-native-text-release-v1/release'],
  ['TextContribution', 'text-contribution-v1/contribution'],
  ['PublicationDecision', 'text-publication-v1/decision'],
  ['ClassificationApplication', 'classification-direct-decision-v1/application'],
  ['ClassificationDecision', 'classification-direct-decision-v1/decision'],
  ['ClassificationSense', 'classification-proposition-v1/sense'],
  ['ClassificationContext', 'classification-context-v1/global contextRole=GlobalClassification',
    'classification-context-v1/context'],
  ['PublicationSelection', 'main-default-selection-v1/selection selectionBasis=MainMaintainer',
    'realm-local-selection-v1/selection'],
  ['RealmPublicationRejection', 'realm-local-rejection-v1/rejection'],
  ['http://www.w3.org/2004/02/skos/core#ConceptScheme', 'classification-proposition-v1/scheme'],
  ['http://www.w3.org/2004/02/skos/core#Concept', 'classification-proposition-v1/concept'],
  ['ConceptPath', 'classification-proposition-v1/path'],
  ['ClassificationExpression', 'classification-proposition-v1/expression'],
];
const historicalDemands: [profile: string, ...types: string[]][] = [
  ['work-author-credit-v1', 'AuthorCredit', 'AuthorCreditRevision'],
  ['rating-aggregate-default-policy-v1', 'RatingPolicyRevision'],
  ['classification-direct-decision-v1', 'ClassificationApplication', 'ClassificationDecision'],
  ['realm-experience-rating-observation-v1', 'ExperienceRatingObservation', 'ExperienceRatingObservationRevision'],
  ['realm-experience-rating-context-v1', 'ExperienceRatingContext'],
  ['realm-daily-rating-observation-v1', 'DailyRatingObservation', 'DailyRatingObservationRevision'],
  ['realm-daily-rating-context-v1', 'DailyRatingContext'],
  ['realm-standing-rating-observation-v1', 'RatingObservation', 'RatingObservationRevision'],
  ['realm-standing-rating-context-v1', 'RatingContext'],
  ['translation-link-v1', 'TranslationLink'],
  ['work-derivation-v1', 'WorkDerivation'],
  ['fixed-native-text-release-v1', 'FixedRelease'],
  ['classification-context-v1', 'ClassificationContext'],
  ['classification-proposition-v1', 'ClassificationSense', 'ConceptPath', 'ClassificationExpression',
    'http://www.w3.org/2004/02/skos/core#Concept', 'http://www.w3.org/2004/02/skos/core#ConceptScheme'],
];
const vocabulary = (name: string) => name.includes(':') ? name : `https://rezics.com/vocab/${name}`;
const local = (iri: string) => iri.replace('https://rezics.com/vocab/', '');
type Manifest = {
  commandModule: string;
  profiles: { id: string; binding?: { required: string[]; optional: string[]; roles: string[] } }[];
  canonical: { type: string; routes: { profile: string; shape: string; when: { path: string; value: string }[] }[] }[];
  bindingDemands: { type: string; profile: string }[];
};
const manifestOf = (artifacts: Map<string, string>) =>
  JSON.parse(artifacts.get('generated/model/manifest.json')!) as Manifest;

test('G-071: the generated registry keeps the historical canonical routes and binding demands', () => {
  const manifest = manifestOf(buildArtifacts(repo));
  // Historical types keep their exact routes and order; later profiles are appended after them.
  expect(manifest.canonical.slice(0, historicalCanonical.length).map(entry => [entry.type, ...entry.routes.map(route =>
    [`${route.profile}/${shapeRole(route.profile, route.shape)}`,
      ...route.when.map(condition => `${local(condition.path)}=${local(condition.value)}`)].join(' '))]))
    .toEqual(historicalCanonical.map(([type, ...routes]) => [vocabulary(type), ...routes]));
  const demands = historicalDemands.flatMap(([profile, ...types]) =>
    types.map(type => ({ type: vocabulary(type), profile })));
  expect(manifest.bindingDemands.slice(0, demands.length)).toEqual(demands);
  const bound = manifest.profiles.filter(profile => profile.binding).map(profile => profile.id);
  expect(bound.sort()).toEqual(historicalDemands.map(([profile]) => profile).sort());
  const credit = manifest.profiles.find(profile => profile.id === 'work-author-credit-v1')!.binding!;
  expect(credit).toEqual({ required: ['credit', 'revision', 'work', 'work-head', 'key', 'ordinal', 'actor',
    'receipt', 'scope', 'epoch', 'intent'], optional: ['source-role'], roles: ['credit', 'revision'] });
  expect(manifest.profiles.find(profile => profile.id === 'classification-context-v1')!.binding!.roles)
    .toEqual(['global', 'realm', 'context']);
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
  expect(probe).toBeGreaterThanOrEqual(historicalCanonical.length);
  expect(types[probe + 1]).toBe('https://rezics.com/vocab/RegistryProbeRecord');
  expect(registry.canonical[probe]!.routes.map(route => shapeRole(route.profile, route.shape)))
    .toEqual(['sealed-item', 'item']);
  expect(registry.bindingDemands).toContainEqual({ type: 'https://rezics.com/vocab/RegistryProbeRecord',
    profile: 'registry-probe-v1' });
  expect(registry.bindings.get('registry-probe-v1')).toEqual({ required: ['item', 'record', 'label'],
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
  expect(() => buildCommandRegistry([probe, { ...probe, id: 'registry-twin-v1', shapes: probe.shapes.map(shape =>
    ({ ...shape, iri: shape.iri.replace('registry-probe-v1', 'registry-twin-v1'), canonical: undefined })) }], alone))
    .toThrow('demands bindings of both');
  expect(() => buildCommandRegistry(authoredProfiles, { established: { 'retired-profile-v1': {} } }))
    .toThrow('unknown profile retired-profile-v1');
});
