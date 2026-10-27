import type { FilterDocument } from '@rezics/filter';
import type { FactClause } from './disclosure/check.ts';
import { SearchUnavailableError } from './opensearch.ts';
import type { RelationFacetMatch } from './source.ts';

/** The current Boolean expression over deduplicated, first-occurrence-ordered fact leaves. */
export type CurrentFilterPlan = {
  leaves: FactClause[];
  indices: Map<string, number>;
  /** Leaves with at least one occurrence under an even number of NOT nodes. */
  positive: Set<number>;
  /** Require exactly one true/false/not_proven result per leaf before evaluating any Boolean node. */
  evaluate(values: readonly RelationFacetMatch[]): RelationFacetMatch;
};

/** Accept only already admitted, expanded filters; saved nodes must reject. No source reads occur here. */
export function compileCurrentFilter(_filter: FilterDocument): CurrentFilterPlan {
  // Authoring-stage contract: extract disclosure/check.ts's existing plan in the implementation step.
  throw new SearchUnavailableError('Current filter plan extraction is pending');
}

/** The existing disclosure clause key, including set-normalized values and qualifier clauses. */
export function currentClauseKey(_clause: FactClause): string {
  throw new SearchUnavailableError('Current filter plan extraction is pending');
}

/** OR current evidence, preserving not_proven when no alternative is true; empty evidence is false. */
export function anyCurrentMatch(_values: readonly RelationFacetMatch[]): RelationFacetMatch {
  throw new SearchUnavailableError('Current filter plan extraction is pending');
}
