import type { FusekiClient } from '../../infrastructure/fuseki.ts';
import { GRAPHS, DATASET, RV, hash, iri, lit, type GraphLineage } from '../work/activate.ts';
import { profileRegistry } from '../../../../../packages/model/src/generated/profiles.ts';

const PUBLIC = 'urn:rezics:search:public';
const PRIVATE = 'urn:rezics:search:private';
const PROFILE = 'erasure-graph-v1';
const SHAPE = 'https://rezics.com/definition/erasure-graph-v1/tombstone-shape';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_TARGETS = 64;
const MAX_UNITS = 64;

export class GraphErasureUnavailable extends Error {}
export class GraphErasureConflict extends Error {}

export function graphErasureReceipt(erasureId: string): string {
  if (!UUID.test(erasureId)) throw new GraphErasureConflict('invalid erasure identity');
  return `urn:rezics:receipt:erasure-graph:${hash(erasureId)}`;
}

function checkedTargets(revisionIds: readonly string[]): string[] {
  if (!revisionIds.length || revisionIds.length > MAX_TARGETS
    || new Set(revisionIds).size !== revisionIds.length
    || revisionIds.some(id => !UUID.test(id))) throw new GraphErasureConflict('invalid graph targets');
  return [...revisionIds].sort().map(id => `urn:rezics:content:revision:${id}`);
}

async function profile(fuseki: FusekiClient) {
  const registry = profileRegistry as Record<string, { sha256: string; shapes: readonly string[] }>;
  const local = registry[PROFILE];
  if (!local?.shapes.includes(SHAPE)
    || (await fuseki.commandHealth()).profiles[PROFILE] !== local.sha256) {
    throw new GraphErasureUnavailable('graph erasure profile differs');
  }
  return local;
}

interface Unit { graph: typeof PUBLIC | typeof PRIVATE; unit: string; target: string }

/** One indexed triple-pattern read, at most 65 rows. A larger fanout is refused. */
async function indexedUnits(fuseki: FusekiClient, targets: readonly string[]): Promise<Unit[]> {
  const result = await fuseki.query(`PREFIX rv: <${RV}> SELECT DISTINCT ?graph ?unit ?target WHERE {
    VALUES ?target { ${targets.map(iri).join(' ')} }
    VALUES ?graph { ${iri(PUBLIC)} ${iri(PRIVATE)} }
    VALUES ?reference { rv:revision rv:contentRevision }
    GRAPH ?graph { ?unit ?reference ?target . }
  } ORDER BY ?graph ?unit LIMIT ${MAX_UNITS + 1}`, 65_536);
  const rows = result.results?.bindings ?? [];
  if (rows.length > MAX_UNITS) throw new GraphErasureUnavailable('indexed erasure fanout exceeds 64 units');
  const accepted = new Set(targets);
  const units = rows.map(row => ({ graph: row.graph?.value as Unit['graph'],
    unit: row.unit?.value ?? '', target: row.target?.value ?? '' }));
  if (units.some(unit => ![PUBLIC, PRIVATE].includes(unit.graph)
    || !/^urn:rezics:[a-z0-9:-]+$/.test(unit.unit) || !accepted.has(unit.target))) {
    throw new GraphErasureUnavailable('indexed erasure inventory differs');
  }
  return units;
}

function update(lineage: GraphLineage, targets: readonly string[], units: readonly Unit[],
  erasureId: string, epoch: string, receipt: string, digest: string): string {
  const batch = `urn:rezics:outbox:${hash(`${receipt}\0batch`)}`;
  const event = `urn:rezics:event:${hash(`${receipt}\0event`)}`;
  const rows = [
    ...targets.map(target => `(UNDEF UNDEF ${iri(target)})`),
    ...units.map(unit => unit.graph === PUBLIC
      ? `(${iri(unit.unit)} UNDEF ${iri(unit.target)})`
      : `(UNDEF ${iri(unit.unit)} ${iri(unit.target)})`),
  ];
  return `PREFIX rv: <${RV}> PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
  DELETE {
    GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n . }
    GRAPH ${iri(PUBLIC)} { ?pubUnit ?pubP ?pubO . }
    GRAPH ${iri(PRIVATE)} { ?privUnit ?privP ?privO . }
  } INSERT {
    GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next . }
    GRAPH ${iri(GRAPHS.revisions)} {
      ${targets.map(target => `${iri(target)} a rv:ErasedRevision ; rv:erasureEpoch "${epoch}"^^xsd:integer .`).join('\n')}
    }
    GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ;
      rv:requestDigest ${lit(digest)} ; rv:outcome rv:Succeeded ;
      rv:erasureId ${lit(erasureId)} ; rv:erasureEpoch "${epoch}"^^xsd:integer ;
      rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(lineage.dataEpoch)} ;
      rv:sequence ?next . }
    GRAPH ${iri(GRAPHS.outbox)} { ${iri(batch)} a rv:OutboxBatch ;
      rv:dataEpoch ${lit(lineage.dataEpoch)} ; rv:sequence ?next ;
      rv:eventCount 1 ; rv:event ${iri(event)} .
      ${iri(event)} a rv:GraphErasureEvent ; rv:ordinal 0 ;
      rv:action "erasure.graph" ; rv:receipt ${iri(receipt)} ;
      rv:erasureId ${lit(erasureId)} ; rv:erasureEpoch "${epoch}"^^xsd:integer . }
  } WHERE {
    GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(lineage.dataEpoch)} ;
      rv:routingEpoch ${lit(lineage.routingEpoch)} ; rv:sequence ?n . }
    VALUES (?pubUnit ?privUnit ?target) { ${rows.join('\n')} }
    OPTIONAL { FILTER(BOUND(?pubUnit)) VALUES ?pubReference { rv:revision rv:contentRevision }
      GRAPH ${iri(PUBLIC)} { ?pubUnit ?pubReference ?target ; ?pubP ?pubO . } }
    OPTIONAL { FILTER(BOUND(?privUnit)) VALUES ?privReference { rv:revision rv:contentRevision }
      GRAPH ${iri(PRIVATE)} { ?privUnit ?privReference ?target ; ?privP ?privO . } }
    FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
    FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
    FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ?target a rv:ErasedRevision } }
    BIND(?n + 1 AS ?next)
  }`;
}

