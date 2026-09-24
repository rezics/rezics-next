import { DATASET, GRAPHS, RV, iri, lit, PUBLIC_SEARCH_ANCHOR,
  TEXT_INDEX_PROFILE, TEXT_INDEX_PROBE, TEXT_INDEX_PROBE_BODY,
  TEXT_INDEX_PROBE_GRAPH, type GraphLineage } from './activate.ts';
import { PUBLIC_SEARCH_GRAPH } from './select-main.ts';
import type { FusekiClient } from '../../infrastructure/fuseki.ts';

// These are whole-request work limits, independent of the output page size.
export const MAX_PUBLIC_UNITS = 20_000;
export const MAX_PHRASE_CANDIDATES = 512;
export const PHRASE_HIT_PROBE = MAX_PHRASE_CANDIDATES + 1;
export const MAX_SEARCH_RESPONSE_BYTES = 1_048_576;
const MAX_PROOF_RESPONSE_BYTES = 65_536;

export class SearchIndexUnavailable extends Error {}
export class SearchIndexBudgetExceeded extends Error {}

export interface PublicTextPosition {
  dataEpoch: string;
  sequence: string;
  generation: string;
  population: number;
  serverInstanceId: string;
}

const qualified = new WeakMap<FusekiClient, Map<string, Promise<PublicTextPosition>>>();
const generationIri = /^urn:rezics:text-index-generation:[0-9a-f-]{36}$/;
const instanceIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const decimal = /^(0|[1-9][0-9]*)$/;

async function serverInstance(fuseki: FusekiClient): Promise<string> {
  let health: Awaited<ReturnType<FusekiClient['commandHealth']>>;
  try { health = await fuseki.commandHealth(); }
  catch (error) {
    throw new SearchIndexUnavailable('Fuseki process identity cannot be verified', { cause: error });
  }
  const instanceId = (health as { instanceId?: unknown }).instanceId;
  if (typeof instanceId !== 'string' || !instanceIdPattern.test(instanceId)) {
    throw new SearchIndexUnavailable('Fuseki process identity is unavailable');
  }
  return instanceId;
}

export async function assertSameTextInstance(fuseki: FusekiClient,
  position: PublicTextPosition): Promise<void> {
  if (await serverInstance(fuseki) !== position.serverInstanceId) {
    throw new SearchIndexUnavailable('Fuseki restarted during public search');
  }
}

function count(value: string | undefined): number {
  const number = Number(value);
  if (value === undefined || !decimal.test(value) || !Number.isSafeInteger(number)) {
    throw new SearchIndexUnavailable('public text index population is invalid');
  }
  return number;
}

/**
 * Requalify the complete source/index membership once per graph position. The
 * control/probe check remains per request, so quarantine and generation changes
 * invalidate a cached qualification immediately. Ordinary product writes advance
 * the graph sequence; the next reader must requalify before serving results.
 */
export async function assertPublicTextReady(fuseki: FusekiClient,
  lineage: GraphLineage): Promise<PublicTextPosition> {
  const instanceId = await serverInstance(fuseki);
  const control = await fuseki.query(`PREFIX rv: <${RV}>
    PREFIX text: <http://jena.apache.org/text#>
    SELECT ?epoch ?sequence ?generation WHERE {
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
          text:query (rv:searchBody ${lit('"中文检索"')} 2) .
        FILTER(?probeLiteral = ${lit(TEXT_INDEX_PROBE_BODY)}@zh
          && ?probeGraph = ${iri(TEXT_INDEX_PROBE_GRAPH)})
      }
    }`, MAX_PROOF_RESPONSE_BYTES);
  const rows = control.results?.bindings ?? [];
  const row = rows[0];
  if (rows.length !== 1 || row?.epoch?.value !== lineage.dataEpoch
    || !row.sequence || !decimal.test(row.sequence.value)
    || !row.generation || !generationIri.test(row.generation.value)) {
    throw new SearchIndexUnavailable('public text index control proof is unavailable');
  }
  const key = `${instanceId}\0${row.epoch.value}\0${row.sequence.value}\0${row.generation.value}`;
  let entries = qualified.get(fuseki);
  if (!entries) {
    entries = new Map();
    qualified.set(fuseki, entries);
  }
  const existing = entries.get(key);
  if (existing) {
    const position = await existing;
    await assertSameTextInstance(fuseki, position);
    return position;
  }
  const proof = qualifyMembership(fuseki, {
    dataEpoch: row.epoch.value, sequence: row.sequence.value,
    generation: row.generation.value, population: 0, serverInstanceId: instanceId,
  });
  // Keep one generation/position only; concurrent requests for it share the proof.
  entries.clear();
  entries.set(key, proof);
  try {
    const position = await proof;
    await assertSameTextInstance(fuseki, position);
    return position;
  }
  catch (error) { if (entries.get(key) === proof) entries.delete(key); throw error; }
}

async function qualifyMembership(fuseki: FusekiClient,
  position: PublicTextPosition): Promise<PublicTextPosition> {
  const result = await fuseki.query(`PREFIX rv: <${RV}>
    PREFIX text: <http://jena.apache.org/text#>
    SELECT ?epoch ?sequence ?generation ?population ?indexed ?uniqueIndexed ?valid WHERE {
      GRAPH ${iri(GRAPHS.control)} {
        ${iri(DATASET)} rv:dataEpoch ?epoch ; rv:sequence ?sequence ;
          rv:textIndexProfile ${iri(TEXT_INDEX_PROFILE)} ;
          rv:textIndexGeneration ?generation .
        FILTER NOT EXISTS { ${iri(DATASET)} rv:restoreHold true }
      }
      FILTER(?epoch = ${lit(position.dataEpoch)} && ?sequence = ${position.sequence}
        && ?generation = ${iri(position.generation)})
      GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} {
        ${iri(PUBLIC_SEARCH_ANCHOR)} a rv:SearchGraphAnchor .
      }
      { SELECT (COUNT(?candidate) AS ?population) WHERE {
        { SELECT DISTINCT ?candidate WHERE {
          GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} { ?candidate a rv:MatchUnit }
        } LIMIT ${MAX_PUBLIC_UNITS + 1} }
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
    }`, MAX_PROOF_RESPONSE_BYTES);
  const rows = result.results?.bindings ?? [];
  const row = rows[0];
  if (rows.length !== 1 || row?.epoch?.value !== position.dataEpoch
    || row.sequence?.value !== position.sequence
    || row.generation?.value !== position.generation) {
    throw new SearchIndexUnavailable('public text index changed during qualification');
  }
  const population = count(row.population?.value);
  const indexed = count(row.indexed?.value);
  const uniqueIndexed = count(row.uniqueIndexed?.value);
  const valid = count(row.valid?.value);
  if (population > MAX_PUBLIC_UNITS || indexed > MAX_PUBLIC_UNITS) {
    throw new SearchIndexBudgetExceeded('public text population exceeds admission bound');
  }
  if (indexed !== population || uniqueIndexed !== population || valid !== population) {
    throw new SearchIndexUnavailable(`public text index differs from current MatchUnits: ${population}/${indexed}/${uniqueIndexed}/${valid}`);
  }
  return { ...position, population };
}
