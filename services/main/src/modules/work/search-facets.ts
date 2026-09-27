import { DATASET, GRAPHS, RV, WORK_SEMANTIC_TYPES, iri,
  type WorkActivationEnvironment } from './activate.ts';
import { PublicQueryUnavailable } from './search-budget.ts';
import { InvalidPublicQuery } from './search-public.ts';
import { MAX_SEARCH_RESPONSE_BYTES, SearchSnapshotMoved } from './search-readiness.ts';

export interface WorkTypeSelection {
  /** Any selected type may match. Empty means no include restriction. */
  includeTypes?: string[];
  /** None of these types may match. */
  excludeTypes?: string[];
}

export interface PhraseFacetMatch {
  work: string;
  language: string;
  classification?: { sense: string };
}

const MAX_WORKS = 512;
const MAX_ROWS = MAX_WORKS * WORK_SEMANTIC_TYPES.length;

/** One bounded graph read for the complete phrase relation. Work type identity
 * comes from the current Work head; the control position fences the prior text read. */
export async function phraseWorkTypes(env: WorkActivationEnvironment,
  matches: readonly PhraseFacetMatch[], position: { dataEpoch: string; sequence: string }) {
  const works = [...new Set(matches.map(match => match.work))];
  if (works.length > MAX_WORKS) throw new PublicQueryUnavailable('phrase type relation exceeds its bound');
  const types = new Map<string, string[]>(works.map(work => [work, []]));
  if (!works.length) return types;
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
    SELECT ?epoch ?sequence ?work ?type WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ?epoch ; rv:sequence ?sequence }
      VALUES ?work { ${works.map(iri).join(' ')} }
      GRAPH ${iri(GRAPHS.current)} {
        ?work a schema:CreativeWork ; rv:head ?head .
        OPTIONAL { ?work a ?type . VALUES ?type { ${WORK_SEMANTIC_TYPES.map(type => `<${type}>`).join(' ')} } }
      }
    } LIMIT ${MAX_ROWS + 1}`, MAX_SEARCH_RESPONSE_BYTES);
  const rows = result.results?.bindings ?? [];
  if (rows.length > MAX_ROWS || rows.some(row => !row.work || !row.epoch || !row.sequence
    || row.epoch.value !== position.dataEpoch || row.sequence.value !== position.sequence)) {
    throw new SearchSnapshotMoved('Work types changed during phrase search');
  }
  const seen = new Set<string>();
  for (const row of rows) {
    const work = row.work!.value;
    const own = types.get(work);
    if (!own) throw new PublicQueryUnavailable('phrase type read returned another Work');
    seen.add(work);
    if (row.type) {
      if (!WORK_SEMANTIC_TYPES.includes(row.type.value as typeof WORK_SEMANTIC_TYPES[number])
        || own.includes(row.type.value)) throw new PublicQueryUnavailable('phrase Work types are ambiguous');
      own.push(row.type.value);
    }
  }
  if (seen.size !== works.length) throw new SearchSnapshotMoved('Work type head changed during phrase search');
  return types;
}

/** Counts are Work-grain (one matching Main Version per Work in this relation).
 * Language buckets are exact after all filters. Term buckets enumerate only
 * accepted classifications already resolved by a classified phrase profile;
 * their lower-bound precision forbids implying an unselected term is absent. */
export function facetPhraseResults<Row extends PhraseFacetMatch>(results: readonly (Row & { types: string[] })[],
  selection: WorkTypeSelection) {
  const include = selection.includeTypes ?? [];
  const exclude = selection.excludeTypes ?? [];
  if ([...include, ...exclude].some(type => !WORK_SEMANTIC_TYPES.includes(type as typeof WORK_SEMANTIC_TYPES[number]))
    || new Set(include).size !== include.length || new Set(exclude).size !== exclude.length
    || include.some(type => exclude.includes(type))) {
    throw new InvalidPublicQuery('invalid Work type selection');
  }
  const filtered = results.filter(row => (!include.length || include.some(type => row.types.includes(type)))
    && !exclude.some(type => row.types.includes(type)));
  const count = (key: (row: typeof filtered[number]) => string | undefined) => {
    const counts = new Map<string, Set<string>>();
    for (const row of filtered) {
      const value = key(row);
      if (value) {
        const works = counts.get(value) ?? new Set<string>();
        works.add(row.work);
        counts.set(value, works);
      }
    }
    return [...counts].map(([value, works]) => ({ value, count: works.size }))
      .sort((left, right) => right.count - left.count || left.value.localeCompare(right.value));
  };
  return { results: filtered, facets: {
    populationBasis: 'all-filters' as const, resultGrain: 'work' as const,
    languages: { precision: 'exact' as const, values: count(row => row.language) },
    terms: { precision: 'lower-bound' as const, values: count(row => row.classification?.sense) },
    types: { precision: 'exact' as const,
      values: WORK_SEMANTIC_TYPES.map(value => ({ value, count: new Set(filtered
        .filter(row => row.types.includes(value)).map(row => row.work)).size })) },
  } };
}

/** Cost: one graph read, at most 512 Works, 1,536 rows and 8 MiB under the
 * shared search read budget. Counting is O(results * three types). */
export async function decoratePhraseRelation<Row extends PhraseFacetMatch,
  Relation extends { results: Row[]; total: number; sourcePosition: { dataEpoch: string; sequence: string } }>(
  env: WorkActivationEnvironment, relation: Relation, selection: WorkTypeSelection,
) {
  const types = await phraseWorkTypes(env, relation.results, relation.sourcePosition);
  const typed = relation.results.map(row => ({ ...row, types: types.get(row.work) ?? [] }));
  const faceted = facetPhraseResults(typed, selection);
  return { ...relation, ...faceted, total: faceted.results.length };
}
