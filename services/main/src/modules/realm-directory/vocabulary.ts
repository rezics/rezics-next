import { GRAPHS, iri } from '../work/activate.ts';
import { WorkReadInvalid, WorkReadUnavailable, type WorkReadSession } from '../work/read-session.ts';

/** One bounded scan of active shared vocabulary labels, independent of legacy propositions. */
export const SHARED_VOCABULARY_COST = { concepts: 256, labels: 2048, page: 20 } as const;

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
  const preferred = session.options.language?.toLowerCase() ?? 'en';
  const items = [...concepts].flatMap(([id, labels]) => {
    const label = labels.get(preferred) ?? labels.get(preferred.split('-')[0]!)
      ?? labels.get(preferred === 'zh-hans' ? 'zh-cn' : preferred === 'zh-cn' ? 'zh-hans' : '')
      ?? labels.get('en') ?? [...labels.values()][0];
    return label && (!search || [...labels.values()].some(value => value.normalize('NFKC')
      .toLocaleLowerCase().includes(search))) ? [{ id, label }] : [];
  }).sort((a, b) => a.label.localeCompare(b.label, preferred) || a.id.localeCompare(b.id));
  return { profile: 'shared-vocabulary-v1' as const,
    items: items.slice(0, SHARED_VOCABULARY_COST.page), hasMore: items.length > SHARED_VOCABULARY_COST.page };
}
