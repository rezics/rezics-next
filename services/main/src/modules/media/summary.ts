import type { PoolClient } from 'pg';
import { publicPost } from '../post/patterns.ts';
import { createHash } from 'node:crypto';
import { DATASET, GRAPHS, RV, iri, type WorkActivationEnvironment } from '../work/activate.ts';
import { listEligibleNativeVariants } from '../work/native-variants.ts';
import { readContextSummaryBatch } from '../context/summary-read.ts';
import { PROFILES } from '../semantic/schema.ts';
import { readWorkComponentState } from '../work/history.ts';
import { readPublicRealmNames } from '../space/read.ts';
import { currentProfile } from '../realm-profile/schema.ts';
import { checkedCollectionName } from '../collection/names.ts';
import { publicWork } from '../work/public-patterns.ts';
import type { SemanticDisclosure } from '../access/semantic-disclosure.ts';
import { DISCLOSURE_COST, discloseInventory, discloseInventoryWithAnonymousNames, hasDisclosure, type DisclosureChannel, type DisclosureTarget } from '../disclosure/read.ts';
import { ANONYMOUS_VIEWER, type Viewer } from '../suitability/policy.ts';
import { direction, readerLanguages, selectDisplayName, type DisplayName, type LocalizedText } from '../display-language/select.ts';
import type { Base } from '../target/contract.ts';
import { AVATAR_POLICY, avatarImageEligible, DEFAULT_MEDIA_CONTEXT, MediaInvalid, MediaUnavailable,
  type AvatarRow, type MediaStore } from './store.ts';
import { propertyRevelationRecord } from '../reading-position/store.ts';
import { MERGE_COST } from '../identity-merge/contract.ts';
import type { MergedIdentity } from '../identity-merge/resolution.ts';
import type { ImageNsfw } from './presentation.ts';
import type { ReadAssessment } from '../suitability/contract.ts';
import { UNASSESSED } from '../suitability/policy.ts';
import type { CanonicalAddress } from '@rezics/model/address';
import { identityCanonical, canonicalAddresses } from '../address/canonical.ts';
import { readSummaryPages, SUMMARY_PAGE_COST } from './summary-pages.ts';

export { direction } from '../display-language/select.ts';

export const MAX_SUMMARY_BATCH = SUMMARY_PAGE_COST.batch;
/** A projection's parts were read at another graph position than the projection; read again. */
export class SummaryGraphMoved extends MediaUnavailable {}
export const FALLBACK_POLICY = 'avatar-fallback-v1';
const nativeId = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
const languageTag = /^[a-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/;
export const SUMMARY_REFERENCE_PATTERN = '^[A-Za-z][A-Za-z0-9+.-]*:[^\\s<>]*$';
export const MAX_SUMMARY_REFERENCE_LENGTH = 2048;
const summaryReference = new RegExp(SUMMARY_REFERENCE_PATTERN);

export type ResourceType = 'work' | 'main-version' | 'space' | 'realm' | 'concept'
  | 'agent' | 'zone'
  | 'character' | 'context' | 'role' | 'relation-definition'
  | 'release' | 'occurrence' | 'realization' | 'resource' | 'collection' | 'projection';

/** Entry axes and owners without a supported exact revision path have no target base. */
export const summaryBases = { work: 'work', 'main-version': null, space: null,
  agent: null, zone: null,
  realm: null, concept: null, character: 'resource', context: 'resource',
  role: 'resource', 'relation-definition': null, release: 'release',
  occurrence: 'occurrence', realization: 'realization', resource: 'resource', collection: null,
  projection: 'projection',
} as const satisfies Record<ResourceType, Base | null>;

export interface SummaryReader {
  /** Wiki read policy, applied after owner disclosure and before delivery. */
  visibleRecords?: (records: readonly string[]) => Promise<ReadonlySet<string>>;
  viewer?: Viewer;
  /** Current approved membership, including its revocation generations. */
  realmReadProof?: (realm: string) => Promise<string | null>;
  /** Readable non-public Work, checked against current Access only after the graph read. */
  canReadWork?: (work: string) => Promise<boolean>;
  /** One Access owner request for all distinct non-public Works in the batch. */
  canReadWorks?: (works: readonly string[]) => Promise<ReadonlySet<string>>;
  /** Access fence checked against each exact graph head before a title is returned. */
  restrictedTitles?: (heads: readonly { work: string; revision: string }[], context: string) =>
    Promise<ReadonlySet<string>>;
  /** Access returns public disclosure separately from current private grants. */
  canReadSemantic?: (resource: string) => Promise<boolean>;
  canReadSemantics?: (resources: readonly string[]) => Promise<SemanticDisclosure | ReadonlySet<string>>;
  /** The Context owner checks private disclosure; public Contexts need no grant. */
  canReadPrivateContext?: (context: string) => Promise<boolean>;
  canReadPrivateContexts?: (contexts: readonly string[]) => Promise<ReadonlySet<string>>;
}

export interface SummaryInput {
  /** Selected Work reads fence these resource dependencies instead of the dataset counter. */
  localBasis?: boolean;
  /** Internal: the parts of a projection are read as ordinary summaries, never as projections themselves. */
  projectionPart?: true;
  /** Internal single-hop disclosure for G-506, which owns its own traversal. */
  resolveMerges?: boolean;
  channel?: DisclosureChannel;
  resources: readonly string[];
  context: string;
  language: string | null;
  languages?: readonly string[];
  /** Zone bindings admit Collections; the existing summary-batch transport does not. */
  includeCollections?: boolean;
  /** The caller already loaded graph types. A non-Agent then needs no name-owner
   * probe; community pages set this so that probe is not another graph request. */
  settleNonAgentNameOwners?: boolean;
}

export type AvatarDescriptor =
  | { kind: 'image'; selection: string; url: string; mediaType: string; width: number; height: number;
    representation?: string; use?: string; nsfw?: ImageNsfw; ageRating?: ReadAssessment; conceal?: boolean;
    crop: string | null; basis: { policy: string; context: string } }
  | { kind: 'fallback'; policy: string; key: string; resourceType: ResourceType };

type AvailableSummary = { reference: string; status: 'available'; type: ResourceType;
  disclosure: 'public' | 'restricted'; base: Base | null; work: string | null;
  address: CanonicalAddress;
  name: DisplayName & { context?: string; preferenceRevision?: string };
  avatar: AvatarDescriptor; resolution?: MergedIdentity;
  /** A projection's subject and frames as their own summaries, in frame order; clients format them, the server concatenates no labels. */
  parts?: { subject: PartSummary; frames: PartSummary[] } };
type PartSummary = Omit<AvailableSummary, 'resolution' | 'parts'>;
export type ResourceSummary = AvailableSummary | { reference: string; status: 'unavailable' };

export interface SummaryBatch {
  summaries: ResourceSummary[];
  generation: { graph: string; media: string | null; addresses?: string };
  /** Owner round trips spent by this batch, reported for the cost contract. */
  cost: { graphQueries: number; mediaQueries: number; accessChecks: number; accessQueries: number };
}

/** A list may omit optional media when its owner cannot answer. Core identity
 * and disclosure still use the same required summary reads and fences. */
export type SummaryMedia = {
  avatarRows(...args: Parameters<MediaStore['avatarRows']>):
    Promise<Awaited<ReturnType<MediaStore['avatarRows']>> | null>;
};

interface GraphRow { post?: boolean; type: ResourceType; work: string | null; head: string | null;
  public: boolean; labels: Map<string, string>; localizedName?: LocalizedText;
  profileAvatarSelections?: Set<string>;
  /** The subject and sorted frames a projection names. */
  projection?: { subject: string; frames: Set<string> } }

/** Current profile payloads for a bounded Realm summary batch, one graph call. */
async function realmProfileNames(env: WorkActivationEnvironment, realms: readonly string[]) {
  const names = new Map<string, LocalizedText>();
  if (!realms.length) return names;
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?realm ?payload WHERE {
    VALUES ?realm { ${realms.map(iri).join(' ')} }
    GRAPH ${iri(GRAPHS.current)} { ?realm a rv:Realm . OPTIONAL { ?realm rv:publicProfileHead ?head } }
    OPTIONAL { GRAPH ${iri(GRAPHS.revisions)} { ?head a rv:RealmPublicProfileRevision ;
      rv:component ?realm ; rv:profilePayload ?payload } }
  } LIMIT ${realms.length + 1}`)).results?.bindings ?? [];
  if (rows.length !== realms.length) throw new MediaUnavailable('Realm profile batch is incomplete');
  for (const row of rows) {
    if (!row.realm || names.has(row.realm.value)) throw new MediaUnavailable('Realm profile batch is ambiguous');
    if (!row.payload) continue;
    try { names.set(row.realm.value, currentProfile(JSON.parse(row.payload.value)).name); }
    catch { throw new MediaUnavailable('Realm profile name is invalid'); }
  }
  return names;
}

/** Definition projections and exact sealed heads are read together, independent of batch size. */
async function readRelationDefinitionNames(env: WorkActivationEnvironment, resources: readonly string[],
  contextualNames: ReadonlyMap<string, Map<string, string>>) {
  const names = new Map<string, Map<string, string>>();
  if (!resources.length) return names;
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?resource ?head ?manifest WHERE {
    VALUES ?resource { ${resources.map(iri).join(' ')} }
    GRAPH ${iri(GRAPHS.current)} { ?resource a rv:SemanticDefinition ;
      rv:definitionKind rv:RelationDefinition ; rv:definitionHead ?head . }
    GRAPH ${iri(GRAPHS.revisions)} { ?head a rv:DefinitionRevision ; rv:component ?resource ;
      rv:lifecycle rv:Active ; rv:manifest ?manifest . }
  } LIMIT ${MAX_SUMMARY_BATCH + 1}`);
  const rows = result.results?.bindings ?? [];
  if (rows.length > MAX_SUMMARY_BATCH) throw new MediaUnavailable('definition summary batch exceeds its bound');
  for (const row of rows) {
    if (!row.resource || !row.head || !row.manifest) continue;
    const state = await readWorkComponentState(env, row.manifest.value, row.resource.value, PROFILES.definition);
    if (state.component === 'definition' && state.kind === 'relation' && state.lifecycle === 'active') {
      const reference = row.resource.value;
      names.set(reference, contextualNames.get(reference)
        ?? new Map([['en', `Relation definition ${reference.slice(-8)}`]]));
    }
  }
  return names;
}

