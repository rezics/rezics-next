import { createHash } from 'node:crypto';
import { DATASET, GRAPHS, RV, iri, type WorkActivationEnvironment } from '../work/activate.ts';
import { listEligibleNativeVariants } from '../work/native-variants.ts';
import { readContextSummaryBatch } from '../context/summary-read.ts';
import { PROFILES } from '../semantic/schema.ts';
import { readWorkComponentState } from '../work/history.ts';
import { readPublicRealmNames } from '../space/read.ts';
import { currentProfile } from '../realm-profile/schema.ts';
import { readerLanguages, selectDisplayName, type DisplayName, type LocalizedText } from '../display-language/select.ts';
import type { Base } from '../target/contract.ts';
import { AVATAR_POLICY, avatarImageEligible, DEFAULT_MEDIA_CONTEXT, MediaInvalid, MediaUnavailable,
  type AvatarRow, type MediaStore } from './store.ts';

export const MAX_SUMMARY_BATCH = 64;
export const FALLBACK_POLICY = 'avatar-fallback-v1';
const nativeId = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
const languageTag = /^[a-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/;
const RTL = new Set(['ar', 'arc', 'ckb', 'dv', 'fa', 'he', 'ks', 'ku', 'ps', 'sd', 'ug', 'ur', 'yi']);

export type ResourceType = 'work' | 'main-version' | 'space' | 'realm' | 'concept'
  | 'character' | 'context' | 'role' | 'relation-definition'
  | 'release' | 'occurrence' | 'realization' | 'resource';

/** Entry axes and owners without a supported exact revision path have no target base. */
export const summaryBases = { work: 'work', 'main-version': null, space: null,
  realm: null, concept: null, character: 'resource', context: 'resource',
  role: 'resource', 'relation-definition': null, release: 'release',
  occurrence: 'occurrence', realization: 'realization', resource: 'resource',
} as const satisfies Record<ResourceType, Base | null>;

export interface SummaryReader {
  /** Current approved membership, including its revocation generations. */
  realmReadProof?: (realm: string) => Promise<string | null>;
  /** Readable non-public Work, checked against current Access only after the graph read. */
  canReadWork?: (work: string) => Promise<boolean>;
  /** One Access owner request for all distinct non-public Works in the batch. */
  canReadWorks?: (works: readonly string[]) => Promise<ReadonlySet<string>>;
  /** Access fence checked against each exact graph head before a title is returned. */
  restrictedTitles?: (heads: readonly { work: string; revision: string }[], context: string) =>
    Promise<ReadonlySet<string>>;
  /** The exact semantic Resource must have a current Access read grant. */
  canReadSemantic?: (resource: string) => Promise<boolean>;
  canReadSemantics?: (resources: readonly string[]) => Promise<ReadonlySet<string>>;
  /** The Context owner checks private disclosure; public Contexts need no grant. */
  canReadPrivateContext?: (context: string) => Promise<boolean>;
  canReadPrivateContexts?: (contexts: readonly string[]) => Promise<ReadonlySet<string>>;
}

export interface SummaryInput {
  resources: readonly string[];
  context: string;
  language: string | null;
  languages?: readonly string[];
}

export type AvatarDescriptor =
  | { kind: 'image'; selection: string; url: string; mediaType: string; width: number; height: number;
    crop: string | null; basis: { policy: string; context: string } }
  | { kind: 'fallback'; policy: string; key: string; resourceType: ResourceType };

export type ResourceSummary =
  | { reference: string; status: 'available'; type: ResourceType; disclosure: 'public' | 'restricted';
    base: Base | null; work: string | null;
    name: DisplayName & { context?: string; preferenceRevision?: string };
    avatar: AvatarDescriptor }
  | { reference: string; status: 'unavailable' };

export interface SummaryBatch {
  summaries: ResourceSummary[];
  generation: { graph: string; media: string | null };
  /** Owner round trips spent by this batch, reported for the cost contract. */
  cost: { graphQueries: number; mediaQueries: number; accessChecks: number; accessQueries: number };
}

interface GraphRow { type: ResourceType; work: string | null; head: string | null;
  public: boolean; labels: Map<string, string>; localizedName?: LocalizedText }

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
  resources: ReadonlyMap<string, 'character' | 'role' | 'resource'>) {
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
    for (const property of state.properties as Array<{ predicate?: string;
      value?: { kind?: string; lexical?: string; language?: string } }>) {
      if (property.predicate !== 'https://schema.org/name' || !property.value?.lexical?.trim()) continue;
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
  'work', 'main-version', 'release', 'occurrence', 'realization',
  'space', 'realm', 'concept', 'context', 'character', 'role', 'relation-definition', 'resource',
];

export function direction(language: string): 'ltr' | 'rtl' {
  return RTL.has(language.split('-')[0]!.toLowerCase()) ? 'rtl' : 'ltr';
}

/** Requested exact tag, then its primary subtag, then English, then the lowest tag. */
export function selectName(labels: Map<string, string>, language: string | null) {
  const tags = [...labels.keys()].sort();
  const requested = language && (labels.has(language) ? language
    : tags.find(tag => tag.split('-')[0] === language.split('-')[0]));
  const chosen = requested || (labels.has('en') ? 'en' : tags[0]);
  if (!chosen) return null;
  return { value: labels.get(chosen)!, language: chosen, direction: direction(chosen),
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
    mediaType: row.mediaType!, width: row.width!, height: row.height!, crop: row.crop,
    basis: { policy: AVATAR_POLICY, context: row.context! } };
}

/** One bounded graph query resolves type, labels and public disclosure for the batch. */
async function graphRows(env: WorkActivationEnvironment, resources: readonly string[]) {
  // Test the owner branch, not BOUND(?work): an OPTIONAL can bind an initially
  // absent Work from its own label/head pattern and attach an unrelated owner.
  const workType = '?type IN ("work", "main-version", "release", "occurrence", "realization")';
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
    PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#> PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
    SELECT ?epoch ?sequence ?hold ?r ?type ?work ?head ?public ?label ?erased WHERE {
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
          UNION { ?r a rv:Space . BIND("space" AS ?type) }
          UNION { ?r a rv:Realm ; rv:realmState rv:Active . BIND("realm" AS ?type) }
          UNION { ?r a skos:Concept ; rv:conceptState rv:Active . BIND("concept" AS ?type) }
          UNION { ?r a rv:SemanticContext ; rv:contextState rv:Active . BIND("context" AS ?type) }
          UNION { ?r a rv:Character ; rv:semanticHead ?semanticHead . BIND("character" AS ?type) }
          UNION { ?r a rv:Role ; rv:semanticHead ?semanticHead . BIND("role" AS ?type) }
          UNION { ?r a rv:SemanticDefinition ; rv:definitionKind rv:RelationDefinition ;
            rv:definitionHead ?definitionHead . BIND("relation-definition" AS ?type) }
          UNION { ?r rv:semanticHead ?semanticHead . BIND("resource" AS ?type) }
        } }
        UNION { GRAPH ${iri(GRAPHS.revisions)} {
          ?r a rv:FixedRelease ; rv:work ?work . BIND("release" AS ?type) } }
        OPTIONAL { FILTER(${workType})
          GRAPH ${iri(GRAPHS.current)} { ?work rdfs:label ?label } }
        OPTIONAL { FILTER(${workType})
          GRAPH ${iri(GRAPHS.current)} { ?work rv:head ?head } }
        OPTIONAL { FILTER(?type = "space") GRAPH ${iri(GRAPHS.current)} { ?r rdfs:label ?label } }
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
            VALUES ?headPredicate { rv:head rv:releaseHead rv:semanticHead } }
            GRAPH ${iri(GRAPHS.revisions)} { ?resourceHead a rv:ErasedRevision } }
          || EXISTS { GRAPH ${iri(GRAPHS.current)} { ?r rv:structure ?erasedStructure .
            ?erasedStructure rv:structureHead ?structureRevision }
            GRAPH ${iri(GRAPHS.revisions)} { ?structureRevision a rv:ErasedRevision } }
          || EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ?r rv:selectedDraft ?erasedDraft .
            ?erasedDraft a rv:ErasedRevision } }
          || EXISTS { GRAPH ${iri(GRAPHS.current)} { ?r rv:publicationHead ?publication }
            GRAPH ${iri(GRAPHS.revisions)} { ?publication rv:selectedDraft ?erasedDraft .
              ?erasedDraft a rv:ErasedRevision } } AS ?erased)
        BIND(IF(?type = "realm", EXISTS { GRAPH ${iri(GRAPHS.current)} {
          ?r rv:space ?realmSpace . ?realmSpace rv:realmCapability ?r ; rv:disclosure rv:Public } },
          IF(?type = "concept", true,
          IF(?type = "context", EXISTS { GRAPH ${iri(GRAPHS.current)} { ?r rv:disclosure rv:Public } },
          IF(?type = "space",
          EXISTS { GRAPH ${iri(GRAPHS.current)} { ?r rv:disclosure rv:Public } },
          IF(${workType}, EXISTS { GRAPH ${iri(GRAPHS.current)} { ?work rv:mainVersion ?pm . ?pm rv:selectionHead ?ps }
            GRAPH ${iri(GRAPHS.revisions)} { ?ps rv:publicationDecision ?pd . ?pd rv:disclosure rv:Public } }, false)))))
          AS ?public)
      }
    }`);
  const bindings = result.results?.bindings ?? [];
  const control = bindings[0];
  if (!control?.epoch || control.epoch.value !== env.lineage.dataEpoch || control.hold) {
    throw new MediaUnavailable('graph lineage is unavailable');
  }
  const rows = new Map<string, GraphRow>();
  // A descriptive semantic component cannot revive an erased owner's identity.
  const erased = new Set(bindings.filter(binding => binding.erased?.value === 'true')
    .flatMap(binding => binding.r ? [binding.r.value] : []));
  for (const binding of bindings) {
    const reference = binding.r?.value;
    if (!reference || !binding.type || erased.has(reference)) continue;
    const type = binding.type.value as ResourceType;
    const previous = rows.get(reference);
    if (previous && typePriority.indexOf(previous.type) < typePriority.indexOf(type)) continue;
    const row = previous?.type === type ? previous : { type,
      work: binding.work?.value ?? null, head: binding.head?.value ?? null,
      public: binding.public?.value === 'true', labels: new Map() };
    const label = binding.label;
    const tag = (label as { 'xml:lang'?: string } | undefined)?.['xml:lang'];
    if (label && tag) row.labels.set(tag.toLowerCase(), label.value);
    rows.set(reference, row);
  }
  return { rows, generation: `${control.epoch.value}:${control.sequence?.value ?? '0'}` };
}

/** Resource summaries for at most 64 references. The Work path costs one graph
 * query, one media query and one batched Access query. Additional owner types
 * use their current read functions; the returned counters include those probes. */
export async function readResourceSummaries(env: WorkActivationEnvironment, media: MediaStore | undefined,
  reader: SummaryReader, input: SummaryInput): Promise<SummaryBatch> {
  if (!input.resources.length || input.resources.length > MAX_SUMMARY_BATCH
    || input.resources.some(resource => !nativeId.test(resource))
    || (input.context !== DEFAULT_MEDIA_CONTEXT && !nativeId.test(input.context))
    || (input.language !== null && !languageTag.test(input.language))) {
    throw new MediaInvalid('resource summary request is invalid');
  }
  const unique = [...new Set(input.resources)];
  const graph = await graphRows(env, unique);
  const cost = { graphQueries: 1, mediaQueries: 0, accessChecks: 0, accessQueries: 0 };
  const readable = new Map<string, GraphRow>();
  const restricted = new Map<string, string>();
  const special = new Map<string, GraphRow>();
  for (const reference of unique) {
    const row = graph.rows.get(reference);
    if (!row) continue;
    if (['realm', 'context', 'character', 'role', 'relation-definition', 'resource'].includes(row.type)) {
      special.set(reference, row);
      continue;
    }
    if (!selectName(row.labels, null)) continue;
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
    const decisions = await Promise.all(works.map(async work =>
      await reader.canReadWork!(work) ? work : null));
    admitted = new Set(decisions.filter((work): work is string => work !== null));
  }
  for (const [reference, work] of restricted) {
    if (admitted.has(work)) readable.set(reference, graph.rows.get(reference)!);
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
  const semanticResources = [...new Set([...semanticRefs.keys(), ...relationRefs])];
  let admittedSemantics = new Set<string>();
  if (semanticResources.length && reader.canReadSemantics) {
    cost.accessChecks += semanticResources.length;
    admittedSemantics = new Set(await reader.canReadSemantics(semanticResources));
    cost.accessQueries++;
  } else if (semanticResources.length && reader.canReadSemantic) {
    cost.accessChecks += semanticResources.length;
    const decisions = await Promise.all(semanticResources.map(async resource =>
      await reader.canReadSemantic!(resource) ? resource : null));
    admittedSemantics = new Set(decisions.filter((resource): resource is string => resource !== null));
    cost.accessQueries += semanticResources.length;
  }
  const admittedRelations = relationRefs.filter(reference => admittedSemantics.has(reference));
  const relationDefinitions = await readRelationDefinitionNames(env, admittedRelations,
    contextBatch.selectedNames);
  if (admittedRelations.length) cost.graphQueries++;
  const admittedResources = new Map([...semanticRefs].filter(([reference]) => admittedSemantics.has(reference)));
  const semanticNames = await readSemanticResourceNames(env, admittedResources);
  if (admittedResources.size) cost.graphQueries++;
  for (const [reference, row] of special) {
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
    row.public = false;
    readable.set(reference, row);
  }
  for (const [reference, row] of readable) {
    const selected = contextBatch.selectedNames.get(reference);
    if (selected?.size) row.labels = selected;
  }
  if (reader.restrictedTitles && readable.size) {
    for (const [reference, row] of readable) {
      if (row.work && !row.head) readable.delete(reference);
    }
    const heads = [...new Map([...readable.values()].filter(row => row.work && row.head)
      .map(row => [row.work!, { work: row.work!, revision: row.head! }])).values()];
    const fenced = await reader.restrictedTitles(heads, input.context);
    if (heads.length) cost.accessQueries++;
    for (const [reference, row] of readable) {
      if (row.work && fenced.has(row.work)) readable.delete(reference);
    }
  }
  let avatars = new Map<string, AvatarRow>();
  let mediaGeneration: string | null = null;
  if (media && readable.size && !contextBatch.selectedContextDenied) {
    const hydrated = await media.avatarRows([...readable.keys()], input.context);
    cost.mediaQueries = 1;
    avatars = hydrated.rows;
    mediaGeneration = `${hydrated.generation.dataEpoch}:${hydrated.generation.sequence}`;
  }
  // Hydrated names/images cannot outlive a disclosure or membership change.
  const fencedNames = await readPublicRealmNames(env, realms, new Set(realmProofs.keys()));
  if (realms.length) cost.graphQueries += 2;
  for (const realm of realms) {
    const proof = realmProofs.get(realm);
    if (proof) { cost.accessChecks++; cost.accessQueries++; }
    if (!fencedNames.has(realm) || proof && await reader.realmReadProof!(realm) !== proof) readable.delete(realm);
  }
  const summaries = input.resources.map((reference): ResourceSummary => {
    const row = readable.get(reference);
    if (!row) return { reference, status: 'unavailable' };
    const selectedContext = contextBatch.selectedNames.has(reference)
      ? contextBatch.contexts.get(input.context) : undefined;
    return { reference, status: 'available', type: row.type,
      base: summaryBases[row.type], work: row.work,
      disclosure: row.public ? 'public' : 'restricted',
      name: { ...selectDisplayName(row.localizedName ?? row.labels,
        input.languages ?? readerLanguages(input.language))!,
        ...(selectedContext?.preferenceRevision
          ? { context: input.context, preferenceRevision: selectedContext.preferenceRevision } : {}) },
      avatar: avatar(row.type, reference, avatars.get(reference)) };
  });
  return { summaries, generation: { graph: graph.generation, media: mediaGeneration }, cost };
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
