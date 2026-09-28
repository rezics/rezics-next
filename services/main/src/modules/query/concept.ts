import { GRAPHS, RV, iri, type WorkActivationEnvironment } from '../work/activate.ts';
import { QueryRejected } from './compile.ts';

const nativeId = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;

/** Resolve a Concept Condition's current or exact interpretation to the active Sense and revision. */
export async function interpretationForConcept(env: WorkActivationEnvironment,
  concept: { value: string; revision?: string }): Promise<{ sense: string; revision: string }> {
  if (!nativeId.test(concept.value) || (concept.revision && !nativeId.test(concept.revision))) {
    throw new QueryRejected('unsupported_query_shape', 'Search needs native Concept and interpretation IDs');
  }
  const response = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?sense ?head WHERE {
    GRAPH ${iri(GRAPHS.current)} {
      ?sense a rv:ClassificationSense ; rv:senseState rv:Active ;
        rv:head ?head ; rv:expression ?expression .
      ?expression a rv:ClassificationExpression ; rv:expressionState rv:Active ;
        rv:assertedConcept ${iri(concept.value)} .
      ${concept.revision ? `FILTER(?head = ${iri(concept.revision)})` : ''}
    }
    GRAPH ${iri(GRAPHS.revisions)} {
      ?head a rv:RevisionAnchor ; rv:component ?sense .
    }
  } LIMIT 2`, 8192);
  const rows = response.results?.bindings ?? [];
  if (rows.length > 1) {
    throw new QueryRejected('unsupported_query_shape', 'Phrase search has no template for multiple active interpretations');
  }
  if (rows.length !== 1 || !rows[0]?.sense || !nativeId.test(rows[0].sense.value)
    || !rows[0].head || !nativeId.test(rows[0].head.value)) {
    throw new QueryRejected('stale_query_meaning', 'Concept interpretation changed or is ambiguous');
  }
  return { sense: rows[0].sense.value, revision: rows[0].head.value };
}