/** Character and Role names from exact current semantic manifests in one graph read. */
async function readSemanticResourceNames(env: WorkActivationEnvironment,
  resources: ReadonlyMap<string, 'character' | 'role' | 'resource'>, reader: SummaryReader) {
  const names = new Map<string, Map<string, string>>();
  if (!resources.size) return names;
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?resource ?manifest WHERE {
    VALUES ?resource { ${[...resources.keys()].map(iri).join(' ')} }
    GRAPH ${iri(GRAPHS.current)} { ?resource rv:semanticHead ?head }
    GRAPH ${iri(GRAPHS.revisions)} { ?head a rv:SemanticRevision ; rv:component ?resource ;
      rv:lifecycle rv:Active ; rv:manifest ?manifest . }
  } LIMIT ${MAX_SUMMARY_BATCH + 1}`);
  const rows = result.results?.bindings ?? [];
  if (rows.length > MAX_SUMMARY_BATCH) throw new MediaUnavailable('semantic summary batch exceeds its bound');
  for (const row of rows) {
    if (!row.resource || !row.manifest) continue;
    const type = resources.get(row.resource.value);
    if (!type) continue;
    const state = await readWorkComponentState(env, row.manifest.value, row.resource.value, PROFILES.resource);
    if (state.component !== 'resource' || state.lifecycle !== 'active' || !Array.isArray(state.types)
      || type !== 'resource' && !state.types.includes(`${RV}${type === 'character' ? 'Character' : 'Role'}`)
      || !Array.isArray(state.properties)) continue;
    const labels = new Map<string, string>();
    const ambiguous = new Set<string>();
    const visibleNames = reader.visibleRecords ? await reader.visibleRecords(state.properties.map(property =>
      propertyRevelationRecord(row.resource!.value, property.predicate, property.value))) : null;
    for (const property of state.properties as Array<{ predicate?: string;
      value?: { kind?: string; lexical?: string; language?: string } }>) {
      if (property.predicate !== 'https://schema.org/name' || !property.value?.lexical?.trim()) continue;
      if (visibleNames && !visibleNames.has(propertyRevelationRecord(row.resource.value, property.predicate, property.value))) continue;
      const language = property.value.kind === 'language-string' ? property.value.language?.toLowerCase()
        : property.value.kind === 'string' ? 'en' : undefined;
      if (!language || !languageTag.test(language)) continue;
      if (labels.has(language) && labels.get(language) !== property.value.lexical) ambiguous.add(language);
      labels.set(language, property.value.lexical);
    }
    for (const language of ambiguous) labels.delete(language);
    names.set(row.resource.value, labels);
  }
  return names;
}
const typePriority: readonly ResourceType[] = [
  'agent', 'zone',
  'work', 'main-version', 'release', 'occurrence', 'realization',
  'space', 'realm', 'concept', 'context', 'character', 'role', 'relation-definition', 'collection', 'projection',
  'resource',
];

/** Requested exact tag, then its primary subtag, then English, then the lowest tag. */
export function selectName(labels: Map<string, string>, language: string | null) {
  const tags = [...labels.keys()].sort();
  const requested = language && (labels.has(language) ? language
    : tags.find(tag => tag.split('-')[0] === language.split('-')[0]));
  const chosen = requested || (labels.has('en') ? 'en' : tags[0]);
  if (chosen === undefined) return null;
  return { value: labels.get(chosen)!, language: chosen, direction: direction(chosen, labels.get(chosen)!),
    basis: requested && language ? 'requested' as const : 'fallback' as const };
}

export function fallbackAvatar(type: ResourceType, reference: string): AvatarDescriptor {
  return { kind: 'fallback', policy: FALLBACK_POLICY, resourceType: type,
    key: createHash('sha256').update(`${FALLBACK_POLICY}\0${type}\0${reference}`).digest('hex').slice(0, 32) };
}

function avatar(type: ResourceType, reference: string, row: AvatarRow | undefined): AvatarDescriptor {
  // Every hidden or missing case shares one fallback: no asset, use or reason leaks.
  if (!row?.selection || !avatarImageEligible(row)) return fallbackAvatar(type, reference);
  return { kind: 'image', selection: row.selection, url: `/v1/media/avatars/${row.selection}`,
    representation:row.representation!,use:row.use!,nsfw:row.nsfw??'unknown',ageRating:row.ageRating??UNASSESSED,conceal:row.conceal??false,
    mediaType: row.mediaType!, width: row.width!, height: row.height!, crop: row.crop,
    basis: { policy: AVATAR_POLICY, context: row.context! } };
}

/** One bounded graph query resolves type, labels and public disclosure for the batch. */
async function graphRows(env: WorkActivationEnvironment, resources: readonly string[], localBasis = false) {
  // Test the owner branch, not BOUND(?work): an OPTIONAL can bind an initially
  // absent Work from its own label/head pattern and attach an unrelated owner.
  const workType = '?type IN ("work", "main-version", "release", "occurrence", "realization")';
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
    PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#> PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
    SELECT ?epoch ?sequence ?hold ?r ?type ?work ?head ?public ?label ?erased ?nameHead ?namePayload ?mergedInto ?profileAvatarSelection ?projectionSubject ?projectionFrame ?post WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ?epoch ; rv:sequence ?sequence .
        OPTIONAL { ${iri(DATASET)} rv:restoreHold ?hold } }
      OPTIONAL {
        VALUES ?r { ${resources.map(iri).join(' ')} }
        { GRAPH ${iri(GRAPHS.current)} {
          { ?r a schema:CreativeWork ; rv:mainVersion ?main . BIND(?r AS ?work) BIND("work" AS ?type) }
          UNION { ?r a rv:MainVersion ; rv:work ?work . BIND("main-version" AS ?type) }
          UNION { ?r a rv:Release ; rv:work ?work . BIND("release" AS ?type) }
          UNION { ?r a schema:ListItem ; rv:structure ?structure .
            ?structure rv:structureOf ?component ; rv:selectedGeneration ?generation .
            ?placement rv:generation ?generation ; rv:occurrence ?r ; a rv:OccurrencePlacement .
            FILTER NOT EXISTS { ?placement rv:removedBy ?removedBy }
            { ?component a rv:MainVersion ; rv:work ?work }
            UNION { ?component a schema:CreativeWork ; rv:mainVersion ?main . BIND(?component AS ?work) }
            BIND("occurrence" AS ?type) }
          UNION { ?r a rv:TextContribution ; rv:work ?work ; rv:publicationHead ?publication .
            BIND("realization" AS ?type) }
          UNION { ?r a rv:Realization ; rv:work ?work ; rv:head ?realizationRevision .
            BIND("realization" AS ?type) }
          UNION { ?r a rv:Space . BIND("space" AS ?type) }
          UNION { ?r a rv:Agent ; rv:head ?agentHead .
            FILTER EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ?agentHead a rv:RevisionAnchor ;
              rv:component ?r ; rv:modelRevision <https://rezics.com/definition/agent-provision-v1> .
              FILTER NOT EXISTS { ?agentHead a rv:ErasedRevision } } }
            FILTER NOT EXISTS { ?r a rv:AgentTombstone }
            FILTER NOT EXISTS { ?r rv:protectionHead ?agentProtection }
            FILTER NOT EXISTS { ?r rv:profileDisclosure rv:Private }
            BIND("agent" AS ?type) }
          UNION { ?r a rv:Zone ; rv:zoneState rv:Active . BIND("zone" AS ?type) }
          UNION { ?r a rv:Collection ; rv:collectionState rv:Active .
            FILTER NOT EXISTS { ?r rv:protectionHead ?protection }
            BIND("collection" AS ?type) }
          UNION { ?r a rv:Realm ; rv:realmState rv:Active . BIND("realm" AS ?type) }
          UNION { ?r a skos:Concept ; rv:conceptState rv:Active . BIND("concept" AS ?type) }
          UNION { ?r a rv:SemanticContext ; rv:contextState rv:Active . BIND("context" AS ?type) }
          UNION { ?r a rv:Character ; rv:semanticHead ?semanticHead . BIND("character" AS ?type) }
          UNION { ?r a rv:Role ; rv:semanticHead ?semanticHead . BIND("role" AS ?type) }
          UNION { ?r a rv:SemanticDefinition ; rv:definitionKind rv:RelationDefinition ;
            rv:definitionHead ?definitionHead . BIND("relation-definition" AS ?type) }
          UNION { ?r a rv:Projection ; rv:projectionOf ?projectionSubject ; rv:frame ?projectionFrame ;
            rv:projectionHead ?projectionHead . BIND("projection" AS ?type) }
          UNION { ?r rv:semanticHead ?semanticHead . BIND("resource" AS ?type) }
          UNION { ?r a rv:Post ; rv:head ?head ; rdfs:label ?label .
            BIND(true AS ?post) BIND("resource" AS ?type) }
        } }
        UNION { GRAPH ${iri(GRAPHS.revisions)} {
          ?r a rv:FixedRelease ; rv:work ?work . BIND("release" AS ?type) } }
        OPTIONAL { GRAPH ${iri(GRAPHS.current)} { ?r rv:mergedInto ?mergedInto } }
        OPTIONAL { FILTER(${workType})
          GRAPH ${iri(GRAPHS.current)} { ?work rdfs:label ?label } }
        OPTIONAL { FILTER(${workType})
          GRAPH ${iri(GRAPHS.current)} { ?work rv:head ?head } }
        OPTIONAL { FILTER(?type = "space") GRAPH ${iri(GRAPHS.current)} { ?r rdfs:label ?label } }
        OPTIONAL { FILTER(?type IN ("agent","zone")) GRAPH ${iri(GRAPHS.current)} {
          { ?r rdfs:label ?label }
          UNION { ?r a rv:Zone ; rv:space ?zoneSpace . FILTER NOT EXISTS { ?r rdfs:label ?zoneLabel }
            ?zoneSpace rdfs:label ?label }
        } }
        OPTIONAL { FILTER(?type = "agent") GRAPH ${iri(GRAPHS.current)} {
          ?r rv:profileAvatarSelection ?profileAvatarSelection } }
        OPTIONAL { FILTER(?type = "collection") GRAPH ${iri(GRAPHS.current)} { ?r schema:name ?label } }
        OPTIONAL { FILTER(?type = "collection") GRAPH ${iri(GRAPHS.current)} { ?r rv:collectionNameHead ?nameHead }
          OPTIONAL { GRAPH ${iri(GRAPHS.revisions)} { ?nameHead a rv:CollectionNameRevision ;
            rv:component ?r ; rv:profilePayload ?namePayload } } }
        OPTIONAL { FILTER(?type = "concept") GRAPH ${iri(GRAPHS.current)} { ?r skos:prefLabel ?label } }
        BIND(IF(${workType}, EXISTS {
          GRAPH ${iri(GRAPHS.current)} { ?variant rv:resource ?work ; rv:contentPublicationHead ?pin }
          GRAPH ${iri(GRAPHS.revisions)} { ?pin rv:contentRevision ?contentRevision .
            ?contentRevision a rv:ErasedRevision }
        } || EXISTS { GRAPH ${iri(GRAPHS.current)} { ?work rv:head ?erasedHead }
          GRAPH ${iri(GRAPHS.revisions)} { ?erasedHead a rv:ErasedRevision } }
          || EXISTS { GRAPH ${iri(GRAPHS.current)} { ?work rv:protectionHead ?protection } }, false)
          || EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ?r a rv:ErasedRevision } }
          || EXISTS { GRAPH ${iri(GRAPHS.current)} { ?r ?headPredicate ?resourceHead .
            VALUES ?headPredicate { rv:head rv:releaseHead rv:semanticHead rv:projectionHead } }
            GRAPH ${iri(GRAPHS.revisions)} { ?resourceHead a rv:ErasedRevision } }
          || EXISTS { GRAPH ${iri(GRAPHS.current)} { ?r rv:structure ?erasedStructure .
            ?erasedStructure rv:structureHead ?structureRevision }
            GRAPH ${iri(GRAPHS.revisions)} { ?structureRevision a rv:ErasedRevision } }
          || EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ?r rv:selectedDraft ?erasedDraft .
            ?erasedDraft a rv:ErasedRevision } }
          || EXISTS { GRAPH ${iri(GRAPHS.current)} { ?r rv:publicationHead ?publication }
            GRAPH ${iri(GRAPHS.revisions)} { ?publication rv:selectedDraft ?erasedDraft .
              ?erasedDraft a rv:ErasedRevision } } AS ?erased)
        BIND(IF(BOUND(?post), EXISTS { ${publicPost('?r')} }, IF(?type = "realm", EXISTS { GRAPH ${iri(GRAPHS.current)} {
          ?r rv:space ?realmSpace . ?realmSpace rv:realmCapability ?r ; rv:disclosure rv:Public } },
          IF(?type = "concept", true,
          IF(?type = "context" || ?type = "collection", EXISTS { GRAPH ${iri(GRAPHS.current)} { ?r rv:disclosure rv:Public } },
          IF(?type IN ("space","zone"),
          EXISTS { GRAPH ${iri(GRAPHS.current)} { ?r rv:disclosure rv:Public } },
          IF(?type = "agent", true,
          IF(${workType} && BOUND(?work), EXISTS { ${publicWork('?work', '?pm')} }, false)))))))
          AS ?public)
      }
    }`);
  const bindings = result.results?.bindings ?? [];
  const control = bindings[0];
  if (!control?.epoch || control.epoch.value !== env.lineage.dataEpoch || control.hold) {
    throw new MediaUnavailable('graph lineage is unavailable');
  }
  const rows = new Map<string, GraphRow>();
  const redirects = new Map<string, string>();
  const ambiguous = new Set<string>();
  // Keep protection/erasure flags until all rows are collected: dropping only
  // the Work row could let its descriptive semantic component revive the identity.
  const erased = new Set(bindings.filter(binding => binding.erased?.value === 'true')
    .flatMap(binding => binding.r ? [binding.r.value] : []));
  for (const binding of bindings) {
    const reference = binding.r?.value;
    if (!reference || !binding.type || erased.has(reference)) continue;
    if (binding.mergedInto) {
      const target = binding.mergedInto;
      if (target.type !== 'uri' || !nativeId.test(target.value)
        || redirects.has(reference) && redirects.get(reference) !== target.value) {
        throw new MediaUnavailable('Identity merge projection is invalid');
      }
      redirects.set(reference, target.value);
    }
    const type = binding.type.value as ResourceType;
    const previous = rows.get(reference);
    if (previous && typePriority.indexOf(previous.type) < typePriority.indexOf(type)) continue;
    const row: GraphRow = previous?.type === type ? previous : { type,
      work: binding.work?.value ?? null, head: binding.head?.value ?? null,
      public: binding.public?.value === 'true', labels: new Map() };
    row.post = row.post || binding.post?.value === 'true';
    const label = binding.label;
    const tag = (label as { 'xml:lang'?: string } | undefined)?.['xml:lang'];
    // Agent provisioning records a plain display name. Keep its language
    // unknown rather than discarding the public profile or guessing a tag.
    if (label && (tag || row.type === 'agent')) row.labels.set(tag?.toLowerCase() ?? '', label.value);
    if (row.type === 'projection' && binding.projectionSubject && binding.projectionFrame) {
      row.projection ??= { subject: binding.projectionSubject.value, frames: new Set() };
      // A projection names one subject; a second one is corrupt state, never a partial answer.
      if (row.projection.subject !== binding.projectionSubject.value) { ambiguous.add(reference); continue; }
      row.projection.frames.add(binding.projectionFrame.value);
    }
    if (row.type === 'agent' && binding.profileAvatarSelection) {
      row.profileAvatarSelections ??= new Set();
      row.profileAvatarSelections.add(binding.profileAvatarSelection.value);
    }
    if (row.type === 'collection') {
      if (label) row.labels.set(tag?.toLowerCase() || 'en', label.value);
      if (binding.nameHead) {
        try {
          row.localizedName = checkedCollectionName(JSON.parse(binding.namePayload!.value));
          if (label?.value !== row.localizedName.labels[row.localizedName.original]
            || tag?.toLowerCase() !== row.localizedName.original.toLowerCase()) continue;
        } catch { continue; }
      }
    }
    rows.set(reference, row);
  }
  for (const reference of ambiguous) rows.delete(reference);
  const dependencies = bindings.map(({ sequence: _sequence, ...binding }) =>
    Object.entries(binding).sort(([a], [b]) => a.localeCompare(b)))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return { rows, redirects, generation: localBasis
    ? `${control.epoch.value}:${createHash('sha256').update(JSON.stringify(dependencies)).digest('hex')}`
    : `${control.epoch.value}:${control.sequence?.value ?? '0'}` };
}

