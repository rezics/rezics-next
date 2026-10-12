import { GRAPHS, iri } from '../work/activate.ts';
import { selectDisplayName } from '../display-language/select.ts';
import { WorkReadInvalid, WorkReadUnavailable, type WorkReadSession } from '../work/read-session.ts';
import { DisclosureUnavailable, hasDisclosure } from '../disclosure/read.ts';

/** One bounded scan of active shared vocabulary labels, independent of legacy propositions. */
export const SHARED_VOCABULARY_COST = { concepts: 256, labels: 2048, page: 20 } as const;

/** Callers already selected active shared Concepts through their graph owner.
 * A label's ordinary availability does not authorize its public discovery. */
export async function visibleSharedConcepts(session: WorkReadSession, ids: readonly string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  if (ids.length > SHARED_VOCABULARY_COST.concepts || !hasDisclosure(session.deps.environment)) {
    throw new WorkReadUnavailable('Shared vocabulary disclosure is unavailable');
  }
  const targets = ids.flatMap(resource => [
    { owner: 'graph' as const, resource, component: 'record' as const },
    { owner: 'graph' as const, resource, component: 'name' as const },
  ]);
  try {
    const decisions = await session.disclosure(targets, 'search');
    if (decisions.length !== targets.length || decisions.some(value => !['visible', 'tombstone', 'hidden'].includes(value))) {
      throw new DisclosureUnavailable('Shared vocabulary disclosure is incomplete');
    }
    return new Set(ids.filter((_, index) => decisions[index * 2] === 'visible' && decisions[index * 2 + 1] === 'visible'));
  } catch (cause) {
    if (cause instanceof DisclosureUnavailable) throw new WorkReadUnavailable('Shared vocabulary disclosure is unavailable', { cause });
    throw cause;
  }
}

export async function readSharedVocabulary(session: WorkReadSession, query?: string) {
  const search = query?.normalize('NFKC').trim().toLocaleLowerCase() ?? '';
  if (query !== undefined && !search) throw new WorkReadInvalid('Topic search is empty');
  const rows = await session.query(`PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
    SELECT ?concept ?label WHERE { GRAPH ${iri(GRAPHS.current)} {
      ?scheme a skos:ConceptScheme, rv:VocabularyDefinition ; rv:schemeState rv:Active .
      ?concept a skos:Concept ; skos:inScheme ?scheme ; skos:prefLabel ?label ;
        rv:conceptState rv:Active .
      FILTER NOT EXISTS { ?concept rv:conceptRealm ?realm }
      FILTER NOT EXISTS { ?concept rv:protectionHead ?protection }
    } } LIMIT ${SHARED_VOCABULARY_COST.labels + 1}`, SHARED_VOCABULARY_COST.labels + 1);
  if (rows.length > SHARED_VOCABULARY_COST.labels) {
    throw new WorkReadUnavailable('Shared vocabulary exceeds its read budget');
  }
  const concepts = new Map<string, Map<string, string>>();
  for (const row of rows) {
    const id = row.concept?.value, label = row.label?.value;
    const language = row.label?.['xml:lang']?.toLowerCase();
    if (!id || !label || !language) throw new WorkReadUnavailable('Shared vocabulary label is malformed');
    if (!concepts.has(id)) concepts.set(id, new Map());
    concepts.get(id)!.set(language, label);
  }
  if (concepts.size > SHARED_VOCABULARY_COST.concepts) {
    throw new WorkReadUnavailable('Shared vocabulary exceeds its concept budget');
  }
  const ids = [...concepts.keys()];
  const opening = await visibleSharedConcepts(session, ids);
  const hydrated = [...concepts].flatMap(([id, labels]) => {
    if (!opening.has(id)) return [];
    const label = selectDisplayName(labels, session.displayLanguages)?.value;
    return label && (!search || [...labels.values()].some(value => value.normalize('NFKC')
      .toLocaleLowerCase().includes(search))) ? [{ id, label }] : [];
  }).sort((a, b) => a.label.localeCompare(b.label, session.displayLanguages[0] ?? 'en')
    || a.id.localeCompare(b.id));
  const final = await visibleSharedConcepts(session, ids);
  const items = hydrated.filter(item => final.has(item.id));
  return { profile: 'shared-vocabulary-v1' as const,
    items: items.slice(0, SHARED_VOCABULARY_COST.page), hasMore: items.length > SHARED_VOCABULARY_COST.page };
}