/** Exact receipt and tombstone proof; no search unit may still name any target. */
export async function graphErasureSuppressed(fuseki: FusekiClient, erasureId: string,
  epoch: string, revisionIds: readonly string[]): Promise<boolean> {
  const targets = checkedTargets(revisionIds);
  const receipt = graphErasureReceipt(erasureId);
  const digest = hash(JSON.stringify({ family: 'erasure-graph-v1', erasureId, epoch, targets }));
  const result = await fuseki.query(`PREFIX rv: <${RV}> SELECT DISTINCT ?target WHERE {
    VALUES ?target { ${targets.map(iri).join(' ')} }
    GRAPH ${iri(GRAPHS.revisions)} { ?target a rv:ErasedRevision ;
      rv:erasureEpoch ${epoch} . }
    GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ;
      rv:outcome rv:Succeeded ; rv:requestDigest ${lit(digest)} ;
      rv:erasureId ${lit(erasureId)} ;
      rv:erasureEpoch ${epoch} . }
    FILTER NOT EXISTS { GRAPH ${iri(PUBLIC)} { ?unit ?reference ?target
      FILTER(?reference IN (rv:revision, rv:contentRevision)) } }
    FILTER NOT EXISTS { GRAPH ${iri(PRIVATE)} { ?unit ?reference ?target
      FILTER(?reference IN (rv:revision, rv:contentRevision)) } }
  }`, 65_536);
  return new Set(result.results?.bindings.map(row => row.target?.value)).size === targets.length
    && targets.every(target => result.results?.bindings.some(row => row.target?.value === target));
}

export interface GraphSuppressionProof {
  receipt: string;
  dataEpoch: string;
  sequence: string;
}

/** Rebuild checks one historical active publication against its immutable
 * Content supersession before acknowledging the old outbox event. A verified
 * lineage cutover retains old receipts; the current, unheld graph is the source
 * of truth, so only receipts in the current epoch need a sequence comparison. */
export async function graphRevisionSuppressed(fuseki: FusekiClient, lineage: GraphLineage,
  revisionId: string, erasureId: string, epoch: string,
  proof: GraphSuppressionProof): Promise<boolean> {
  const target = checkedTargets([revisionId])[0]!;
  if (proof.receipt !== graphErasureReceipt(erasureId)
    || !UUID.test(proof.dataEpoch)
    || !/^[1-9][0-9]*$/.test(proof.sequence)) return false;
  const result = await fuseki.query(`PREFIX rv: <${RV}> ASK {
    GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(lineage.dataEpoch)} ;
      rv:routingEpoch ${lit(lineage.routingEpoch)} ; rv:sequence ?currentSequence .
      FILTER NOT EXISTS { ${iri(DATASET)} rv:restoreHold true } }
    GRAPH ${iri(GRAPHS.revisions)} { ${iri(target)} a rv:ErasedRevision ;
      rv:erasureEpoch ${epoch} . }
    GRAPH ${iri(GRAPHS.receipts)} { ${iri(proof.receipt)} a rv:OperationReceipt ;
      rv:outcome rv:Succeeded ; rv:erasureId ${lit(erasureId)} ;
      rv:erasureEpoch ${epoch} ; rv:dataEpoch ${lit(proof.dataEpoch)} ;
      rv:sequence ${proof.sequence} . }
    ${proof.dataEpoch === lineage.dataEpoch ? `FILTER(?currentSequence >= ${proof.sequence})` : ''}
    FILTER NOT EXISTS { GRAPH ${iri(PUBLIC)} { ?unit ?reference ${iri(target)}
      FILTER(?reference IN (rv:revision, rv:contentRevision)) } }
    FILTER NOT EXISTS { GRAPH ${iri(PRIVATE)} { ?unit ?reference ${iri(target)}
      FILTER(?reference IN (rv:revision, rv:contentRevision)) } }
  }`, 8192);
  return result.boolean === true;
}