const partOf = ({ resolution: _resolution, parts: _parts, ...part }: AvailableSummary): PartSummary => part;

/** A projection is available when its subject and every frame are, to the same reader; it is public
 * only when all of them are, so its disclosure is the most restrictive of its parts. The parts are
 * ordinary summaries read in pages of MAX_SUMMARY_BATCH: at most one more page per 64 distinct
 * parts (nine per projection at most), on the same graph generation, and the name is the subject's. */
async function readProjectionSummaries(env: WorkActivationEnvironment, reader: SummaryReader, input: SummaryInput,
  projections: ReadonlyMap<string, GraphRow>, generation: string, cost: SummaryBatch['cost'],
  client?: PoolClient) {
  const result = new Map<string, AvailableSummary>();
  if (!projections.size) return result;
  const references = [...new Set([...projections.values()].flatMap(row => [row.projection!.subject, ...row.projection!.frames]))];
  const parts = new Map<string, AvailableSummary>();
  for (let offset = 0; offset < references.length; offset += MAX_SUMMARY_BATCH) {
    const page = await readSummaryPage(env, undefined, reader, { ...input,
      resources: references.slice(offset, offset + MAX_SUMMARY_BATCH), includeCollections: true,
      projectionPart: true }, client);
    if (!input.localBasis && page.generation.graph !== generation) throw new SummaryGraphMoved('Projection parts graph moved');
    for (const summary of page.summaries) {
      if (summary.status === 'available' && summary.type !== 'projection') parts.set(summary.reference, summary);
    }
    for (const key of ['graphQueries', 'mediaQueries', 'accessChecks', 'accessQueries'] as const) {
      cost[key] += page.cost[key];
    }
  }
  for (const [reference, row] of projections) {
    const subject = parts.get(row.projection!.subject);
    const frames = [...row.projection!.frames].sort().map(frame => parts.get(frame));
    if (!subject || frames.some(frame => !frame)) continue;
    const available = frames as AvailableSummary[];
    result.set(reference, { reference, status: 'available', type: 'projection', base: 'projection', work: null,
      address: identityCanonical('projection', reference, subject.name.value),
      disclosure: [subject, ...available].every(part => part.disclosure === 'public') ? 'public' : 'restricted',
      name: subject.name, avatar: fallbackAvatar('projection', reference),
      parts: { subject: partOf(subject), frames: available.map(partOf) } });
  }
  return result;
}

