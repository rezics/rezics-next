import { GRAPHS, iri } from '../work/activate.ts';
import { selectDisplayName } from '../display-language/select.ts';
import { decodeReadCursor, encodeReadCursor, WorkReadInvalid, WorkReadUnavailable,
  type WorkReadSession } from '../work/read-session.ts';
import { DisclosureUnavailable, hasDisclosure, type DisclosureTarget } from '../disclosure/read.ts';
import { GLOBAL_CLASSIFICATION_CONTEXT, CLASSIFICATION_ISOLATE_POLICY,
  CLASSIFICATION_INHERIT_POLICY } from '../classification/context.ts';
import { publicNamePage, type DirectoryAfter } from '../search/labels.ts';
import { namePolicyPrincipal } from '../disclosure/viewer.ts';
import { readRealmPolicy } from '../space/policy.ts';

/** One bounded scan of active shared vocabulary labels and their definition heads. */
export const SHARED_VOCABULARY_COST = { concepts: 256, labels: 2048, page: 20 } as const;
export const CONTEXT_VOCABULARY_COST = { candidates: 64, labels: 512, page: 20 } as const;

/** The native name directory seeks dictionary keys. Exact graph joins below
 * consume only that bounded window, including when every candidate is hidden. */
export async function readContextVocabulary(session: WorkReadSession,
  input: { context: string; scheme?: string; q?: string; limit?: number; cursor?: string }) {
  const limit = input.limit ?? CONTEXT_VOCABULARY_COST.page;
  const search = input.q?.normalize('NFKC').trim().toLocaleLowerCase() ?? '';
  if (input.q !== undefined && !search) throw new WorkReadInvalid('Topic search is empty');
  const principal = namePolicyPrincipal(session.viewer);
  const binding = ['context-vocabulary-v1', input.context, input.scheme ?? null, input.q ?? null,
    limit, session.options.language ?? null, session.displayLanguages,
    principal ? [principal.issuer, principal.subject] : null, session.viewer];
  const cursor = decodeReadCursor(input.cursor, binding, session.position);
  let after: DirectoryAfter | undefined;
  if (cursor) {
    try {
      after = JSON.parse(cursor.order) as DirectoryAfter;
      if (!after || typeof after.id !== 'string' || after.score !== '0'
        || !/^\d+$/.test(after.commit)) throw new Error('cursor');
    } catch { throw new WorkReadInvalid('Vocabulary cursor is invalid'); }
  }
  const contexts = await session.query(`SELECT ?scope ?head ?realm WHERE {
    GRAPH ${iri(GRAPHS.current)} {
      ${iri(input.context)} a rv:ClassificationContext ; rv:contextState rv:Active ; rv:head ?head .
      ${input.context === GLOBAL_CLASSIFICATION_CONTEXT
        ? `${iri(input.context)} rv:contextRole rv:GlobalClassification ;
          rv:inheritancePolicy ${iri(CLASSIFICATION_ISOLATE_POLICY)} .
          BIND(${iri(input.context)} AS ?scope)`
        : `${iri(input.context)} rv:contextRole rv:RealmClassification ; rv:realm ?realm ;
          rv:inheritancePolicy ${iri(CLASSIFICATION_INHERIT_POLICY)} ;
          rv:fallbackContext ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} .
          ?realm a rv:Realm ; rv:realmState rv:Active ; rv:classificationContext ${iri(input.context)} ; rv:space ?space .
          ?space a rv:Space ; rv:realmCapability ?realm ; rv:disclosure rv:Public .
          ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} a rv:ClassificationContext ; rv:contextState rv:Active ;
            rv:contextRole rv:GlobalClassification ; rv:inheritancePolicy ${iri(CLASSIFICATION_ISOLATE_POLICY)} .
          BIND(${iri(GLOBAL_CLASSIFICATION_CONTEXT)} AS ?scope)`}
    }
  } LIMIT 2`, 2);
  if (contexts.length > 1) throw new WorkReadUnavailable('Classification context is ambiguous');
  const context = contexts[0];
  const empty = () => ({ profile: 'shared-vocabulary-v1' as const, context: input.context,
    scheme: input.scheme ?? null, items: [] as { id: string; label: string }[], hasMore: false,
    nextCursor: null as string | null, sourcePosition: session.position,
    count: { value: 0, kind: 'exact-page' as const, total: null } });
  if (context && (!context.scope?.value || !context.head?.value))
    throw new WorkReadUnavailable('Classification context is incomplete');
  // Probe the same bounded owner reads before distinguishing an absent context
  // from a withheld one. A missing context never authorizes vocabulary hydration.
  const contextTargets: DisclosureTarget[] = [{ owner: 'graph', resource: input.context,
    revision: context?.head?.value, component: 'record' }];
  if (input.context !== GLOBAL_CLASSIFICATION_CONTEXT) {
    const realmId = context?.realm?.value ?? input.context;
    const read = () => readRealmPolicy(session.deps.environment, realmId);
    const realm = await read();
    session.observeDependency(`realm-policy:${realmId}`, realm, read);
    if (context) {
      if (!realm?.realmRevision) throw new WorkReadUnavailable('Context Realm revision is unavailable');
      if (realm.visibility === 'private') return empty();
      contextTargets.push({ owner: 'graph', resource: realmId,
        revision: realm.realmRevision, component: 'record' });
    }
  }
  const contextDecisions = await session.disclosure(contextTargets, 'search');
  if (contextDecisions.length !== contextTargets.length)
    throw new WorkReadUnavailable('Context disclosure is incomplete');
  if (!context || contextDecisions.some(decision => decision !== 'visible')) return empty();
  const page = await publicNamePage(session, 'concept', 'identity', CONTEXT_VOCABULARY_COST.candidates, after);
  const candidates = page.rows.filter(row => row.available);
  const rows = candidates.length ? await session.query(`SELECT ?concept ?head ?label WHERE {
    ${candidates.map(row => `{ GRAPH ${iri(GRAPHS.current)} {
      BIND(${iri(row.id)} AS ?concept)
      ${iri(row.id)} a skos:Concept ; skos:inScheme ${input.scheme ? iri(input.scheme) : '?scheme'} ;
        skos:prefLabel ?label ; rv:conceptState rv:Active .
      ${input.scheme ? iri(input.scheme) : '?scheme'} a skos:ConceptScheme ; rv:schemeState rv:Active .
      FILTER NOT EXISTS { ${iri(row.id)} rv:conceptState rv:Retired }
      FILTER NOT EXISTS { ${input.scheme ? iri(input.scheme) : '?scheme'} rv:schemeState rv:Retired }
      FILTER NOT EXISTS { ${iri(row.id)} rv:conceptRealm ?owner }
      FILTER NOT EXISTS { ${iri(row.id)} rv:protectionHead ?protection }
      FILTER EXISTS { ?selectedSense a rv:ClassificationSense ; rv:senseState rv:Active ;
        rv:interpretationScope ${iri(context.scope!.value)} ; rv:expression ?selectedExpression .
        ?selectedExpression a rv:ClassificationExpression ; rv:expressionState rv:Active ; rv:assertedConcept ${iri(row.id)} }
      ${sharedConceptHeadPattern(iri(row.id))}
    } }`).join(' UNION ')}
  } LIMIT ${CONTEXT_VOCABULARY_COST.labels + 1}`, CONTEXT_VOCABULARY_COST.labels + 1) : [];
  if (rows.length > CONTEXT_VOCABULARY_COST.labels) throw new WorkReadUnavailable('Vocabulary labels exceed their read budget');
  const concepts = new Map<string, { revision: string; labels: Map<string, string> }>();
  for (const row of rows) {
    const id = row.concept?.value, revision = row.head?.value, label = row.label?.value,
      language = row.label?.['xml:lang']?.toLowerCase();
    if (!id || !revision || !label || !language) throw new WorkReadUnavailable('Vocabulary label is malformed');
    const prior = concepts.get(id);
    if (prior && prior.revision !== revision) throw new WorkReadUnavailable('Vocabulary revision is inconsistent');
    if (!prior) concepts.set(id, { revision, labels: new Map([[language, label]]) });
    else prior.labels.set(language, label);
  }
  const basis = [...concepts].map(([id, value]) => ({ id, revision: value.revision }));
  const opening = await visibleSharedConcepts(session, basis);
  const final = await visibleSharedConcepts(session, basis);
  const items: { id: string; label: string }[] = [];
  let consumed = 0;
  for (const row of page.rows) {
    consumed++;
    after = row.after;
    const concept = concepts.get(row.id);
    if (concept && opening.has(row.id) && final.has(row.id)) {
      const label = selectDisplayName(concept.labels, session.displayLanguages)?.value;
      if (label && (!search || [...concept.labels.values()].some(value => value.normalize('NFKC')
        .toLocaleLowerCase().includes(search)))) items.push({ id: row.id, label });
    }
    if (items.length === limit) break;
  }
  const hasMore = consumed < page.rows.length || page.more;
  return { ...empty(), items, hasMore, nextCursor: hasMore && after
    ? encodeReadCursor(binding, session.position, '', JSON.stringify(after)) : null,
  count: { value: items.length, kind: 'exact-page' as const, total: null } };
}

