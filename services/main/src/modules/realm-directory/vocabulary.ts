import { GRAPHS, iri } from '../work/activate.ts';
import { selectDisplayName } from '../display-language/select.ts';
import { WorkReadInvalid, WorkReadUnavailable, type WorkReadSession } from '../work/read-session.ts';
import { DisclosureUnavailable, hasDisclosure } from '../disclosure/read.ts';

/** One bounded scan of active shared vocabulary labels and their definition heads. */
export const SHARED_VOCABULARY_COST = { concepts: 256, labels: 2048, page: 20 } as const;

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
