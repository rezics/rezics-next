import { FilterError, parseFilter } from '@rezics/filter';
import { admitSavedQuerySelection, type SavedQuerySelection } from '../library/saved-query-editor/selection';
import { searchFilterWithScope } from './advanced-scope';
import type { SearchLoaderDeps } from './search-params';

/** Save only a predicate that the dynamic Collection rule can represent without changing Search meaning. */
export function searchSavedQuerySelection(state: SearchLoaderDeps | undefined): SavedQuerySelection {
  if (!state) return { state: 'empty' };
  if (
    state.invalidInput ||
    state.query.trim() ||
    state.sort === 'rating' ||
    state.ratingPopulation ||
    state.resourceScope
  )
    return { state: 'invalid', issues: [{ key: 'search', reason: 'unrepresentable' }] };

  const clauses: unknown[] = [];
  try {
    if (state.condition) clauses.push(parseFilter(state.condition));
    const filter = searchFilterWithScope(state.filter, state.resourceScope);
    if (filter) clauses.push(parseFilter(JSON.parse(filter)));
    if (state.type) clauses.push(parseFilter({ type: { in: [state.type] } }));
    for (const [property, values] of Object.entries(state.facets)) {
      if (!values.length) continue;
      clauses.push(
        parseFilter(property === 'type' ? { type: { in: values } } : { statement: { property, in: values } }),
      );
    }
    for (const [property, range] of Object.entries(state.ranges ?? {}))
      clauses.push(parseFilter({ statement: { property, range } }));
    if (state.kinds?.length) clauses.push(parseFilter({ kind: { in: state.kinds } }));
    if (!clauses.length) return { state: 'empty' };
    const document = clauses.length === 1 ? clauses[0]! : { and: clauses };
    return admitSavedQuerySelection({
      document: parseFilter(document),
      source: { kind: 'catalogue' },
    });
  } catch (error) {
    if (error instanceof FilterError || error instanceof SyntaxError)
      return { state: 'invalid', issues: [{ key: 'filter', reason: 'invalid' }] };
    throw error;
  }
}
