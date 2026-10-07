import { createHmac } from 'node:crypto';
import {
  CommandForbidden,
  CommandOutcomeUnknown,
  FusekiClient,
  type CommandEnvelope,
} from '../../infrastructure/fuseki.ts';
import { GRAPHS, DATASET, RV, hash, iri, lit, type GraphLineage } from '../work/activate.ts';
import {
  readRestoredGraphReleaseProof,
  type RestoredGraphReleaseExpectation,
} from '../work/restore-lineage.ts';
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
  if (
    !revisionIds.length ||
    revisionIds.length > MAX_TARGETS ||
    new Set(revisionIds).size !== revisionIds.length ||
    revisionIds.some((id) => !UUID.test(id))
  )
    throw new GraphErasureConflict('invalid graph targets');
  return [...revisionIds].sort().map((id) => `urn:rezics:content:revision:${id}`);
}

/** Public Content reads consult the graph tombstone even if the Content owner erase is still retrying. */
export async function graphErasedContentRevisions(
  fuseki: FusekiClient,
  revisionIds: readonly string[],
): Promise<Set<string>> {
  if (!revisionIds.length) return new Set();
  const targets = checkedTargets(revisionIds);
  const result = await fuseki.query(
    `PREFIX rv: <${RV}> SELECT ?target WHERE {
    VALUES ?target { ${targets.map(iri).join(' ')} }
    GRAPH ${iri(GRAPHS.revisions)} { ?target a rv:ErasedRevision }
  }`,
    65_536,
  );
  const rows = result.results?.bindings;
  if (
    !rows ||
    rows.some((row) => row.target?.type !== 'uri' || !targets.includes(row.target.value))
  ) {
    throw new GraphErasureUnavailable('Content suppression inventory is unavailable');
  }
  return new Set(rows.map((row) => row.target!.value.slice('urn:rezics:content:revision:'.length)));
}

async function profile(fuseki: FusekiClient) {
  const registry = profileRegistry as Record<string, { sha256: string; shapes: readonly string[] }>;
  const local = registry[PROFILE];
  if (
    !local?.shapes.includes(SHAPE) ||
    (await fuseki.commandHealth()).profiles[PROFILE] !== local.sha256
  ) {
    throw new GraphErasureUnavailable('graph erasure profile differs');
  }
  return local;
}

interface Unit {
  graph: typeof PUBLIC | typeof PRIVATE;
  unit: string;
  target: string;
}

/** One indexed triple-pattern read, at most 65 rows. A larger fanout is refused. */
async function indexedUnits(fuseki: FusekiClient, targets: readonly string[]): Promise<Unit[]> {
  const result = await fuseki.query(
    `PREFIX rv: <${RV}> SELECT DISTINCT ?graph ?unit ?target WHERE {
    VALUES ?target { ${targets.map(iri).join(' ')} }
    VALUES ?graph { ${iri(PUBLIC)} ${iri(PRIVATE)} }
    VALUES ?reference { rv:revision rv:contentRevision }
    GRAPH ?graph { ?unit ?reference ?target . }
  } ORDER BY ?graph ?unit LIMIT ${MAX_UNITS + 1}`,
    65_536,
  );
  const rows = result.results?.bindings ?? [];
  if (rows.length > MAX_UNITS)
    throw new GraphErasureUnavailable('indexed erasure fanout exceeds 64 units');
  const accepted = new Set(targets);
  const units = rows.map((row) => ({
    graph: row.graph?.value as Unit['graph'],
    unit: row.unit?.value ?? '',
    target: row.target?.value ?? '',
  }));
  if (
    units.some(
      (unit) =>
        ![PUBLIC, PRIVATE].includes(unit.graph) ||
        !/^urn:rezics:[a-z0-9:-]+$/.test(unit.unit) ||
        !accepted.has(unit.target),
    )
  ) {
    throw new GraphErasureUnavailable('indexed erasure inventory differs');
  }
  return units;
}

