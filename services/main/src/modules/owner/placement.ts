import { createHash } from 'node:crypto';
import type { FusekiClient } from '../../infrastructure/fuseki.ts';
import { DATASET, GRAPHS, RV, iri } from '../work/activate.ts';
import { captureObjectRecoveryCoverage, type ObjectRecoveryCoverage,
  type ObjectRecoveryStore } from './object-coverage.ts';

export class PlacementConflict extends Error {}

export interface GraphPlacementCoverage {
  quadCount: string;
  quadDigest: string;
  objects: ObjectRecoveryCoverage;
}

export interface GraphPlacementControl {
  dataEpoch: string;
  routingEpoch: string;
  sequence: string;
  held: boolean;
}

/** One indexed control lookup; duplicate or missing rows fail closed. */
export async function graphPlacementControl(fuseki: FusekiClient): Promise<GraphPlacementControl> {
  const result = await fuseki.query(`PREFIX rv: <${RV}> SELECT ?epoch ?routing ?sequence ?hold WHERE {
    GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ?epoch ;
      rv:routingEpoch ?routing ; rv:sequence ?sequence .
      OPTIONAL { ${iri(DATASET)} rv:restoreHold ?hold }
    }
  } LIMIT 2`);
  const rows = result.results?.bindings;
  if (rows?.length !== 1 || !rows[0]?.epoch || !rows[0].routing || !rows[0].sequence) {
    throw new PlacementConflict('graph placement control is missing or ambiguous');
  }
  return { dataEpoch: rows[0].epoch.value, routingEpoch: rows[0].routing.value,
    sequence: rows[0].sequence.value, held: rows[0].hold?.value === 'true' };
}

/**
 * Compare all named graph facts except local control, search journal and cutover receipts. The
 * transfer itself is an offline TDB2/object operation. This bounded scan rejects
 * blank nodes because their labels cannot prove equality across physical copies.
 * Cost is O(Q log Q + B), memory O(Q), with a 16 MiB query response cap.
 */
export async function graphPlacementCoverage(fuseki: FusekiClient,
  objects: ObjectRecoveryStore): Promise<GraphPlacementCoverage> {
  // Each native cutover appends a local search delta in its new lineage.
  // Public search RDF and all product revisions remain part of the comparison.
  const result = await fuseki.query(`SELECT ?graph ?subject ?predicate ?object WHERE {
    GRAPH ?graph { ?subject ?predicate ?object }
    FILTER(?graph != ${iri(GRAPHS.control)})
    FILTER(?graph != <urn:rezics:graph:search-delta>)
    FILTER(?graph != ${iri(GRAPHS.receipts)} ||
      !STRSTARTS(STR(?subject), "urn:rezics:receipt:restore-"))
  }`, 16_777_216);
  const rows = result.results?.bindings;
  if (!rows) throw new PlacementConflict('graph placement scan is incomplete');
  const facts = rows.map(row => {
    if (!row.graph || !row.subject || !row.predicate || !row.object
      || row.graph.type !== 'uri' || row.subject.type !== 'uri'
      || row.predicate.type !== 'uri' || row.object.type === 'bnode') {
      throw new PlacementConflict('graph placement has unsupported or incomplete RDF facts');
    }
    return JSON.stringify([row.graph.value, row.subject.value, row.predicate.value,
      row.object.type, row.object.value, row.object.datatype ?? null,
      row.object['xml:lang'] ?? null]);
  }).sort();
  const hash = createHash('sha256');
  for (const fact of facts) hash.update(`${fact}\n`);
  const coverage = await captureObjectRecoveryCoverage(fuseki, objects);
  return { quadCount: String(facts.length), quadDigest: hash.digest('hex'), objects: coverage };
}
