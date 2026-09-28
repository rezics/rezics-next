import { GRAPHS, RV, iri, type WorkActivationEnvironment } from '../work/activate.ts';
import { QueryRejected } from './compile.ts';

const nativeId = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;

/** Resolve a Concept Condition's exact interpretation revision to the active legacy Sense. */
export async function senseForConcept(env: WorkActivationEnvironment,
  concept: { value: string; revision: string }): Promise<string> {
  if (!nativeId.test(concept.value) || !nativeId.test(concept.revision)) {
    throw new QueryRejected('unsupported_query_shape', 'Search needs native Concept and interpretation IDs');
  }
  const response = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?sense WHERE {
    GRAPH ${iri(GRAPHS.current)} {
      ?sense a rv:ClassificationSense ; rv:senseState rv:Active ;
        rv:head ${iri(concept.revision)} ; rv:expression ?expression .
      ?expression a rv:ClassificationExpression ; rv:expressionState rv:Active ;
        rv:assertedConcept ${iri(concept.value)} .
    }
    GRAPH ${iri(GRAPHS.revisions)} {
      ${iri(concept.revision)} a rv:RevisionAnchor ; rv:component ?sense .
    }
  } LIMIT 2`, 8192);
  const rows = response.results?.bindings ?? [];
  if (rows.length !== 1 || !rows[0]?.sense || !nativeId.test(rows[0].sense.value)) {
    throw new QueryRejected('stale_query_meaning', 'Concept interpretation changed or is ambiguous');
  }
  return rows[0].sense.value;
}
