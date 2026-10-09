import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Pool } from 'pg';
import type { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { ContentErasureInvalid } from '../src/modules/erasure/content.ts';
import { canonicalErasureTargets } from '../src/modules/erasure/graph.ts';
import { ERASURE_REVISION_RESOURCES, resolveErasureRevisions,
  type ResolvedErasureRevision } from '../src/modules/erasure/revision-kind.ts';

const uuid = (ordinal: number) => `00000000-0000-4000-8000-${String(ordinal).padStart(12, '0')}`;
const resource = (ordinal: number) => `https://rezics.com/id/${uuid(ordinal)}`;

function content(rows: { id: string; resource_id: string; availability: string }[]) {
  return { query: async () => ({ rows }) } as unknown as Pick<Pool, 'query'>;
}

function graph(rows: { revision: string; kind: string; owner: string; erased?: boolean }[],
  seen: string[] = []) {
  return { query: async (sparql: string) => {
    seen.push(sparql);
    return { results: { bindings: rows.filter(row => sparql.includes(`<${row.revision}>`)).map(row => ({
      revision: { type: 'uri' as const, value: row.revision },
      kind: { type: 'literal' as const, value: row.kind },
      owner: { type: 'uri' as const, value: row.owner },
      erased: { type: 'literal' as const, value: row.erased ? 'true' : 'false' },
    })) } };
  } } as unknown as Pick<FusekiClient, 'query'>;
}

const kinds = [
  ['text_contribution_draft', 'TextContribution', 'text-contribution'],
  ['semantic_revision', 'SemanticRevision', 'semantic-component'],
  ['release_revision', 'ReleaseRevision', 'release'],
  ['work_head', 'CreativeWork', 'work'],
  ['composition_revision', 'StructureRevision', 'structure'],
] as const;

test('each graph revision kind resolves to its owner resource', async () => {
  for (const [kind, type, ownerKind] of kinds) {
    const seen: string[] = [];
    const owner = resource(1);
    const revision = resource(2);
    const resolved = await resolveErasureRevisions(content([]), graph([{
      revision, kind, owner }], seen), owner, [uuid(2)]);
    expect(resolved).toEqual([{ kind, ref: uuid(2), resourceId: owner,
      graphIri: revision, erased: false } satisfies ResolvedErasureRevision]);
    expect(seen[0]).toContain(type);
    expect(seen[0]).toContain('FixedRelease');
    expect(ERASURE_REVISION_RESOURCES[kind]).toBe(ownerKind);
  }
});

test('a content revision resolves from its variant owner without a graph read', async () => {
  const seen: string[] = [];
  const owner = resource(3);
  const resolved = await resolveErasureRevisions(content([{ id: uuid(4), resource_id: owner,
    availability: 'available' }]), graph([], seen), owner, [uuid(4)]);
  expect(resolved).toEqual([{ kind: 'content_revision', ref: uuid(4), resourceId: owner,
    graphIri: `urn:rezics:content:revision:${uuid(4)}`, erased: false,
    content: { availability: 'available', pendingPin: false, activePin: false,
      erasureId: null, erasureEpoch: null } }]);
  expect(seen).toEqual([]);
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
const ERASABLE_REVISION_CLASSES = ['ReleaseRevision', 'SemanticRevision', 'StructureRevision'] as const;

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
  ScopedTargetRatingObservationRevision: 'A scoped rating revision is not an erasure target.',
  StatementRevision: 'A statement revision is not an erasure target.',
  TargetRatingObservationRevision: 'A target rating revision is not an erasure target.',
  ThemePackageRevision: 'A theme revision is not an erasure target.',
  VotingCharterRevision: 'A voting charter revision is not an erasure target.',
  WorkMetadataDetailsV2Revision: 'A work-metadata revision is not an erasure target.',
  WorkMetadataRevision: 'A work-metadata revision is not an erasure target.',
  ZoneRevision: 'A zone capability revision is not an erasure target.',
};

test('every revision class is erasable or explicitly closed', () => {
  const definitions = resolve(import.meta.dir, '../../../model/definitions');
  const found = new Set<string>();
  for (const file of readdirSync(definitions)) {
    if (!file.endsWith('.ttl')) continue;
    for (const match of readFileSync(resolve(definitions, file), 'utf8').matchAll(/\brv:([A-Z][A-Za-z0-9]*Revision)\b/g)) {
      found.add(match[1]!);
    }
  }
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
