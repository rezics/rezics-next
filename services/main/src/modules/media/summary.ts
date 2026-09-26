import { createHash } from 'node:crypto';
import { DATASET, GRAPHS, RV, iri, type WorkActivationEnvironment } from '../work/activate.ts';
import { listEligibleNativeVariants } from '../work/native-variants.ts';
import { readContextRevision, ContextNotFound } from '../context/read.ts';
import { readSemanticCurrent } from '../semantic/read.ts';
import { readPublicRealmNames } from '../space/read.ts';
import { AVATAR_POLICY, avatarImageEligible, DEFAULT_MEDIA_CONTEXT, MediaInvalid, MediaUnavailable,
  type AvatarRow, type MediaStore } from './store.ts';

export const MAX_SUMMARY_BATCH = 64;
export const FALLBACK_POLICY = 'avatar-fallback-v1';
const nativeId = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
const languageTag = /^[a-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/;
const RTL = new Set(['ar', 'arc', 'ckb', 'dv', 'fa', 'he', 'ks', 'ku', 'ps', 'sd', 'ug', 'ur', 'yi']);

export type ResourceType = 'work' | 'main-version' | 'space' | 'realm' | 'concept'
  | 'character' | 'context' | 'role' | 'relation-definition';

export interface SummaryReader {
  /** Readable non-public Work, checked against current Access only after the graph read. */
  canReadWork?: (work: string) => Promise<boolean>;
  /** One Access owner request for all distinct non-public Works in the batch. */
  canReadWorks?: (works: readonly string[]) => Promise<ReadonlySet<string>>;
  /** Access fence checked against each exact graph head before a title is returned. */
  restrictedTitles?: (heads: readonly { work: string; revision: string }[], context: string) =>
    Promise<ReadonlySet<string>>;
  /** The exact semantic Resource must have a current Access read grant. */
  canReadSemantic?: (resource: string) => Promise<boolean>;
  /** The Context owner checks private disclosure; public Contexts need no grant. */
  canReadPrivateContext?: (context: string) => Promise<boolean>;
}

export interface SummaryInput {
  resources: readonly string[];
  context: string;
  language: string | null;
}

export type AvatarDescriptor =
  | { kind: 'image'; selection: string; url: string; mediaType: string; width: number; height: number;
    crop: string | null; basis: { policy: string; context: string } }
  | { kind: 'fallback'; policy: string; key: string; resourceType: ResourceType };

export type ResourceSummary =
  | { reference: string; status: 'available'; type: ResourceType; disclosure: 'public' | 'restricted';
    name: { value: string; language: string; direction: 'ltr' | 'rtl'; basis: 'requested' | 'fallback' };
    avatar: AvatarDescriptor }
  | { reference: string; status: 'unavailable' };

export interface SummaryBatch {
  summaries: ResourceSummary[];
  generation: { graph: string; media: string | null };
  /** Owner round trips spent by this batch, reported for the cost contract. */
  cost: { graphQueries: number; mediaQueries: number; accessChecks: number; accessQueries: number };
}

interface GraphRow { type: ResourceType; work: string | null; head: string | null;
  public: boolean; labels: Map<string, string> }
const typePriority: readonly ResourceType[] = [
  'work', 'main-version', 'space', 'realm', 'concept', 'context', 'character', 'role', 'relation-definition',
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
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
    PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#> PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
    SELECT ?epoch ?sequence ?hold ?r ?type ?work ?head ?public ?label WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ?epoch ; rv:sequence ?sequence .
        OPTIONAL { ${iri(DATASET)} rv:restoreHold ?hold } }
      OPTIONAL {
        VALUES ?r { ${resources.map(iri).join(' ')} }
        GRAPH ${iri(GRAPHS.current)} {
          { ?r a schema:CreativeWork . BIND(?r AS ?work) BIND("work" AS ?type) }
          UNION { ?r a rv:MainVersion ; rv:work ?work . BIND("main-version" AS ?type) }
          UNION { ?r a rv:Space . BIND("space" AS ?type) }
          UNION { ?r a rv:Realm ; rv:realmState rv:Active . BIND("realm" AS ?type) }
          UNION { ?r a skos:Concept ; rv:conceptState rv:Active . BIND("concept" AS ?type) }
          UNION { ?r a rv:SemanticContext ; rv:contextState rv:Active . BIND("context" AS ?type) }
          UNION { ?r a rv:Character ; rv:semanticHead ?semanticHead . BIND("character" AS ?type) }
          UNION { ?r a rv:Role ; rv:semanticHead ?semanticHead . BIND("role" AS ?type) }
          UNION { ?r a rv:SemanticDefinition ; rv:definitionKind rv:RelationDefinition ;
            rv:definitionHead ?definitionHead . BIND("relation-definition" AS ?type) }
        }
        OPTIONAL { FILTER(?type = "work" || ?type = "main-version")
          GRAPH ${iri(GRAPHS.current)} { ?work rdfs:label ?label } }
        OPTIONAL { FILTER(?type = "work" || ?type = "main-version")
          GRAPH ${iri(GRAPHS.current)} { ?work rv:head ?head } }
        OPTIONAL { FILTER(?type = "space") GRAPH ${iri(GRAPHS.current)} { ?r rdfs:label ?label } }
        OPTIONAL { FILTER(?type = "concept") GRAPH ${iri(GRAPHS.current)} { ?r skos:prefLabel ?label } }
        BIND(IF(?type = "concept" || ?type = "realm", true,
          IF(?type = "context", EXISTS { GRAPH ${iri(GRAPHS.current)} { ?r rv:disclosure rv:Public } },
          IF(?type = "space",
          EXISTS { GRAPH ${iri(GRAPHS.current)} { ?r rv:disclosure rv:Public } },
          EXISTS { GRAPH ${iri(GRAPHS.current)} { ?work rv:mainVersion ?pm . ?pm rv:selectionHead ?ps }
            GRAPH ${iri(GRAPHS.revisions)} { ?ps rv:publicationDecision ?pd . ?pd rv:disclosure rv:Public } })))
          AS ?public)
      }
    }`);
  const bindings = result.results?.bindings ?? [];
  const control = bindings[0];
  if (!control?.epoch || control.epoch.value !== env.lineage.dataEpoch || control.hold) {
    throw new MediaUnavailable('graph lineage is unavailable');
  }
  const rows = new Map<string, GraphRow>();
  for (const binding of bindings) {
    const reference = binding.r?.value;
    if (!reference || !binding.type) continue;
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
    if (['realm', 'context', 'character', 'role', 'relation-definition'].includes(row.type)) {
      special.set(reference, row);
      continue;
    }
    if (!selectName(row.labels, null)) continue;
    if (row.public) { readable.set(reference, row); continue; }
    if ((row.type === 'work' || row.type === 'main-version') && row.work) {
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
  const realmNames = await readPublicRealmNames(env, realms);
  if (realms.length) cost.graphQueries += 2;
  for (const [reference, row] of special) {
    if (row.type === 'realm') {
      const name = realmNames.get(reference);
      if (name) { row.labels.set('en', name); readable.set(reference, row); }
      continue;
    }
    if (row.type === 'context') {
      try {
        cost.graphQueries += 2;
        const context = await readContextRevision(env, reference, null, async context => {
          if (!reader.canReadPrivateContext) return false;
          cost.accessChecks++;
          cost.accessQueries++;
          return reader.canReadPrivateContext(context);
        });
        if (context.state !== 'active') continue;
        row.public = context.disclosure === 'public';
        row.labels.set('en', `Context ${reference.slice(-8)}`);
        readable.set(reference, row);
      } catch (error) { if (!(error instanceof ContextNotFound)) throw error; }
      continue;
    }
    if (!reader.canReadSemantic) continue;
    cost.accessChecks++;
    cost.accessQueries++;
    if (!await reader.canReadSemantic(reference)) continue;
    const semantic = await readSemanticCurrent(env, reference, async () => false);
    cost.graphQueries += 4;
    if (!semantic || semantic.state.lifecycle !== 'active') continue;
    if (row.type === 'relation-definition') {
      if (semantic.state.component !== 'definition' || semantic.state.kind !== 'relation') continue;
    } else {
      if (semantic.state.component !== 'resource'
        || !semantic.state.types.includes(`${RV}${row.type === 'character' ? 'Character' : 'Role'}`)) continue;
      const names = new Map<string, string>();
      const ambiguous = new Set<string>();
      for (const property of semantic.state.properties) {
        if (property.predicate !== 'https://schema.org/name') continue;
        let language: string;
        let value: string;
        if (property.value.kind === 'language-string' && property.value.lexical.trim()) {
          language = property.value.language.toLowerCase();
          value = property.value.lexical;
        } else if (property.value.kind === 'string' && property.value.lexical.trim()) {
          language = 'en';
          value = property.value.lexical;
        } else continue;
        if (names.has(language) && names.get(language) !== value) ambiguous.add(language);
        names.set(language, value);
      }
      for (const [language, value] of names) if (!ambiguous.has(language)) row.labels.set(language, value);
    }
    if (!row.labels.size) {
      const kind = row.type === 'character' ? 'Character' : row.type === 'role' ? 'Role' : 'Relation definition';
      row.labels.set('en', `${kind} ${reference.slice(-8)}`);
    }
    row.public = false;
    readable.set(reference, row);
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
  if (media && readable.size) {
    const hydrated = await media.avatarRows([...readable.keys()], input.context);
    cost.mediaQueries = 1;
    avatars = hydrated.rows;
    mediaGeneration = `${hydrated.generation.dataEpoch}:${hydrated.generation.sequence}`;
  }
  const summaries = input.resources.map((reference): ResourceSummary => {
    const row = readable.get(reference);
    if (!row) return { reference, status: 'unavailable' };
    return { reference, status: 'available', type: row.type,
      disclosure: row.public ? 'public' : 'restricted', name: selectName(row.labels, input.language)!,
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
