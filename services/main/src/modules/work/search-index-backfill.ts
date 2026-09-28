import { DATASET, GRAPHS, RV, hash, iri, lit, type WorkActivationEnvironment } from './activate.ts';
import { PUBLIC_SEARCH_GRAPH } from './select-main.ts';

const BATCH = 64;
const MAX_UNITS = 4_096;

/** Stamp older public chapter units while writers are stopped for an offline index rebuild.
 * At most 4,096 units, 65 graph reads and 64 bounded commands; no request path pays this cost. */
export async function backfillChapterSearchIndex(env: WorkActivationEnvironment): Promise<number> {
  let stamped = 0;
  while (stamped <= MAX_UNITS) {
    const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
      SELECT DISTINCT ?unit ?book WHERE {
        GRAPH ${iri(GRAPHS.current)} { ?chapter schema:isPartOf ?book .
          ?book a schema:Book ; rv:mainVersion ?bookMain . }
        GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} { ?unit a rv:MatchUnit ; rv:work ?chapter .
          FILTER NOT EXISTS { ?unit rv:searchResultWork ?priorBook } }
      } ORDER BY STR(?unit) LIMIT ${BATCH + 1}`, 65_536)).results?.bindings ?? [];
    if (rows.length === 0) return stamped;
    if (stamped + rows.length > MAX_UNITS) throw new Error('chapter search backfill exceeds its unit budget');
    const units = rows.slice(0, BATCH).map(row => row.unit?.value);
    if (units.some(unit => !unit) || rows.slice(0, BATCH).some(row => !row.book)
      || new Set(units).size !== units.length) {
      throw new Error('chapter search backfill has ambiguous units');
    }
    const identity = hash(JSON.stringify(units));
    const receipt = `urn:rezics:receipt:chapter-search-index:${identity}`;
    const batch = `urn:rezics:outbox:${hash(`${receipt}\0batch`)}`;
    const digest = hash(JSON.stringify({ family: 'chapter-search-index-v1', units }));
    const result = await env.fuseki.commandWithReceipt({ receipt, digest, validations: [],
      deadlineMs: 60_000,
      update: `PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
        PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
        DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n } }
        INSERT {
          GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
          GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} { ?unit rv:searchResultWork ?book ;
            rv:searchResultMain ?bookMain ; rv:searchChapterTitle ?title . }
          GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ;
            rv:requestDigest ${lit(digest)} ; rv:outcome rv:Succeeded ;
            rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
            rv:sequence ?next . }
          GRAPH ${iri(GRAPHS.outbox)} {
            ${iri(batch)} a rv:OutboxBatch ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
              rv:sequence ?next ; rv:eventCount 0 . }
        } WHERE {
          GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
            rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . }
          VALUES ?unit { ${units.map(unit => iri(unit!)).join(' ')} }
          GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} { ?unit a rv:MatchUnit ; rv:work ?chapter .
            FILTER NOT EXISTS { ?unit rv:searchResultWork ?priorBook } }
          GRAPH ${iri(GRAPHS.current)} {
            ?chapter schema:isPartOf ?book ; rdfs:label ?title .
            ?book a schema:Book ; rv:mainVersion ?bookMain . }
          FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
          BIND(?n + 1 AS ?next)
        }` });
    if (result.status !== 'committed' || result.position.dataEpoch !== env.lineage.dataEpoch) {
      throw new Error(`chapter search backfill command ${result.status}`
        + (result.status === 'invalid' ? `: ${JSON.stringify(result.report)}` : ''));
    }
    stamped += units.length;
  }
  throw new Error('chapter search backfill exceeds its unit budget');
}