/** v1 propositions keep the definition revision on their Sense. Prefer a
 * Concept's own head so a historical Sense cannot override a newer definition. */
export function sharedConceptHeadPattern(concept: string) {
  return `OPTIONAL { ${concept} rv:head ?conceptHead }
    OPTIONAL {
      ?sense a rv:ClassificationSense ; rv:expression ?expression ; rv:head ?senseHead .
      ?expression rv:assertedConcept ${concept} .
      FILTER NOT EXISTS { ${concept} rv:head ?directHead }
    }
    BIND(COALESCE(?conceptHead, ?senseHead) AS ?head)`;
}

/** Callers already selected active shared Concepts through their graph owner.
 * A label's ordinary availability does not authorize its public discovery. */
export async function visibleSharedConcepts(session: WorkReadSession,
  concepts: readonly { id: string; revision: string }[]): Promise<Set<string>> {
  if (!concepts.length) return new Set();
  if (concepts.length > SHARED_VOCABULARY_COST.concepts || !hasDisclosure(session.deps.environment)) {
    throw new WorkReadUnavailable('Shared vocabulary disclosure is unavailable');
  }
  const targets = concepts.flatMap(({ id: resource, revision }) => [
    { owner: 'graph' as const, resource, revision, component: 'record' as const },
    { owner: 'graph' as const, resource, revision, component: 'name' as const },
  ]);
  try {
    const decisions = await session.disclosure(targets, 'search');
    if (decisions.length !== targets.length || decisions.some(value => !['visible', 'tombstone', 'hidden'].includes(value))) {
      throw new DisclosureUnavailable('Shared vocabulary disclosure is incomplete');
    }
    return new Set(concepts.filter((_, index) => decisions[index * 2] === 'visible'
      && decisions[index * 2 + 1] === 'visible').map(concept => concept.id));
  } catch (cause) {
    if (cause instanceof DisclosureUnavailable) throw new WorkReadUnavailable('Shared vocabulary disclosure is unavailable', { cause });
    throw cause;
  }
}

