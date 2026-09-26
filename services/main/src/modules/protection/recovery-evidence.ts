import type { FusekiClient, SparqlResult } from '../../infrastructure/fuseki.ts';
import { GRAPHS, RV, iri } from '../work/activate.ts';

export type RecoveryTerm = { type: string; value: string; datatype?: string; 'xml:lang'?: string };
export interface RecoveryTriple { graph: string; subject: string; predicate: string; object: RecoveryTerm }

/** Retain the immutable graph effect with the relay handoff, outside the graph backup. */
export async function captureWorkProtectionEffect(fuseki: FusekiClient, operation: string,
  receipt: string, batch: string, event: string): Promise<RecoveryTriple[]> {
  const result = await fuseki.query(`PREFIX rv: <${RV}> SELECT ?graph ?subject ?predicate ?object WHERE {
    { GRAPH ${iri(GRAPHS.revisions)} { ?subject rv:operation ${iri(operation)} ; ?predicate ?object }
      BIND(${iri(GRAPHS.revisions)} AS ?graph) }
    UNION { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?predicate ?object }
      BIND(${iri(GRAPHS.receipts)} AS ?graph) BIND(${iri(receipt)} AS ?subject) }
    UNION { GRAPH ${iri(GRAPHS.outbox)} { VALUES ?subject { ${iri(batch)} ${iri(event)} }
      ?subject ?predicate ?object } BIND(${iri(GRAPHS.outbox)} AS ?graph) }
  }`, 131_072);
  const rows = result.results?.bindings ?? [];
  if (rows.length < 8 || rows.length > 192) throw new Error('Work protection recovery effect exceeds its bound');
  const triples = rows.map((row: NonNullable<SparqlResult['results']>['bindings'][number]) => {
    if (!row.graph || !row.subject || !row.predicate || !row.object
      || row.graph.type !== 'uri' || row.subject.type !== 'uri' || row.predicate.type !== 'uri') {
      throw new Error('Work protection recovery effect has invalid RDF terms');
    }
    return { graph: row.graph.value, subject: row.subject.value,
      predicate: row.predicate.value, object: row.object };
  }).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if (!triples.some(row => row.graph === GRAPHS.receipts && row.subject === receipt)
    || !triples.some(row => row.graph === GRAPHS.outbox && row.subject === batch)
    || !triples.some(row => row.graph === GRAPHS.outbox && row.subject === event)
    || !triples.some(row => row.graph === GRAPHS.revisions && row.predicate === `${RV}operation`
      && row.object.value === operation)) throw new Error('Work protection recovery effect is incomplete');
  return triples;
}