function update(
  lineage: GraphLineage,
  targets: readonly string[],
  units: readonly Unit[],
  erasureId: string,
  epoch: string,
  receipt: string,
  digest: string,
): string {
  const batch = `urn:rezics:outbox:${hash(`${receipt}\0batch`)}`;
  const event = `urn:rezics:event:${hash(`${receipt}\0event`)}`;
  const rows = [
    ...targets.map((target) => `(UNDEF UNDEF ${iri(target)})`),
    ...units.map((unit) =>
      unit.graph === PUBLIC
        ? `(${iri(unit.unit)} UNDEF ${iri(unit.target)})`
        : `(UNDEF ${iri(unit.unit)} ${iri(unit.target)})`,
    ),
  ];
  return `PREFIX rv: <${RV}> PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
  DELETE {
    GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n . }
    GRAPH ${iri(PUBLIC)} { ?pubUnit ?pubP ?pubO . }
    GRAPH ${iri(PRIVATE)} { ?privUnit ?privP ?privO . }
  } INSERT {
    GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next . }
    GRAPH ${iri(GRAPHS.revisions)} {
      ${targets.map((target) => `${iri(target)} a rv:ErasedRevision ; rv:erasureEpoch "${epoch}"^^xsd:integer .`).join('\n')}
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
export async function graphErasureSuppressed(
  fuseki: FusekiClient,
  erasureId: string,
  epoch: string,
  revisionIds: readonly string[],
  held?: HeldGraphErasureProof,
): Promise<boolean> {
  if (held)
    return (await probeHeldGraphErasureProof(fuseki, erasureId, epoch, revisionIds, held)) !== null;
  const targets = checkedTargets(revisionIds);
  const receipt = graphErasureReceipt(erasureId);
  const digest = hash(JSON.stringify({ family: 'erasure-graph-v1', erasureId, epoch, targets }));
  const result = await fuseki.query(
    `PREFIX rv: <${RV}> SELECT DISTINCT ?target WHERE {
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
  }`,
    65_536,
  );
  return (
    new Set(result.results?.bindings.map((row) => row.target?.value)).size === targets.length &&
    targets.every((target) => result.results?.bindings.some((row) => row.target?.value === target))
  );
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
export async function graphRevisionSuppressed(
  fuseki: FusekiClient,
  lineage: GraphLineage,
  revisionId: string,
  erasureId: string,
  epoch: string,
  proof: GraphSuppressionProof,
  held?: HeldGraphErasureProof,
): Promise<boolean> {
  if (held !== undefined) {
    try {
      const input = checkedHeld(held, erasureId, epoch, held.revisionIds);
      if (
        !held.revisionIds.includes(revisionId) ||
        proof.receipt !== input.original.receipt ||
        proof.dataEpoch !== input.original.dataEpoch ||
        proof.sequence !== input.original.sequence ||
        lineage.dataEpoch !== input.cut.dataEpoch ||
        lineage.routingEpoch !== input.cut.routingEpoch
      )
        return false;
      return (
        (await probeHeldGraphErasureProof(fuseki, erasureId, epoch, held.revisionIds, held)) !==
        null
      );
    } catch {
      return false;
    }
  }
  const target = checkedTargets([revisionId])[0]!;
  if (
    proof.receipt !== graphErasureReceipt(erasureId) ||
    !UUID.test(proof.dataEpoch) ||
    !/^[1-9][0-9]*$/.test(proof.sequence)
  )
    return false;
  const result = await fuseki.query(
    `PREFIX rv: <${RV}> ASK {
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
  }`,
    8192,
  );
  return result.boolean === true;
}

/** The receipt, current lineage, tombstones and absence of indexed references
 * are read together before Content may supersede an active pin. */
export async function readGraphErasureProof(
  fuseki: FusekiClient,
  lineage: GraphLineage,
  erasureId: string,
  epoch: string,
  revisionIds: readonly string[],
  held?: HeldGraphErasureProof | ReleasedGraphErasureProof,
): Promise<GraphSuppressionProof> {
  if (held !== undefined && 'released' in held) {
    const input = checkedHeld(held.captured, erasureId, epoch, revisionIds);
    const release = structuredClone(held.released);
    if (
      lineage.dataEpoch !== input.cut.dataEpoch ||
      lineage.routingEpoch !== input.cut.routingEpoch ||
      release.lineage.dataEpoch !== input.cut.dataEpoch ||
      release.lineage.routingEpoch !== input.cut.routingEpoch ||
      release.restoreCutover !== input.cut.restoreCutover ||
      release.saved.dataEpoch !== input.cut.priorDataEpoch ||
      release.saved.graphSequence !== input.cut.priorSequence
    )
      throw new GraphErasureConflict('released graph differs from the captured erasure cut');
    const released = await readRestoredGraphReleaseProof(fuseki, release);
    if (!released)
      throw new GraphErasureConflict('exact native graph release proof is unavailable');
    const proof = await probeErasureRecords(fuseki, erasureId, epoch, input, '');
    // The maintenance command binds the saved cut and captured Access generation.
    // A newer effective release cut cannot make its original receipt pre-cut.
    const needsReplay = input.original.dataEpoch !== input.cut.priorDataEpoch ||
      BigInt(input.original.sequence) > BigInt(input.cut.priorSequence);
    if (!(await readRestoredGraphReleaseProof(fuseki, released.expectation)))
      throw new GraphErasureConflict('native graph release evidence changed during erasure proof read');
    if (!proof.original || (needsReplay && !proof.own))
      throw new GraphErasureUnavailable('exact released graph suppression proof is unavailable');
    return { ...input.original };
  }
  if (held !== undefined) {
    if (lineage.dataEpoch !== held.cut.dataEpoch || lineage.routingEpoch !== held.cut.routingEpoch)
      throw new GraphErasureConflict('held graph lineage differs');
    const proof = await probeHeldGraphErasureProof(fuseki, erasureId, epoch, revisionIds, held);
    if (!proof)
      throw new GraphErasureUnavailable('exact held graph suppression proof is unavailable');
    return proof;
  }
  const targets = checkedTargets(revisionIds);
  const receipt = graphErasureReceipt(erasureId);
  const digest = hash(JSON.stringify({ family: 'erasure-graph-v1', erasureId, epoch, targets }));
  const result = await fuseki.query(
    `PREFIX rv: <${RV}>
    SELECT DISTINCT ?target ?sequence ?receiptEpoch ?currentSequence WHERE {
    VALUES ?target { ${targets.map(iri).join(' ')} }
    GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(lineage.dataEpoch)} ;
      rv:routingEpoch ${lit(lineage.routingEpoch)} ; rv:sequence ?currentSequence .
      FILTER NOT EXISTS { ${iri(DATASET)} rv:restoreHold true } }
    GRAPH ${iri(GRAPHS.revisions)} { ?target a rv:ErasedRevision ; rv:erasureEpoch ${epoch} . }
    GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ;
      rv:requestDigest ${lit(digest)} ; rv:outcome rv:Succeeded ;
      rv:erasureId ${lit(erasureId)} ; rv:erasureEpoch ${epoch} ;
      rv:dataEpoch ?receiptEpoch ; rv:sequence ?sequence . }
    FILTER NOT EXISTS { GRAPH ${iri(PUBLIC)} { ?unit ?reference ?target
      FILTER(?reference IN (rv:revision, rv:contentRevision)) } }
    FILTER NOT EXISTS { GRAPH ${iri(PRIVATE)} { ?unit ?reference ?target
      FILTER(?reference IN (rv:revision, rv:contentRevision)) } }
  }`,
    65_536,
  );
  const rows = result.results?.bindings ?? [];
  const sequence = rows[0]?.sequence?.value;
  const receiptEpoch = rows[0]?.receiptEpoch?.value;
  if (
    rows.length !== targets.length ||
    !/^[1-9][0-9]*$/.test(sequence ?? '') ||
    !UUID.test(receiptEpoch ?? '') ||
    new Set(rows.map((row) => row.target?.value)).size !== targets.length ||
    rows.some(
      (row) =>
        !targets.includes(row.target?.value ?? '') ||
        row.sequence?.value !== sequence ||
        row.receiptEpoch?.value !== receiptEpoch ||
        !/^(0|[1-9][0-9]*)$/.test(row.currentSequence?.value ?? '') ||
        (receiptEpoch === lineage.dataEpoch &&
          BigInt(sequence!) > BigInt(row.currentSequence!.value)),
    )
  ) {
    throw new GraphErasureUnavailable('exact graph suppression proof is unavailable');
  }
  return { receipt, dataEpoch: receiptEpoch!, sequence: sequence! };
}

/** One bounded native command, with at most three retries for a racing projection. */
export async function suppressGraphContentRevisions(
  fuseki: FusekiClient,
  lineage: GraphLineage,
  erasureId: string,
  epoch: string,
  revisionIds: readonly string[],
): Promise<void> {
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
      const result = await fuseki.commandWithReceipt({
        receipt,
        digest,
        update: update(lineage, targets, units, erasureId, epoch, receipt, digest),
        validations: [
          {
            profile: PROFILE,
            sha256: installed.sha256,
            shape: SHAPE,
            focus: targets,
            graphs: [GRAPHS.revisions],
          },
        ],
        deadlineMs: 10_000,
      });
      if (result.status === 'conflict' || result.status === 'unknown-profile') {
        throw new GraphErasureConflict('graph erasure receipt or profile conflicts');
      }
      if (result.status === 'invalid')
        throw new GraphErasureConflict(
          `graph erasure command invalid: ${JSON.stringify(result.report)}`,
        );
      if (result.status !== 'committed') lastFailure = result.status;
    } catch (error) {
      if (error instanceof GraphErasureConflict) throw error;
      lastFailure = error;
      // An ambiguous HTTP outcome is resolved by the exact native receipt.
    }
    if (await graphErasureSuppressed(fuseki, erasureId, epoch, revisionIds)) return;
  }
  throw new GraphErasureUnavailable(
    `graph erasure did not produce an exact suppression receipt: ${String(lastFailure)}`,
  );
}

const HELD_FAMILY = 'rezics-erasure-restore-v1';
const HELD_RECEIPT = 'urn:rezics:receipt:erasure-restore:';
const XSD = 'http://www.w3.org/2001/XMLSchema#';

export interface HeldGraphErasureCut extends GraphLineage {
  restoreCutover: string;
  priorDataEpoch: string;
  priorSequence: string;
}

/** Original proof comes from independently verified retained custody, never
 * from a relay epoch, stream counter or the older restored copy's journal. */
export interface HeldGraphErasureProof {
  cut: HeldGraphErasureCut;
  accessHoldGeneration: string;
  revisionIds: readonly string[];
  original: GraphSuppressionProof;
}

/** Read-only evidence for an interrupted release; never authorizes held replay. */
export interface ReleasedGraphErasureProof {
  released: RestoredGraphReleaseExpectation;
  captured: HeldGraphErasureProof;
}

export interface HeldGraphErasureReplay extends HeldGraphErasureProof {
  signingKey: string;
  maintenance: Pick<FusekiClient, 'command'>;
  /** The outer owner provides current independent journal/exact entry,
   * original proof, allocator lock, and both holds at the captured generation.
   * Its borrowed transactions remain held through send/probe/release. */
  assertCurrent: (entry: HeldGraphErasureAuthorization) => Promise<void>;
}

export interface HeldGraphErasureAuthorization extends HeldGraphErasureProof {
  erasureId: string;
  epoch: string;
}
export interface HeldErasureUnit {
  graph: typeof PUBLIC | typeof PRIVATE;
  unit: string;
}

/** The SDK has not yet registered this family. An explicit maintenance-only
 * instance sends the maintenance bearer even through its ordinary-token slot;
 * it cannot authorize an ordinary backend command. No global client is changed. */
export function heldErasureMaintenanceClient(url: string, capability: string): FusekiClient {
  if (!/^[0-9a-f]{64}$/.test(capability))
    throw new GraphErasureConflict('invalid maintenance capability');
  return new FusekiClient(url, capability, capability);
}

function checkedCut(cut: HeldGraphErasureCut): HeldGraphErasureCut {
  if (
    ![
      cut.dataEpoch,
      cut.routingEpoch,
      cut.restoreCutover,
      cut.priorDataEpoch,
      cut.priorSequence,
    ].every((value) => typeof value === 'string') ||
    !UUID.test(cut.dataEpoch) ||
    !(UUID.test(cut.routingEpoch) || /^(0|[1-9][0-9]*)$/.test(cut.routingEpoch)) ||
    cut.restoreCutover !== `urn:rezics:restore:${cut.dataEpoch}` ||
    !UUID.test(cut.priorDataEpoch) ||
    !/^(0|[1-9][0-9]*)$/.test(cut.priorSequence)
  )
    throw new GraphErasureConflict('invalid held graph cut');
  return {
    dataEpoch: cut.dataEpoch,
    routingEpoch: cut.routingEpoch,
    restoreCutover: cut.restoreCutover,
    priorDataEpoch: cut.priorDataEpoch,
    priorSequence: cut.priorSequence,
  };
}

function checkedHeld(
  held: HeldGraphErasureProof,
  erasureId: string,
  epoch: string,
  revisionIds: readonly string[],
) {
  const targets = checkedTargets(revisionIds);
  if (
    typeof erasureId !== 'string' ||
    typeof epoch !== 'string' ||
    typeof held.accessHoldGeneration !== 'string' ||
    !UUID.test(erasureId) ||
    !/^[1-9][0-9]{0,18}$/.test(epoch) ||
    !/^(0|[1-9][0-9]{0,18})$/.test(held.accessHoldGeneration) ||
    JSON.stringify(targets) !== JSON.stringify(checkedTargets(held.revisionIds))
  )
    throw new GraphErasureConflict('held erasure entry differs');
  const cut = checkedCut(held.cut);
  const original = {
    receipt: held.original.receipt,
    dataEpoch: held.original.dataEpoch,
    sequence: held.original.sequence,
  };
  if (
    ![original.receipt, original.dataEpoch, original.sequence].every(
      (value) => typeof value === 'string',
    ) ||
    original.receipt !== graphErasureReceipt(erasureId) ||
    !UUID.test(original.dataEpoch) ||
    original.dataEpoch === cut.dataEpoch ||
    !/^[1-9][0-9]*$/.test(original.sequence)
  )
    throw new GraphErasureConflict('invalid retained historical graph proof');
  const originalDigest = hash(JSON.stringify({ family: PROFILE, erasureId, epoch, targets }));
  const digest = hash(
    JSON.stringify([
      HELD_FAMILY,
      cut.dataEpoch,
      cut.routingEpoch,
      cut.restoreCutover,
      held.accessHoldGeneration,
      original.dataEpoch,
      original.sequence,
      originalDigest,
      cut.priorDataEpoch,
      cut.priorSequence,
    ]),
  );
  return {
    cut,
    original,
    targets,
    originalDigest,
    digest,
    receipt: `${HELD_RECEIPT}${digest}`,
    accessHoldGeneration: held.accessHoldGeneration,
  };
}

/** Positive, exact held control plus rejection of competing values. The cursor
 * is observed without changing it; the native policy preserves its exact facts. */
export function heldGraphErasureControl(captured: HeldGraphErasureCut): string {
  const cut = checkedCut(captured);
  const exact = [
    [DATASET, 'dataEpoch', lit(cut.dataEpoch)],
    [DATASET, 'routingEpoch', lit(cut.routingEpoch)],
    [DATASET, 'sequence', '0'],
    [DATASET, 'restoreCutover', iri(cut.restoreCutover)],
    [DATASET, 'restoreHold', 'true'],
    [cut.restoreCutover, 'dataEpoch', lit(cut.dataEpoch)],
    [cut.restoreCutover, 'priorDataEpoch', lit(cut.priorDataEpoch)],
    [cut.restoreCutover, 'priorSequence', cut.priorSequence],
  ];
  return `GRAPH ${iri(GRAPHS.control)} {
    ${exact.map(([subject, predicate, object]) => `${iri(subject!)} rv:${predicate} ${object} .`).join('\n')}
    ${iri(cut.restoreCutover)} a rv:RestoreCutover .
    ${exact.map(([subject, predicate, object], i) => `FILTER NOT EXISTS { ${iri(subject!)} rv:${predicate} ?other${i} FILTER(!sameTerm(?other${i}, ${object})) }`).join('\n')}
    FILTER NOT EXISTS { ${iri(cut.restoreCutover)} rv:reconciledPriorSequence ?a, ?b FILTER(!sameTerm(?a, ?b)) }
    FILTER NOT EXISTS { ${iri(cut.restoreCutover)} rv:reconciledPriorSequence ?cursor .
      BIND(<${XSD}integer>(STR(?cursor)) AS ?parsedCursor)
      FILTER(!isLiteral(?cursor) || !BOUND(?parsedCursor) || ?parsedCursor < 0) }
  }`;
}

export async function heldGraphLineageSequence(
  fuseki: FusekiClient,
  cut: HeldGraphErasureCut,
): Promise<string | null> {
  const result = await fuseki.query(
    `PREFIX rv: <${RV}> SELECT ?sequence WHERE {
    ${heldGraphErasureControl(cut)} BIND(0 AS ?sequence) }`,
    65_536,
  );
  const rows = result.results?.bindings;
  return rows?.length === 1 &&
    rows[0]?.sequence?.type === 'literal' &&
    rows[0].sequence.value === '0' &&
    rows[0].sequence.datatype === `${XSD}integer`
    ? '0'
    : null;
}

async function heldIndexedUnits(
  fuseki: FusekiClient,
  targets: readonly string[],
  cut: HeldGraphErasureCut,
): Promise<HeldErasureUnit[]> {
  return erasureIndexedUnits(fuseki, targets, heldGraphErasureControl(cut));
}

async function erasureIndexedUnits(
  fuseki: FusekiClient,
  targets: readonly string[],
  control: string,
): Promise<HeldErasureUnit[]> {
  const result = await fuseki.query(
    `PREFIX rv: <${RV}> SELECT DISTINCT ?graph ?unit WHERE {
    ${control}
    VALUES ?target { ${targets.map(iri).join(' ')} }
    VALUES ?graph { ${iri(PUBLIC)} ${iri(PRIVATE)} }
    VALUES ?reference { rv:revision rv:contentRevision }
    GRAPH ?graph { ?unit ?reference ?target }
  } ORDER BY ?graph ?unit LIMIT ${MAX_UNITS + 1}`,
    65_536,
  );
  const rows = result.results?.bindings;
  if (
    !rows ||
    rows.length > MAX_UNITS ||
    rows.some(
      (row) =>
        row.graph?.type !== 'uri' ||
        row.unit?.type !== 'uri' ||
        ![PUBLIC, PRIVATE].includes(row.graph.value) ||
        !/^urn:rezics:[a-z0-9:-]+$/.test(row.unit.value),
    )
  )
    throw new GraphErasureUnavailable('exact held unit inventory is unavailable');
  const units = rows.map((row) => ({
    graph: row.graph!.value as HeldErasureUnit['graph'],
    unit: row.unit!.value,
  }));
  if (new Set(units.map((unit) => `${unit.graph}\0${unit.unit}`)).size !== units.length)
    throw new GraphErasureConflict('held unit inventory is duplicated');
  return units;
}

function heldRecords(input: ReturnType<typeof checkedHeld>, erasureId: string, epoch: string) {
  const records = new Map<
    string,
    { graph: string; subject: string; fields: Map<string, string> }
  >();
  const field = (kind: 'uri' | 'string' | 'integer', value: string) =>
    JSON.stringify([kind, value]);
  const add = (graph: string, subject: string, values: Record<string, string>) =>
    records.set(`${graph}\0${subject}`, {
      graph,
      subject,
      fields: new Map(
        Object.entries(values).map(([predicate, value]) => [
          predicate === 'type'
            ? 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type'
            : `${RV}${predicate}`,
          value,
        ]),
      ),
    });
  for (const target of input.targets)
    add(GRAPHS.revisions, target, {
      type: field('uri', `${RV}ErasedRevision`),
      erasureEpoch: field('integer', epoch),
    });
  add(GRAPHS.receipts, input.original.receipt, {
    type: field('uri', `${RV}OperationReceipt`),
    requestDigest: field('string', input.originalDigest),
    datasetId: field('uri', DATASET),
    dataEpoch: field('string', input.original.dataEpoch),
    sequence: field('integer', input.original.sequence),
    outcome: field('uri', `${RV}Succeeded`),
    erasureId: field('string', erasureId),
    erasureEpoch: field('integer', epoch),
  });
  add(GRAPHS.receipts, input.receipt, {
    type: field('uri', `${RV}OperationReceipt`),
    commandFamily: field('string', HELD_FAMILY),
    requestDigest: field('string', input.digest),
    datasetId: field('uri', DATASET),
    dataEpoch: field('string', input.cut.dataEpoch),
    sequence: field('integer', '0'),
    outcome: field('uri', `${RV}Succeeded`),
    restoredReceipt: field('uri', input.original.receipt),
    restoreCutover: field('uri', input.cut.restoreCutover),
    erasureId: field('string', erasureId),
    erasureEpoch: field('integer', epoch),
  });
  return records;
}

function exactTerm(
  term: { type: string; value: string; datatype?: string; 'xml:lang'?: string } | undefined,
): string {
  if (!term || term['xml:lang']) throw new GraphErasureConflict('held proof term is unavailable');
  if (term.type === 'uri') return JSON.stringify(['uri', term.value]);
  if (term.type !== 'literal') throw new GraphErasureConflict('held proof term differs');
  if (!term.datatype || term.datatype === `${XSD}string`)
    return JSON.stringify(['string', term.value]);
  if (term.datatype === `${XSD}integer`) return JSON.stringify(['integer', term.value]);
  throw new GraphErasureConflict('held proof datatype differs');
}

/** Whole bounded subjects, not a positive-match subset that hides corruption. */
export async function probeHeldGraphErasureProof(
  fuseki: FusekiClient,
  erasureId: string,
  epoch: string,
  revisionIds: readonly string[],
  held: HeldGraphErasureProof,
  requireReplayReceipt = false,
  capturedOriginalOnly = false,
): Promise<GraphSuppressionProof | null> {
  const input = checkedHeld(held, erasureId, epoch, revisionIds);
  if ((await heldGraphLineageSequence(fuseki, input.cut)) !== '0')
    throw new GraphErasureConflict('graph is not held at the captured cut');
  const { original, own } = await probeErasureRecords(
    fuseki, erasureId, epoch, input, heldGraphErasureControl(input.cut),
  );
  if ((await heldGraphLineageSequence(fuseki, input.cut)) !== '0')
    throw new GraphErasureConflict('held graph changed during proof read');
  if (!original) {
    if (
      input.original.dataEpoch === input.cut.priorDataEpoch &&
      BigInt(input.original.sequence) <= BigInt(input.cut.priorSequence)
    )
      throw new GraphErasureConflict('original proof is missing from its captured source cut');
    return null;
  }
  return (requireReplayReceipt && !own) || (capturedOriginalOnly && own)
    ? null
    : { ...input.original };
}

/** Both held and released reads inspect the same complete bounded subjects. */
async function probeErasureRecords(
  fuseki: FusekiClient,
  erasureId: string,
  epoch: string,
  input: ReturnType<typeof checkedHeld>,
  control: string,
): Promise<{ original: boolean; own: boolean }> {
  const expected = heldRecords(input, erasureId, epoch);
  const maximum = [...expected.values()].reduce((count, record) => count + record.fields.size, 0);
  const result = await fuseki.query(
    `PREFIX rv: <${RV}> SELECT ?graph ?subject ?predicate ?object WHERE {
    ${control}
    VALUES (?graph ?subject) { ${[...expected.values()].map((record) => `(${iri(record.graph)} ${iri(record.subject)})`).join(' ')} }
    GRAPH ?graph { ?subject ?predicate ?object }
  } LIMIT ${maximum + 1}`,
    65_536,
  );
  const rows = result.results?.bindings;
  if (!rows) throw new GraphErasureUnavailable('held erasure proof rows are unavailable');
  if (rows.length > maximum)
    throw new GraphErasureConflict('erasure proof inventory exceeds its exact bound');
  const found = new Map<string, Set<string>>();
  for (const row of rows) {
    if (row.graph?.type !== 'uri' || row.subject?.type !== 'uri' || row.predicate?.type !== 'uri')
      throw new GraphErasureConflict('held proof identity differs');
    const id = `${row.graph.value}\0${row.subject.value}`;
    const record = expected.get(id),
      actual = exactTerm(row.object);
    if (!record || record.fields.get(row.predicate.value) !== actual)
      throw new GraphErasureConflict('held erasure proof diverges');
    const fields = found.get(id) ?? new Set<string>();
    if (fields.has(row.predicate.value))
      throw new GraphErasureConflict('held erasure proof is ambiguous');
    fields.add(row.predicate.value);
    found.set(id, fields);
  }
  for (const [id, fields] of found)
    if (fields.size !== expected.get(id)!.fields.size)
      throw new GraphErasureConflict('held erasure proof is partial');
  const targetCount = input.targets.filter((target) =>
    found.has(`${GRAPHS.revisions}\0${target}`),
  ).length;
  if (targetCount !== 0 && targetCount !== input.targets.length)
    throw new GraphErasureConflict('held tombstone set is partial');
  const original = found.has(`${GRAPHS.receipts}\0${input.original.receipt}`);
  const own = found.has(`${GRAPHS.receipts}\0${input.receipt}`);
  if ((original || own) && (targetCount !== input.targets.length || !original))
    throw new GraphErasureConflict('held receipt lacks complete original proof');
  const units = await erasureIndexedUnits(fuseki, input.targets, control);
  if ((original || own) && units.length)
    throw new GraphErasureConflict('held erasure retains indexed references');
  return { original, own };
}

/** Exact native wire bytes; callers authorize the entry before invoking this signer. */
export function buildHeldGraphErasureCommand(
  erasureId: string,
  epoch: string,
  revisionIds: readonly string[],
  held: HeldGraphErasureProof,
  units: readonly HeldErasureUnit[],
  signingKey: string,
  expiresAt = new Date(Date.now() + 60_000).toISOString(),
): CommandEnvelope {
  const input = checkedHeld(held, erasureId, epoch, revisionIds);
  if (
    !/^[0-9a-f]{64}$/.test(signingKey) ||
    !Number.isFinite(Date.parse(expiresAt)) ||
    Date.parse(expiresAt) <= Date.now() ||
    units.length > MAX_UNITS ||
    new Set(units.map((unit) => `${unit.graph}\0${unit.unit}`)).size !== units.length ||
    units.some(
      (unit) =>
        ![PUBLIC, PRIVATE].includes(unit.graph) || !/^urn:rezics:[a-z0-9:-]+$/.test(unit.unit),
    )
  )
    throw new GraphErasureConflict('invalid held erasure signing input');
  const patterns = units.map(
    (unit, n) => `GRAPH ${iri(unit.graph)} { ${iri(unit.unit)} ?p${n} ?o${n} . }`,
  );
  const inserts = [...heldRecords(input, erasureId, epoch).values()]
    .map(
      (record) => `GRAPH ${iri(record.graph)} {
    ${[...record.fields]
      .map(([predicate, encoded]) => {
        const [kind, value] = JSON.parse(encoded) as [string, string];
        const object =
          kind === 'uri'
            ? value.startsWith(RV)
              ? `rv:${value.slice(RV.length)}`
              : iri(value)
            : kind === 'integer'
              ? `${lit(value)}^^xsd:integer`
              : lit(value);
        const term =
          predicate === 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type'
            ? 'a'
            : `rv:${predicate.slice(RV.length)}`;
        return `${iri(record.subject)} ${term} ${object} .`;
      })
      .join('\n')} }`,
    )
    .join('\n');
  // Mutation WHERE is the native closed structure: one concrete control block,
  // then one UNION of keyed reads. No OPTIONAL cross product or control write.
  const control = `GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(input.cut.dataEpoch)} ;
    rv:routingEpoch ${lit(input.cut.routingEpoch)} ; rv:sequence 0 ;
    rv:restoreCutover ${iri(input.cut.restoreCutover)} ; rv:restoreHold true . }`;
  const update = `PREFIX rv: <${RV}> PREFIX xsd: <${XSD}> DELETE { ${patterns.join('\n')} }
    INSERT { ${inserts} } WHERE { ${control} ${patterns.length ? `{ ${patterns.map((pattern) => `{ ${pattern} }`).join(' UNION ')} }` : ''} }`;
  const payload = JSON.stringify([
    HELD_FAMILY,
    input.receipt,
    input.digest,
    hash(update),
    input.cut.dataEpoch,
    input.cut.routingEpoch,
    input.cut.restoreCutover,
    input.accessHoldGeneration,
    erasureId,
    epoch,
    input.targets,
    input.original.dataEpoch,
    input.original.sequence,
    input.originalDigest,
    expiresAt,
    input.cut.priorDataEpoch,
    input.cut.priorSequence,
  ]);
  return {
    receipt: input.receipt,
    digest: input.digest,
    update,
    validations: [],
    deadlineMs: 10_000,
    titleAdmission: {
      payload,
      signature: createHmac('sha256', signingKey).update(payload).digest('hex'),
    },
  };
}

/** One existing suppression operation in explicit held mode; every attempt
 * authorizes current borrowed owner state and probes the complete exact proof. */
export async function suppressHeldGraphContentRevisions(
  fuseki: FusekiClient,
  erasureId: string,
  epoch: string,
  revisionIds: readonly string[],
  held: HeldGraphErasureReplay,
): Promise<GraphSuppressionProof> {
  const input = checkedHeld(held, erasureId, epoch, revisionIds);
  const snapshot: HeldGraphErasureProof = {
    cut: input.cut,
    accessHoldGeneration: input.accessHoldGeneration,
    revisionIds: input.targets.map((target) => target.slice('urn:rezics:content:revision:'.length)),
    original: input.original,
  };
  const authorize = () =>
    held.assertCurrent({
      cut: { ...snapshot.cut },
      original: { ...snapshot.original },
      accessHoldGeneration: snapshot.accessHoldGeneration,
      revisionIds: [...snapshot.revisionIds],
      erasureId,
      epoch,
    });
  let lastFailure: unknown;
  let sent = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    await authorize();
    if ((await heldGraphLineageSequence(fuseki, input.cut)) !== '0')
      throw new GraphErasureConflict('held graph cut is unavailable');
    const existing = await probeHeldGraphErasureProof(
      fuseki,
      erasureId,
      epoch,
      revisionIds,
      snapshot,
      sent,
      true,
    );
    if (existing) return existing;
    const units = await heldIndexedUnits(fuseki, input.targets, input.cut);
    await authorize();
    if ((await heldGraphLineageSequence(fuseki, input.cut)) !== '0')
      throw new GraphErasureConflict('held graph cut changed before signing');
    const command = buildHeldGraphErasureCommand(
      erasureId,
      epoch,
      revisionIds,
      snapshot,
      units,
      held.signingKey,
    );
    try {
      sent = true;
      const result = await held.maintenance.command(command);
      if (
        result.status === 'invalid' ||
        result.status === 'conflict' ||
        result.status === 'unknown-profile'
      )
        throw new GraphErasureConflict('native held erasure replay refused');
      if (
        result.status === 'committed' &&
        (result.position.datasetId !== DATASET ||
          result.position.dataEpoch !== input.cut.dataEpoch ||
          result.position.sequence !== '0')
      )
        throw new GraphErasureConflict('native held erasure replay advanced or changed lineage');
      lastFailure = result.status;
      if (result.status !== 'committed') continue;
    } catch (error) {
      if (error instanceof GraphErasureConflict) throw error;
      if (error instanceof CommandForbidden)
        throw new GraphErasureUnavailable('native held erasure maintenance capability unavailable');
      if (!(error instanceof CommandOutcomeUnknown))
        throw new GraphErasureUnavailable('native held erasure request was not accepted');
      lastFailure = error;
    }
    await authorize();
    const proof = await probeHeldGraphErasureProof(
      fuseki,
      erasureId,
      epoch,
      revisionIds,
      snapshot,
      true,
    );
    if (proof) return proof;
  }
  throw new GraphErasureUnavailable(
    `native held erasure proof is unavailable: ${String(lastFailure)}`,
  );
}
