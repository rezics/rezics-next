import { IDENTITY_RESOLUTION_TYPES, priorRevisionTypes, revisionClassNames } from '../../../model/compiler/revision-classes.ts';
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Pool } from 'pg';
import type { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { ContentErasureInvalid } from '../src/modules/erasure/content.ts';
import { canonicalErasureTargets } from '../src/modules/erasure/graph.ts';
import { ERASURE_REVISION_RESOURCES, GRAPH_ERASURE_KINDS, graphRevisionIds, resolveErasureRevisions,
  inventoryZoneHomeRevisionTargets, type ResolvedErasureRevision } from '../src/modules/erasure/revision-kind.ts';

const uuid = (ordinal: number) => `00000000-0000-4000-8000-${String(ordinal).padStart(12, '0')}`;
const resource = (ordinal: number) => `https://rezics.com/id/${uuid(ordinal)}`;
const XSD_BOOLEAN = 'http://www.w3.org/2001/XMLSchema#boolean';

function content(rows: { id: string; resource_id: string; availability: string }[]) {
  return { query: async () => ({ rows }) } as unknown as Pick<Pool, 'query'>;
}

function graph(rows: { revision: string; kind: string; owner: string; erased?: boolean; manifest?: string }[],
  seen: string[] = []) {
  return { query: async (sparql: string) => {
    seen.push(sparql);
    return { results: { bindings: rows.filter(row => sparql.includes(`<${row.revision}>`)).map(row => ({
      revision: { type: 'uri' as const, value: row.revision },
      kind: { type: 'literal' as const, value: row.kind },
      owner: { type: 'uri' as const, value: row.owner },
      ...(row.manifest ? { manifest: { type: 'uri' as const, value: row.manifest } } : {}),
      erased: { type: 'literal' as const, value: row.erased ? 'true' : 'false', datatype: XSD_BOOLEAN },
    })) } };
  } } as unknown as Pick<FusekiClient, 'query'>;
}

const kinds = [
  ['text_contribution_draft', 'TextContribution', 'text-contribution', `urn:rezics:sha256:${'ab'.repeat(32)}`],
  ['semantic_revision', 'SemanticRevision', 'semantic-component'],
  ['release_revision', 'ReleaseRevision', 'release'],
  ['work_head', 'CreativeWork', 'work'],
  ['composition_revision', 'StructureRevision', 'structure'],
  ['home_document_revision', 'ZoneHomeRevision', 'home-document'],
] as const;

test('each graph revision kind resolves to its owner resource', async () => {
  for (const [kind, type, ownerKind, manifest] of kinds) {
    const seen: string[] = [];
    const owner = resource(1);
    const revision = resource(2);
    const resolved = await resolveErasureRevisions(content([]), graph([{
      revision, kind, owner, ...(manifest ? { manifest } : {}) }], seen), owner, [uuid(2)]);
    expect(resolved).toEqual([{ kind, ref: uuid(2), resourceId: owner,
      graphIri: revision, ...(manifest ? { manifest } : {}), erased: false } satisfies ResolvedErasureRevision]);
    expect(seen[0]).toContain(type);
    expect(seen[0]).toContain('FixedRelease');
    expect(ERASURE_REVISION_RESOURCES[kind]).toBe(ownerKind);
  }
});

test('a content revision resolves from its variant owner and inventories selecting home cuts', async () => {
  const seen: string[] = [];
  const owner = resource(3);
  const resolved = await resolveErasureRevisions(content([{ id: uuid(4), resource_id: owner,
    availability: 'available' }]), graph([], seen), owner, [uuid(4)]);
  expect(resolved).toEqual([{ kind: 'content_revision', ref: uuid(4), resourceId: owner,
    graphIri: `urn:rezics:content:revision:${uuid(4)}`, erased: false,
    content: { availability: 'available', pendingPin: false, activePin: false,
      erasureId: null, erasureEpoch: null } }]);
  expect(seen).toHaveLength(1);
  expect(seen[0]).toContain('rv:ZoneHomeRevision');
  expect(ERASURE_REVISION_RESOURCES.content_revision).toBe('work');
});

test('the wrong owner and an unknown revision are refused', async () => {
  const owner = resource(5);
  const other = resource(6);
  await expect(resolveErasureRevisions(content([{ id: uuid(7), resource_id: other,
    availability: 'available' }]), graph([]), owner, [uuid(7)]))
    .rejects.toBeInstanceOf(ContentErasureInvalid);
  await expect(resolveErasureRevisions(content([]), graph([{ revision: resource(8),
    kind: 'work_head', owner: other }]), owner, [uuid(8)]))
    .rejects.toBeInstanceOf(ContentErasureInvalid);
  await expect(resolveErasureRevisions(content([]), graph([]), owner, [uuid(9)]))
    .rejects.toBeInstanceOf(ContentErasureInvalid);
  await expect(resolveErasureRevisions(content([]), graph([
    { revision: resource(10), kind: 'work_head', owner },
    { revision: resource(10), kind: 'release_revision', owner },
  ]), owner, [uuid(10)])).rejects.toBeInstanceOf(ContentErasureInvalid);
});

test('an already erased revision resolves to the same identity', async () => {
  const owner = resource(11);
  const revision = resource(12);
  const read = () => resolveErasureRevisions(content([]), graph([{ revision, kind: 'work_head', owner,
    erased: true }]), owner, [uuid(12)]);
  const first = await read();
  const second = await read();
  expect(second).toEqual(first);
  expect(first).toEqual([{ kind: 'work_head', ref: uuid(12), resourceId: owner, graphIri: revision,
    erased: true }]);
  const stored = await resolveErasureRevisions(content([{ id: uuid(13), resource_id: owner,
    availability: 'erased' }]), graph([]), owner, [uuid(13)]);
  expect(stored[0]!.erased).toBe(true);
  expect(await resolveErasureRevisions(content([{ id: uuid(13), resource_id: owner,
    availability: 'erased' }]), graph([]), owner, [uuid(13)])).toEqual(stored);
});

test('one request can name a Content revision and its Work head', async () => {
  const owner = resource(30);
  const head = resource(31);
  const resolved = await resolveErasureRevisions(content([{ id: uuid(32), resource_id: owner,
    availability: 'available' }]), graph([{ revision: head, kind: 'work_head', owner }]),
  owner, [uuid(32), uuid(31)]);
  expect(resolved.map(item => item.kind)).toEqual(['content_revision', 'work_head']);
  expect(resolved.every(item => item.resourceId === owner && !item.erased)).toBe(true);
});

function homeInventory(rows: { revision: string; owner: string; contentRevision: string;
  page?: string; owned?: boolean; erased?: boolean }[], seen: string[] = []) {
  return { query: async (sparql: string) => {
    seen.push(sparql);
    const uri = (value: string) => ({ type: 'uri', value });
    const bool = (value: boolean) => ({ type: 'literal', value: String(value), datatype: XSD_BOOLEAN });
    const unique = [...new Map(rows.map(row => [JSON.stringify([row.revision, row.owner,
      row.owned ?? true, row.erased ?? false]), row])).values()];
    return { results: { bindings: unique.map(row => ({ revision: uri(row.revision), owner: uri(row.owner),
      owned: bool(row.owned ?? true), erased: bool(row.erased ?? false) })) } };
  } } as unknown as Pick<FusekiClient, 'query'>;
}

const contentTarget = (owner = resource(40)): ResolvedErasureRevision => ({ kind: 'content_revision',
  ref: uuid(41), resourceId: owner, graphIri: `urn:rezics:content:revision:${uuid(41)}`, erased: false });

test('home erasure inventory includes one anchor per retained publication cut and deduplicates it', async () => {
  const target = contentTarget();
  const rows = [42, 43, 42].map(n => ({ revision: resource(n), owner: target.resourceId,
    contentRevision: target.graphIri }));
  const homes = await inventoryZoneHomeRevisionTargets(homeInventory(rows), [target]);
  expect(homes.map(home => home.graphIri)).toEqual([resource(42), resource(43)]);
  expect(homes.every(home => home.kind === 'home_document_revision' && home.resourceId === target.resourceId)).toBe(true);
});

test('multilingual selections bound the closure by cuts rather than their language combinations', async () => {
  const revisions = Array.from({ length: 32 }, (_, n) => ({ ...contentTarget(), ref: uuid(200 + n),
    graphIri: `urn:rezics:content:revision:${uuid(200 + n)}` }));
  const rows = [42, 43, 44].flatMap(n => revisions.map(target => ({ revision: resource(n),
    owner: target.resourceId, contentRevision: target.graphIri })));
  const seen: string[] = [];
  expect((await inventoryZoneHomeRevisionTargets(homeInventory(rows, seen), revisions)).map(home => home.graphIri))
    .toEqual([resource(42), resource(43), resource(44)]);
  expect(seen[0]).toContain('SELECT DISTINCT ?revision ?owner ?erased ?owned');
});

test('legacy Zone-owned revisions keep erasure resolution through publication-owned document identity', async () => {
  const zone = resource(44), page = resource(45), target = contentTarget(zone), seen: string[] = [];
  const homes = await inventoryZoneHomeRevisionTargets(homeInventory([{ revision: resource(46),
    owner: page, page: zone, contentRevision: target.graphIri }], seen), [target]);
  expect(homes[0]?.resourceId).toBe(page);
  expect(seen[0]).toContain('?requestedOwner a rv:Zone ; rv:homeDocument ?owner');
});

test('home inventory refuses wrong ownership, missing query coverage and oversized native closures', async () => {
  const target = contentTarget();
  await expect(inventoryZoneHomeRevisionTargets(homeInventory([{ revision: resource(42),
    owner: resource(47), contentRevision: target.graphIri, owned: false }]), [target]))
    .rejects.toBeInstanceOf(ContentErasureInvalid);
  await expect(inventoryZoneHomeRevisionTargets({ query: async () => ({}) } as unknown as Pick<FusekiClient, 'query'>,
    [target])).rejects.toBeInstanceOf(ContentErasureInvalid);
  const rows = Array.from({ length: 64 }, (_, n) => ({ revision: resource(100 + n), owner: target.resourceId,
    contentRevision: target.graphIri }));
  await expect(inventoryZoneHomeRevisionTargets(homeInventory(rows), [target])).rejects.toBeInstanceOf(ContentErasureInvalid);
});

test('a multilingual cut already suppressed by another revision retains its earlier tombstone', async () => {
  const target = contentTarget();
  expect(await inventoryZoneHomeRevisionTargets(homeInventory([{ revision: resource(42),
    owner: target.resourceId, contentRevision: target.graphIri, erased: true }]), [target])).toEqual([]);
});

test('tombstone digests keep Content revision URNs and accept graph revision IRIs', () => {
  const first = uuid(20);
  const second = uuid(21);
  expect(canonicalErasureTargets([second, first])).toEqual([
    `urn:rezics:content:revision:${first}`, `urn:rezics:content:revision:${second}`]);
  const revision = resource(22);
  expect(canonicalErasureTargets([revision, first])).toEqual([
    revision, `urn:rezics:content:revision:${first}`]);
  expect(() => canonicalErasureTargets([`urn:rezics:content:revision:${first}`])).toThrow();
});

/** Classes the identity query erases. Every other rv:*Revision class is closed below. */
const ERASABLE_REVISION_CLASSES = ['ReleaseRevision', 'SemanticRevision', 'StructureRevision', 'ZoneHomeRevision'] as const;

/** A new rv:*Revision class fails until it is erasable or listed here with a reason. */
const CLOSED_REVISION_CLASSES: Record<string, string> = {
  AcceptedTargetRatingObservationRevision: 'An accepted-target rating revision is not an erasure target.',
  AgentPublicProfileRevision: 'An agent profile revision is not an erasure target.',
  AuthorCreditRevision: 'An author-credit revision is not an erasure target.',
  BallotRevision: 'A ballot revision is not an erasure target.',
  ClaimRevision: 'A claim revision is not an erasure target.',
  CollectionNameRevision: 'A collection name revision is not an erasure target.',
  CollectionRevision: 'A collection revision is not an erasure target.',
  ContextDefinitionEquivalenceRevision: 'A context revision is not an erasure target.',
  ContextPreferenceRevision: 'A context revision is not an erasure target.',
  ContextSelectionRevision: 'A context revision is not an erasure target.',
  ContextSemanticRevision: 'A context revision is not an erasure target.',
  DailyRatingObservationRevision: 'A daily rating revision is not an erasure target.',
  DefinitionLifecycleRevision: 'A definition lifecycle revision is not an erasure target.',
  DefinitionRevision: 'Identity resolution excludes it from the generic anchor and does not erase it.',
  DynamicCollectionRevision: 'A dynamic collection revision is not an erasure target.',
  EditorialControlRevision: 'Identity resolution excludes it from the generic anchor and does not erase it.',
  EditorialFieldControlRevision: 'An editorial field revision is not an erasure target.',
  EditorialFieldRevision: 'An editorial field revision is not an erasure target.',
  ElectorateCharterRevision: 'An electorate charter revision is not an erasure target.',
  ErasedRevision: 'It is the erasure marker, not a product revision.',
  EventTimeRevision: 'An event-time revision is not an erasure target.',
  ExperienceRatingObservationRevision: 'An experience rating revision is not an erasure target.',
  FiniteRuleRevision: 'A finite-rule revision is not an erasure target.',
  FirstPartyThemeRevision: 'A first-party theme revision is not an erasure target.',
  FixedRevision: 'A fixed-bytes revision is not an erasure target.',
  GlobalRatingObservationRevision: 'A global rating revision is not an erasure target.',
  HolderCharterRevision: 'A holder charter revision is not an erasure target.',
  LanguageTaggedTargetRatingObservationRevision: 'A language-tagged rating revision is not an erasure target.',
  NativeAgentCreditRevision: 'A native agent credit revision is not an erasure target.',
  NativeChildRevision: 'A native child revision is not an erasure target.',
  PollQuestionRevision: 'A poll revision is not an erasure target.',
  PresentationRevision: 'A presentation revision is not an erasure target.',
  ProjectionRevision: 'A projection revision is not an erasure target.',
  ProposalRevision: 'A proposal revision is not an erasure target.',
  ProtectionRevision: 'A protection revision is not an erasure target.',
  ProxyRouteRevision: 'A proxy route revision is not an erasure target.',
  RatingObservationRevision: 'A rating observation revision is not an erasure target.',
  RatingPolicyRevision: 'A rating policy revision is not an erasure target.',
  RatingQuestionPresentationRevision: 'A rating question presentation revision is not an erasure target.',
  RatingQuestionPresentationV2Revision: 'A rating question presentation revision is not an erasure target.',
  RealizationRevision: 'Identity resolution excludes it from the generic anchor and does not erase it.',
  RealmModeratorChoiceRevision: 'A realm revision is not an erasure target.',
  RealmPublicProfileRevision: 'A realm revision is not an erasure target.',
  RelationOccurrenceRevision: 'A relation occurrence revision is not an erasure target.',
  ReleaseRatingObservationRevision: 'A release rating observation revision is not an erasure target.',
  RightsOfferingRevision: 'A rights revision is not an erasure target.',
  RightsRecognitionRevision: 'A rights revision is not an erasure target.',
  ScaledGlobalRatingObservationRevision: 'A scaled global rating revision is not an erasure target.',
  ScaledRatingObservationRevision: 'A scaled Realm rating revision is not an erasure target.',
  ScopedTargetRatingObservationRevision: 'A scoped rating revision is not an erasure target.',
  StatementRevision: 'A statement revision is not an erasure target.',
  TargetRatingObservationRevision: 'A target rating revision is not an erasure target.',
  ThemePackageRevision: 'A theme revision is not an erasure target.',
  VotingCharterRevision: 'A voting charter revision is not an erasure target.',
  WorkMetadataDetailsV2Revision: 'A work-metadata revision is not an erasure target.',
  WorkMetadataRevision: 'A work-metadata revision is not an erasure target.',
  ZoneRevision: 'A zone capability revision is not an erasure target.',
};

function generatedNames(field: 'NAMES' | 'PRIOR'): string[] {
  const java = readFileSync(resolve(import.meta.dir,
    '../../../infra/jena/command-module/src/main/java/com/rezics/jena/RevisionClasses.java'), 'utf8');
  const body = new RegExp(`Set<String> ${field} = Set\\.of\\(([\\s\\S]*?)\\);`).exec(java)?.[1];
  if (!body) throw new Error(`${field} is missing from the generated revision classes`);
  return [...body.matchAll(/"([A-Za-z0-9]+)"/g)].map(match => match[1]!);
}

test('the native revision-class constant equals the model set', () => {
  const definitions = resolve(import.meta.dir, '../../../model/definitions');
  const names = revisionClassNames(definitions);
  const source = readFileSync(resolve(import.meta.dir, '../src/modules/erasure/revision-kind.ts'), 'utf8');
  expect(generatedNames('NAMES')).toEqual(names);
  expect(generatedNames('PRIOR')).toEqual(priorRevisionTypes(names));
  // The compiler does not read this service file, so it is checked here: every
  // type identity resolution looks for is a *Revision class or a named extra.
  const identity = source.slice(source.indexOf('function identityQuery'), source.indexOf('function refuse'));
  const resolved = [...identity.matchAll(/\ba rv:([A-Z][A-Za-z0-9]+)/g)].map(match => match[1]!)
    .filter(name => name !== 'ErasedRevision');
  const known = new Set<string>([...names, ...IDENTITY_RESOLUTION_TYPES]);
  expect(resolved.filter(name => !known.has(name))).toEqual([]);
  expect(names).toContain('ErasedRevision');
  expect(generatedNames('PRIOR')).not.toContain('ErasedRevision');
  expect(generatedNames('PRIOR')).toContain('RevisionAnchor');
  expect(generatedNames('PRIOR')).toContain('FixedRelease');
});

test('every revision class is erasable or explicitly closed', () => {
  const definitions = resolve(import.meta.dir, '../../../model/definitions');
  const found = new Set(revisionClassNames(definitions));
  const source = readFileSync(resolve(import.meta.dir, '../src/modules/erasure/revision-kind.ts'), 'utf8');
  for (const name of found) {
    if ((ERASABLE_REVISION_CLASSES as readonly string[]).includes(name)) {
      expect(source).toContain(`rv:${name}`);
      expect(CLOSED_REVISION_CLASSES[name]).toBeUndefined();
    } else {
      expect(CLOSED_REVISION_CLASSES[name], `${name} is neither erasable nor closed`).toBeString();
    }
  }
  for (const name of Object.keys(CLOSED_REVISION_CLASSES)) expect(found.has(name), name).toBe(true);
  for (const name of ERASABLE_REVISION_CLASSES) expect(found.has(name), name).toBe(true);
  expect(source).toContain('rv:RevisionAnchor');
  expect(source).toContain('work_head');
  expect(source).toContain('text_contribution_draft');
});

test('every erasable kind has a purge subject and a closed class stays closed', () => {
  const scripts = ['purge-tdb2.sh', 'purge-activate.sh'].map(file =>
    readFileSync(resolve(import.meta.dir, '../../../infra/jena', file), 'utf8'));
  for (const script of scripts) {
    expect(script).toContain('urn:rezics:content:revision:');
    expect(script).toContain('https:\\/\\/rezics\\.com\\/id\\/');
  }
  const id = '00000000-0000-4000-8000-000000000001';
  for (const kind of GRAPH_ERASURE_KINDS) {
    const [subject] = graphRevisionIds([{ kind, ref: id }]);
    expect(subject).toBe(`https://rezics.com/id/${id}`);
    expect(subject).toHaveLength(58);
  }
  expect(canonicalErasureTargets([id])).toEqual([`urn:rezics:content:revision:${id}`]);
  expect(`urn:rezics:content:revision:${id}`).toHaveLength(64);
  const source = readFileSync(resolve(import.meta.dir, '../src/modules/erasure/revision-kind.ts'), 'utf8');
  for (const name of Object.keys(CLOSED_REVISION_CLASSES)) {
    expect(source).not.toContain(`BIND("${name}"`);
    expect(GRAPH_ERASURE_KINDS as readonly string[]).not.toContain(name);
  }
});