/** The receipt, current lineage, tombstones and absence of indexed references
 * are read together before Content may supersede an active pin. */
export async function readGraphErasureProof(fuseki: FusekiClient, lineage: GraphLineage,
  erasureId: string, epoch: string, revisionIds: readonly string[]): Promise<GraphSuppressionProof> {
  const targets = checkedTargets(revisionIds);
  const receipt = graphErasureReceipt(erasureId);
  const digest = hash(JSON.stringify({ family: 'erasure-graph-v1', erasureId, epoch, targets }));
  const result = await fuseki.query(`PREFIX rv: <${RV}> SELECT DISTINCT ?target ?sequence WHERE {
    VALUES ?target { ${targets.map(iri).join(' ')} }
    GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(lineage.dataEpoch)} ;
      rv:routingEpoch ${lit(lineage.routingEpoch)} ; rv:sequence ?currentSequence .
      FILTER NOT EXISTS { ${iri(DATASET)} rv:restoreHold true } }
    GRAPH ${iri(GRAPHS.revisions)} { ?target a rv:ErasedRevision ; rv:erasureEpoch ${epoch} . }
    GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ;
      rv:requestDigest ${lit(digest)} ; rv:outcome rv:Succeeded ;
      rv:erasureId ${lit(erasureId)} ; rv:erasureEpoch ${epoch} ;
      rv:dataEpoch ${lit(lineage.dataEpoch)} ; rv:sequence ?sequence . }
    FILTER(?sequence <= ?currentSequence)
    FILTER NOT EXISTS { GRAPH ${iri(PUBLIC)} { ?unit ?reference ?target
      FILTER(?reference IN (rv:revision, rv:contentRevision)) } }
    FILTER NOT EXISTS { GRAPH ${iri(PRIVATE)} { ?unit ?reference ?target
      FILTER(?reference IN (rv:revision, rv:contentRevision)) } }
  }`, 65_536);
  const rows = result.results?.bindings ?? [];
  const sequence = rows[0]?.sequence?.value;
  if (rows.length !== targets.length || !/^[1-9][0-9]*$/.test(sequence ?? '')
    || new Set(rows.map(row => row.target?.value)).size !== targets.length
    || rows.some(row => !targets.includes(row.target?.value ?? '')
      || row.sequence?.value !== sequence)) {
    throw new GraphErasureUnavailable('exact graph suppression proof is unavailable');
  }
  return { receipt, dataEpoch: lineage.dataEpoch, sequence: sequence! };
}

/** One bounded native command, with at most three retries for a racing projection. */
export async function suppressGraphContentRevisions(fuseki: FusekiClient,
  lineage: GraphLineage, erasureId: string, epoch: string,
  revisionIds: readonly string[]): Promise<void> {
  if (!/^[1-9][0-9]{0,18}$/.test(epoch)) throw new GraphErasureConflict('invalid erasure epoch');
  const targets = checkedTargets(revisionIds);
  const receipt = graphErasureReceipt(erasureId);
  const digest = hash(JSON.stringify({ family: 'erasure-graph-v1', erasureId, epoch, targets }));
  const installed = await profile(fuseki);
  if (await graphErasureSuppressed(fuseki, erasureId, epoch, revisionIds)) return;
  let lastFailure: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    const units = await indexedUnits(fuseki, targets);
    try {
      const result = await fuseki.commandWithReceipt({ receipt, digest,
        update: update(lineage, targets, units, erasureId, epoch, receipt, digest),
        validations: [{ profile: PROFILE, sha256: installed.sha256,
          shape: SHAPE, focus: targets, graphs: [GRAPHS.revisions] }], deadlineMs: 10_000 });
      if (result.status === 'conflict' || result.status === 'unknown-profile') {
        throw new GraphErasureConflict('graph erasure receipt or profile conflicts');
      }
      if (result.status === 'invalid') throw new GraphErasureConflict(
        `graph erasure command invalid: ${JSON.stringify(result.report)}`);
      if (result.status !== 'committed') lastFailure = result.status;
    } catch (error) {
      if (error instanceof GraphErasureConflict) throw error;
      lastFailure = error;
      // An ambiguous HTTP outcome is resolved by the exact native receipt.
    }
    if (await graphErasureSuppressed(fuseki, erasureId, epoch, revisionIds)) return;
  }
  throw new GraphErasureUnavailable(`graph erasure did not produce an exact suppression receipt: ${String(lastFailure)}`);
}
