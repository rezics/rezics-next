import { DATASET, GRAPHS, RV, iri, lit, PUBLIC_SEARCH_ANCHOR,
  TEXT_INDEX_PROFILE, TEXT_INDEX_PROBE, TEXT_INDEX_PROBE_BODY,
  TEXT_INDEX_PROBE_GRAPH, type GraphLineage } from './activate.ts';
import { PUBLIC_SEARCH_GRAPH } from './select-main.ts';
import type { FusekiClient } from '../../infrastructure/fuseki.ts';

const MAX_PUBLIC_UNITS = 100;

export class SearchIndexUnavailable extends Error {}
export class SearchIndexBudgetExceeded extends Error {}

/** Checks the complete bounded RDF/index pairing at one Fuseki read snapshot. */
export async function assertPublicTextReady(fuseki: FusekiClient, lineage: GraphLineage) {
  const result = await fuseki.query(`PREFIX rv: <${RV}>
    PREFIX text: <http://jena.apache.org/text#>
    SELECT ?epoch ?sequence ?generation ?population ?indexed ?uniqueIndexed ?valid WHERE {
      GRAPH ${iri(GRAPHS.control)} {
        ${iri(DATASET)} rv:dataEpoch ?epoch ; rv:sequence ?sequence ;
          rv:textIndexProfile ${iri(TEXT_INDEX_PROFILE)} ;
          rv:textIndexGeneration ?generation .
        FILTER NOT EXISTS { ${iri(DATASET)} rv:restoreHold true }
      }
      FILTER(?epoch = ${lit(lineage.dataEpoch)})
      GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} {
        ${iri(PUBLIC_SEARCH_ANCHOR)} a rv:SearchGraphAnchor .
      }
      GRAPH ${iri(TEXT_INDEX_PROBE_GRAPH)} {
        ${iri(TEXT_INDEX_PROBE)} rv:searchBody ${lit(TEXT_INDEX_PROBE_BODY)}@zh .
        (${iri(TEXT_INDEX_PROBE)} ?probeScore ?probeLiteral ?probeGraph)
          text:query (rv:searchBody ${lit(`"中文检索"`)} 2) .
        FILTER(?probeLiteral = ${lit(TEXT_INDEX_PROBE_BODY)}@zh
          && ?probeGraph = ${iri(TEXT_INDEX_PROBE_GRAPH)})
      }
      { SELECT (COUNT(DISTINCT ?candidate) AS ?population) WHERE {
        GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} { ?candidate a rv:MatchUnit }
      } }
      { SELECT (COUNT(?indexedUnit) AS ?indexed)
          (COUNT(DISTINCT ?indexedUnit) AS ?uniqueIndexed)
          (COUNT(?validUnit) AS ?valid) WHERE {
        GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} {
          (?indexedUnit ?score ?indexedLiteral ?indexedGraph)
            text:query (rv:searchBody "body:*" ${MAX_PUBLIC_UNITS + 1}) .
          OPTIONAL {
            ?indexedUnit a rv:MatchUnit ; rv:searchBody ?indexedLiteral .
            FILTER(?indexedGraph = ${iri(PUBLIC_SEARCH_GRAPH)})
            BIND(?indexedUnit AS ?validUnit)
          }
        }
      } }
    }`);
  const rows = result.results?.bindings ?? [];
  const row = rows[0];
  if (rows.length !== 1 || !row?.epoch || !row.sequence || !row.generation
    || !row.population || !row.indexed || !row.uniqueIndexed || !row.valid
    || !/^urn:rezics:text-index-generation:[0-9a-f-]{36}$/.test(row.generation.value)) {
    throw new SearchIndexUnavailable('public text index proof is unavailable');
  }
  const population = Number(row.population.value);
  const indexed = Number(row.indexed.value);
  const uniqueIndexed = Number(row.uniqueIndexed.value);
  const valid = Number(row.valid.value);
  if (![population, indexed, uniqueIndexed, valid].every(Number.isSafeInteger)
    || [population, indexed, uniqueIndexed, valid].some(value => value < 0)) {
    throw new SearchIndexUnavailable('public text index population is invalid');
  }
  if (population > MAX_PUBLIC_UNITS) {
    throw new SearchIndexBudgetExceeded('public text population exceeds admitted bound');
  }
  if (indexed > MAX_PUBLIC_UNITS) {
    throw new SearchIndexUnavailable('public text index contains excess documents');
  }
  if (indexed !== population || uniqueIndexed !== population || valid !== population) {
    throw new SearchIndexUnavailable('public text index differs from current MatchUnits');
  }
  return { dataEpoch: row.epoch.value, sequence: row.sequence.value,
    generation: row.generation.value };
}
