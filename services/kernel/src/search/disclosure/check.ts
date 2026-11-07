import type { ConceptSelection, FilterQualifier, FilterRange } from '@rezics/filter';

/** One OpenSearch hit, including the indexed partition, security revision and matched query names. */
export type Hit = { id: string; partition: number; securityRevision: number; matched: readonly string[] };

/** A filter leaf compiled by the route, keyed by its query name. */
export type FactClause =
  | { facet: 'type'; values: readonly string[] }
  | {
      facet: 'statement';
      property: string;
      qualifiers?: readonly FilterQualifier[];
      values: readonly string[];
      concept?: ConceptSelection;
      inverse?: true;
    }
  | { facet: 'statement'; property: string; qualifiers?: readonly FilterQualifier[]; range: FilterRange };

export { checkHits } from '../disclosure-application.ts';