/** Resource summaries for at most 64 references. The Work path costs one graph
 * query, one media query and one batched Access query. Additional owner types
 * use their current read functions; the returned counters include those probes. */
async function readSummaryPage(env: WorkActivationEnvironment, media: SummaryMedia | undefined,
  reader: SummaryReader, input: SummaryInput, client?: PoolClient): Promise<SummaryBatch & { redirects: Map<string, string> }> {
  if (!input.resources.length || input.resources.length > MAX_SUMMARY_BATCH
    || input.resources.some(resource => resource.length > MAX_SUMMARY_REFERENCE_LENGTH || !summaryReference.test(resource))
    || (input.context !== DEFAULT_MEDIA_CONTEXT && !nativeId.test(input.context))
    || (input.language !== null && !languageTag.test(input.language))) {
    throw new MediaInvalid('resource summary request is invalid');
  }
  // Foreign references never enter graph, disclosure or Access queries. They
  // retain their input position and the same minimal unavailable item.
  const unique = [...new Set(input.resources.filter(resource => nativeId.test(resource)))];
  const graph = await graphRows(env, unique, input.localBasis);
  const cost = { graphQueries: 1, mediaQueries: 0, accessChecks: 0, accessQueries: 0 };
  const noteNameProbe = (batch: readonly Pick<DisclosureTarget, 'owner' | 'component' | 'nameOwnerResolved'>[]) => {
    if (!hasDisclosure(env)) return;
    // Covers share the transport batch with names. Count each owner batch
    // containing names, rather than packing names across those boundaries.
    for (let offset = 0; offset < batch.length; offset += DISCLOSURE_COST.batch) {
      if (batch.slice(offset, offset + DISCLOSURE_COST.batch).some(target => target.owner === 'graph'
        && (target.component === 'name' || target.component === 'title') && !target.nameOwnerResolved)) {
        cost.graphQueries += DISCLOSURE_COST.nameOwnerQueries;
      }
    }
  };
  // Check the entire requested batch, including missing identities, before
  // Access/name/avatar hydration. Rated and absent rows then have the same
  // media generation and cost envelope as well as the same unavailable item.
  // The graph row's type already proves a non-Agent has no agent name owner.
  // Absent rows and Agents still probe: a missing identity is not that proof.
  const settledNameOwner = (row: GraphRow | undefined) =>
    input.settleNonAgentNameOwners && row !== undefined && row.type !== 'agent'
      ? { nameOwnerResolved: true as const } : {};
  const initialTargets = unique.map(reference => {
    const row = graph.rows.get(reference);
    return { owner: 'graph' as const, resource: reference, component: 'name' as const,
      revision: reference === row?.work ? row.head : null, work: row?.work,
      workRevision: row?.head, context: input.context === DEFAULT_MEDIA_CONTEXT ? undefined : input.context,
      ...settledNameOwner(row) };
  });
  const initialDecisions = await discloseInventory(env, initialTargets, reader.viewer ?? ANONYMOUS_VIEWER,
    input.channel ?? 'summary', client);
  if (hasDisclosure(env)) cost.accessQueries += Math.ceil(unique.length / MAX_SUMMARY_BATCH);
  noteNameProbe(initialTargets);
  for (const [index, reference] of unique.entries()) {
    if (initialDecisions[index] !== 'visible') graph.rows.delete(reference);
  }
  const readable = new Map<string, GraphRow>();
  const restricted = new Map<string, string>();
  const special = new Map<string, GraphRow>();
  const pages = new Map<string, GraphRow>();
  const projections = new Map<string, GraphRow>();
  for (const reference of unique) {
    const row = graph.rows.get(reference);
    if (!row) continue;
    if (row.type === 'projection') {
      // Its disclosure is wholly its parts': a projection of one nested in another does not exist.
      if (!input.projectionPart && row.projection?.frames.size) projections.set(reference, row);
      continue;
    }
    if (row.post) {
      if (!selectName(row.labels, null)) continue;
      if (row.public) readable.set(reference, row);
      else restricted.set(reference, reference);
      continue;
    }
    if (row.type === 'collection' && !input.includeCollections) continue;
    if (['realm', 'context', 'character', 'role', 'relation-definition', 'resource', 'collection'].includes(row.type)) {
      special.set(reference, row);
      continue;
    }
    if (!selectName(row.labels, null)) continue;
    if (row.type === 'space' || row.type === 'zone') {
      pages.set(reference, row);
      continue;
    }
    if (row.public) { readable.set(reference, row); continue; }
    if (row.work) {
      restricted.set(reference, row.work);
    }
  }
  const works = [...new Set(restricted.values())];
  cost.accessChecks = works.length;
  let admitted = new Set<string>();
  if (works.length && reader.canReadWorks) {
    admitted = new Set(await reader.canReadWorks(works));
    cost.accessQueries = 1;
  } else if (works.length && reader.canReadWork) {
    cost.accessQueries = works.length;
    const decisions: (string | null)[] = [];
    if (client) {
      for (const work of works) decisions.push(await reader.canReadWork(work) ? work : null);
    } else {
      decisions.push(...await Promise.all(works.map(async work =>
        await reader.canReadWork!(work) ? work : null)));
    }
    admitted = new Set(decisions.filter((work): work is string => work !== null));
  }
  for (const [reference, work] of restricted) {
    if (admitted.has(work)) readable.set(reference, graph.rows.get(reference)!);
  }
  const countPageAccess = () => { cost.accessChecks++; cost.accessQueries++; };
  const pageVisibility = await readSummaryPages(env, [...pages.keys()], reader, countPageAccess);
  if (pages.size) cost.graphQueries++;
  for (const [reference, isPublic] of pageVisibility) {
    const row = pages.get(reference)!;
    row.public = isPublic;
    readable.set(reference, row);
  }
  // Owner reads validate current state and disclosure before a name or avatar is hydrated.
  const realms = [...special].filter(([, row]) => row.type === 'realm').map(([reference]) => reference);
  const realmProofs = new Map<string, string>();
  for (const realm of realms) {
    if (!special.get(realm)!.public && reader.realmReadProof) {
      cost.accessChecks++; cost.accessQueries++;
      const proof = await reader.realmReadProof(realm);
      if (proof) realmProofs.set(realm, proof);
    }
  }
  const realmNames = await readPublicRealmNames(env, realms, new Set(realmProofs.keys()));
  if (realms.length) cost.graphQueries += 2;
  const profileNames = await realmProfileNames(env, [...realmNames.keys()]);
  if (realmNames.size) cost.graphQueries++;
  const contextRefs = [...special].filter(([, row]) => row.type === 'context').map(([reference]) => reference);
  const contextBatch = await readContextSummaryBatch(env, contextRefs,
    input.context === DEFAULT_MEDIA_CONTEXT ? null : input.context,
    async contexts => {
      if (reader.canReadPrivateContexts) return reader.canReadPrivateContexts(contexts);
      if (!reader.canReadPrivateContext) return new Set<string>();
      return new Set((await Promise.all(contexts.map(async context =>
        await reader.canReadPrivateContext!(context) ? context : null)))
        .filter((context): context is string => context !== null));
    },
    count => { cost.accessChecks += count;
      if (reader.canReadPrivateContexts) cost.accessQueries++;
      else if (reader.canReadPrivateContext) cost.accessQueries += count; });
  cost.graphQueries += contextBatch.graphQueries;
  const relationRefs = [...special].filter(([, row]) => row.type === 'relation-definition')
    .map(([reference]) => reference);
  const semanticRefs = new Map([...special].filter(([, row]) =>
    row.type === 'character' || row.type === 'role' || row.type === 'resource')
    .map(([reference, row]) => [reference, row.type as 'character' | 'role' | 'resource']));
  const privateCollections = [...special].filter(([, row]) => row.type === 'collection' && !row.public)
    .map(([reference]) => reference);
  const semanticResources = [...new Set([...semanticRefs.keys(), ...relationRefs, ...privateCollections])];
  let admittedSemantics = new Set<string>();
  let publicSemantics: ReadonlySet<string> = new Set();
  if (semanticResources.length && reader.canReadSemantics) {
    cost.accessChecks += semanticResources.length;
    const decision = await reader.canReadSemantics(semanticResources);
    if ('public' in decision) {
      publicSemantics = decision.public;
      admittedSemantics = new Set([...decision.public, ...decision.granted]);
      cost.graphQueries++;
    } else admittedSemantics = new Set(decision);
    cost.accessQueries++;
  } else if (semanticResources.length && reader.canReadSemantic) {
    cost.accessChecks += semanticResources.length;
    const decisions: (string | null)[] = [];
    if (client) {
      for (const resource of semanticResources) {
        decisions.push(await reader.canReadSemantic(resource) ? resource : null);
      }
    } else {
      decisions.push(...await Promise.all(semanticResources.map(async resource =>
        await reader.canReadSemantic!(resource) ? resource : null)));
    }
    admittedSemantics = new Set(decisions.filter((resource): resource is string => resource !== null));
    cost.accessQueries += semanticResources.length;
  }
  const admittedRelations = relationRefs.filter(reference => admittedSemantics.has(reference));
  const relationDefinitions = await readRelationDefinitionNames(env, admittedRelations,
    contextBatch.selectedNames);
  if (admittedRelations.length) cost.graphQueries++;
  const admittedResources = new Map([...semanticRefs].filter(([reference]) => admittedSemantics.has(reference)));
  const semanticNames = await readSemanticResourceNames(env, admittedResources, reader);
  if (admittedResources.size) cost.graphQueries++;
  for (const [reference, row] of special) {
    if (row.type === 'collection') {
      if ((row.public || admittedSemantics.has(reference)) && selectName(row.labels, null)) {
        readable.set(reference, row);
      }
      continue;
    }
    if (row.type === 'realm') {
      const name = realmNames.get(reference);
      if (name) { row.localizedName = profileNames.get(reference);
        row.labels.set(row.localizedName?.original ?? 'en', name); readable.set(reference, row); }
      continue;
    }
    if (row.type === 'context') {
      const context = contextBatch.contexts.get(reference);
      if (!context) continue;
      row.public = context.disclosure === 'public';
      row.labels.set('en', `Context ${reference.slice(-8)}`);
      readable.set(reference, row);
      continue;
    }
    if (!admittedSemantics.has(reference)) continue;
    if (row.type === 'relation-definition') {
      const names = relationDefinitions.get(reference);
      if (!names) continue;
      row.labels = names;
    } else {
      const names = semanticNames.get(reference);
      if (!names) continue;
      row.labels = names;
    }
    if (!row.labels.size) {
      const kind = row.type === 'character' ? 'Character' : row.type === 'role' ? 'Role'
        : row.type === 'resource' ? 'Resource' : 'Relation definition';
      row.labels.set('en', `${kind} ${reference.slice(-8)}`);
    }
    row.public = publicSemantics.has(reference);
    readable.set(reference, row);
  }
  for (const [reference, row] of readable) {
    const selected = contextBatch.selectedNames.get(reference);
    if (selected?.size) row.labels = selected;
  }
  let avatars = new Map<string, AvatarRow>();
  let mediaGeneration: string | null = null;
  if (media && readable.size && !contextBatch.selectedContextDenied) {
    const hydrated = await media.avatarRows([...readable.keys()], input.context);
    cost.mediaQueries = 1;
    if (hydrated) {
      avatars = hydrated.rows;
      mediaGeneration = `${hydrated.generation.dataEpoch}:${hydrated.generation.sequence}`;
      // Agent profiles adopt media selections explicitly. Summaries follow the
      // same current reference as the profile read and avatar delivery route.
      for (const [reference, row] of readable) {
        if (row.type === 'agent' && (row.profileAvatarSelections?.size !== 1
          || !row.profileAvatarSelections.has(avatars.get(reference)?.selection ?? ''))) avatars.delete(reference);
      }
    }
  }
  // Hydrated names/images cannot outlive a disclosure or membership change.
  const fencedNames = await readPublicRealmNames(env, realms, new Set(realmProofs.keys()));
  if (realms.length) cost.graphQueries += 2;
  for (const realm of realms) {
    const proof = realmProofs.get(realm);
    if (proof) { cost.accessChecks++; cost.accessQueries++; }
    if (!fencedNames.has(realm) || proof && await reader.realmReadProof!(realm) !== proof) readable.delete(realm);
  }
  const fencedPages = await readSummaryPages(env, [...pageVisibility.keys()], reader, countPageAccess);
  if (pageVisibility.size) cost.graphQueries++;
  for (const [reference, isPublic] of pageVisibility) {
    // A visibility change during hydration requires a fresh read. Never emit
    // a public summary/cache policy based on a now-private page.
    if (fencedPages.get(reference) !== isPublic) readable.delete(reference);
  }
  if (reader.visibleRecords) {
    const visible = await reader.visibleRecords([...readable.keys()]);
    for (const reference of readable.keys()) if (!visible.has(reference)) readable.delete(reference);
  }
  // The final assembly gates names and assets together. No optional title-only
  // callback can grant disclosure, and a hidden asset becomes the usual fallback.
  const targets: DisclosureTarget[] = [];
  const entries = [...readable];
  const nameIndexes = new Map<string, number>(), assetIndexes = new Map<string, number>();
  for (const [reference, row] of entries) {
    nameIndexes.set(reference, targets.length);
    targets.push({ owner: 'graph', resource: reference, component: 'name',
      revision: reference === row.work ? row.head : null, work: row.work,
      workRevision: row.head, context: input.context === DEFAULT_MEDIA_CONTEXT ? undefined : input.context,
      ...settledNameOwner(row) });
    const asset = avatars.get(reference)?.asset;
    if (asset) {
      assetIndexes.set(reference, targets.length);
      targets.push({ owner: 'media', resource: `https://rezics.com/id/${asset}`, component: 'cover' });
    }
  }
  const final = reader.viewer?.signedIn
    ? await discloseInventoryWithAnonymousNames(env, targets, reader.viewer, input.channel ?? 'summary', client)
    : { decisions: await discloseInventory(env, targets, reader.viewer ?? ANONYMOUS_VIEWER,
      input.channel ?? 'summary', client), anonymousNames: [], anonymousNameProbes: 0 };
  const decisions = final.decisions;
  if (hasDisclosure(env)) cost.accessQueries += Math.ceil(targets.length / MAX_SUMMARY_BATCH);
  noteNameProbe(targets);
  cost.accessQueries += final.anonymousNameProbes;
  cost.graphQueries += final.anonymousNameProbes * DISCLOSURE_COST.nameOwnerQueries;
  for (const [reference] of entries) {
    if (decisions[nameIndexes.get(reference)!] !== 'visible') readable.delete(reference);
    const assetIndex = assetIndexes.get(reference);
    if (assetIndex !== undefined && decisions[assetIndex] !== 'visible') avatars.delete(reference);
  }
  // Agent graph flags cannot make a controller's private name public. Reuse
  // the anonymous name decision from the final exact-target owner snapshot;
  // viewer delivery and public classification share its current authority cut.
  const nameIsPublic = (reference: string) => !hasDisclosure(env) || !reader.viewer?.signedIn
    || final.anonymousNames[nameIndexes.get(reference)!] === 'visible';
  const projectionSummaries = await readProjectionSummaries(env, reader, input, projections, graph.generation, cost, client);
  const summaries = input.resources.map((reference): ResourceSummary => {
    const projection = projectionSummaries.get(reference);
    if (projection) return projection;
    const row = readable.get(reference);
    if (!row) return { reference, status: 'unavailable' };
    const selectedContext = contextBatch.selectedNames.has(reference)
      ? contextBatch.contexts.get(input.context) : undefined;
    return { reference, status: 'available', type: row.type,
      address: identityCanonical(row.type,reference,selectDisplayName(row.localizedName ?? row.labels,
        input.languages ?? readerLanguages(input.language))!.value),
      base: summaryBases[row.type], work: row.work,
      disclosure: row.public && nameIsPublic(reference) ? 'public' : 'restricted',
      name: { ...selectDisplayName(row.localizedName ?? row.labels,
        input.languages ?? readerLanguages(input.language))!,
        ...(selectedContext?.preferenceRevision
          ? { context: input.context, preferenceRevision: selectedContext.preferenceRevision } : {}) },
      avatar: avatar(row.type, reference, avatars.get(reference)) };
  });
  const available = summaries.filter(summary => summary.status === 'available');
  const addresses = await canonicalAddresses(env, available, client);
  if (available.some(summary => ['space','realm','zone'].includes(summary.type))) cost.graphQueries++;
  for (const summary of available) summary.address = addresses.get(summary.reference)!;
  return { summaries, generation: { graph: graph.generation, media: mediaGeneration,addresses: addressGeneration(summaries) }, cost,
    redirects: graph.redirects };
}