export async function readSharedVocabulary(session: WorkReadSession, query?: string) {
  const search = query?.normalize('NFKC').trim().toLocaleLowerCase() ?? '';
  if (query !== undefined && !search) throw new WorkReadInvalid('Topic search is empty');
  const rows = await session.query(`PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
    SELECT ?concept ?head ?label WHERE { GRAPH ${iri(GRAPHS.current)} {
      ?scheme a skos:ConceptScheme ; rv:schemeState rv:Active .
      ?concept a skos:Concept ; skos:inScheme ?scheme ; skos:prefLabel ?label ;
        rv:conceptState rv:Active .
      ${sharedConceptHeadPattern('?concept')}
      FILTER NOT EXISTS { ?concept rv:conceptRealm ?realm }
      FILTER NOT EXISTS { ?concept rv:protectionHead ?protection }
    } } LIMIT ${SHARED_VOCABULARY_COST.labels + 1}`, SHARED_VOCABULARY_COST.labels + 1);
  if (rows.length > SHARED_VOCABULARY_COST.labels) {
    throw new WorkReadUnavailable('Shared vocabulary exceeds its read budget');
  }
  const concepts = new Map<string, { revision: string; labels: Map<string, string> }>();
  for (const row of rows) {
    const id = row.concept?.value, label = row.label?.value, revision = row.head?.value;
    const language = row.label?.['xml:lang']?.toLowerCase();
    if (!id || !label || !language || !revision) throw new WorkReadUnavailable('Shared vocabulary label is malformed');
    const concept = concepts.get(id);
    if (concept && concept.revision !== revision) throw new WorkReadUnavailable('Shared vocabulary revision is inconsistent');
    if (!concept) concepts.set(id, { revision, labels: new Map([[language, label]]) });
    else concept.labels.set(language, label);
  }
  if (concepts.size > SHARED_VOCABULARY_COST.concepts) {
    throw new WorkReadUnavailable('Shared vocabulary exceeds its concept budget');
  }
  // Both policy passes classify the revision that supplied these labels, even
  // if a newer Concept head is published while this read is in progress.
  const basis = [...concepts].map(([id, { revision }]) => ({ id, revision }));
  const opening = await visibleSharedConcepts(session, basis);
  const hydrated = [...concepts].flatMap(([id, { labels }]) => {
    if (!opening.has(id)) return [];
    const label = selectDisplayName(labels, session.displayLanguages)?.value;
    return label && (!search || [...labels.values()].some(value => value.normalize('NFKC')
      .toLocaleLowerCase().includes(search))) ? [{ id, label }] : [];
  }).sort((a, b) => a.label.localeCompare(b.label, session.displayLanguages[0] ?? 'en')
    || a.id.localeCompare(b.id));
  const final = await visibleSharedConcepts(session, basis);
  const items = hydrated.filter(item => final.has(item.id));
  return { profile: 'shared-vocabulary-v1' as const,
    items: items.slice(0, SHARED_VOCABULARY_COST.page), hasMore: items.length > SHARED_VOCABULARY_COST.page };
}