/** At most 33 owner batches of 64 identities, regardless of converging paths.
 * Each hop uses the same disclosure/name policy as the requested source. Only
 * the source's summary is delivered; its typed resolution never substitutes
 * the survivor's title, media, revision or personal state. Ordinary reads incur
 * no extra round trip. Merge chains use one graph generation and a 10s budget. */
export async function readResourceSummaries(env: WorkActivationEnvironment, media: SummaryMedia | undefined,
  reader: SummaryReader, input: SummaryInput, client?: PoolClient): Promise<SummaryBatch> {
  const deadline = Date.now() + MERGE_COST.deadlineMs;
  const first = await readSummaryPage(env, media, reader, input, client);
  const graphDependencies = [first.generation.graph];
  if (input.resolveMerges === false) return { summaries: first.summaries,
    generation: first.generation, cost: first.cost };
  const summaries = new Map(first.summaries.map(summary => [summary.reference, summary]));
  const redirects = new Map(first.redirects);
  const paths = [...new Set(input.resources)].map(source => ({ source, current: source,
    seen: new Set([source]), hops: 0, hidden: false }));
  let merged = false;
  for (;;) {
    const frontier = new Set<string>();
    for (const path of paths) {
      if (path.hidden || summaries.get(path.current)?.status !== 'available') { path.hidden = true; continue; }
      const next = redirects.get(path.current);
      if (!next) continue;
      if (path.hops === MERGE_COST.redirectHops || path.seen.has(next)) {
        throw new MediaUnavailable('Identity merge cycle or excessive depth');
      }
      merged = true;
      path.seen.add(next); path.current = next; path.hops++;
      if (!summaries.has(next)) frontier.add(next);
    }
    if (!frontier.size) {
      // Cached/converging paths can still have an unread edge.
      if (paths.some(path => !path.hidden && redirects.has(path.current))) continue;
      break;
    }
    if (Date.now() >= deadline) throw new MediaUnavailable('Identity merge read deadline exceeded');
    const page = await readSummaryPage(env, undefined, reader, { ...input, resources: [...frontier] }, client);
    if (!input.localBasis && page.generation.graph !== first.generation.graph) throw new MediaUnavailable('Identity merge graph moved');
    graphDependencies.push(page.generation.graph);
    for (const summary of page.summaries) summaries.set(summary.reference, summary);
    for (const [source, target] of page.redirects) redirects.set(source, target);
    for (const key of ['graphQueries', 'mediaQueries', 'accessChecks', 'accessQueries'] as const) {
      first.cost[key] += page.cost[key];
    }
  }
  if (merged) {
    if (Date.now() >= deadline) throw new MediaUnavailable('Identity merge read deadline exceeded');
    const control = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?epoch ?sequence ?hold WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ?epoch ; rv:sequence ?sequence
        OPTIONAL { ${iri(DATASET)} rv:restoreHold ?hold } } } LIMIT 2`, 4096)).results?.bindings ?? [];
    first.cost.graphQueries++;
    if (control.length !== 1 || control[0]?.hold
      || (input.localBasis ? control[0]?.epoch?.value !== env.lineage.dataEpoch
        : `${control[0]?.epoch?.value}:${control[0]?.sequence?.value}` !== first.generation.graph)) {
      throw new MediaUnavailable('Identity merge disclosure snapshot moved');
    }
  }
  const bySource = new Map(paths.map(path => [path.source, path]));
  const result: ResourceSummary[] = input.resources.map(reference => {
      const path = bySource.get(reference)!, summary = summaries.get(reference)!;
      if (path.hidden) return { reference, status: 'unavailable' };
      return summary.status === 'available' && path.hops ? { ...summary,
        address: (summaries.get(path.current) as Extract<ResourceSummary,{ status: 'available' }>).address,
        resolution: { state: 'merged' as const, source: reference, survivor: path.current, hops: path.hops } } : summary;
    });
  return { generation: { ...first.generation,
    ...(input.localBasis ? { graph: createHash('sha256').update(JSON.stringify(graphDependencies)).digest('hex') } : {}),
    addresses: addressGeneration(result) },cost: first.cost,summaries: result };
}

/** SQL name changes do not move the graph position. Conditional reads must
 * include canonical addresses in their generation so a rename changes ETags. */
function addressGeneration(summaries: readonly ResourceSummary[]): string {
  return createHash('sha256').update(JSON.stringify(summaries.map(summary => summary.status === 'available'
    ? [summary.reference,summary.address] : [summary.reference]))).digest('hex');
}

/** Main Version content availability for one summary: actual language basis or metadata-only. */
export async function readContentAvailability(env: WorkActivationEnvironment, mainVersion: string,
  language: string | null) {
  const { variants } = await listEligibleNativeVariants(env, mainVersion);
  const selection = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?contribution WHERE {
    GRAPH ${iri(GRAPHS.current)} { ${iri(mainVersion)} rv:selectionHead ?selection }
    GRAPH ${iri(GRAPHS.revisions)} { ?selection rv:contribution ?contribution } }`);
  const selected = selection.results?.bindings[0]?.contribution?.value ?? null;
  const languages = [...new Set(variants.map(variant => variant.language))].sort();
  if (!variants.length) {
    return { availability: 'metadata-only' as const, requestedLanguage: language, languages, selected: null };
  }
  const main = variants.find(variant => variant.contribution === selected) ?? null;
  const matching = language ? variants.filter(variant => variant.language === language) : [];
  const chosen = matching.find(variant => variant.contribution === selected) ?? matching[0]
    ?? main ?? variants[0]!;
  const basis = matching.length ? 'requested-language' as const
    : language ? 'language-fallback' as const : chosen === main ? 'main-default' as const : 'first-eligible' as const;
  return { availability: 'available' as const, requestedLanguage: language, languages,
    selected: { contribution: chosen.contribution, language: chosen.language,
      direction: direction(chosen.language), mainDefault: chosen === main, basis } };
}
