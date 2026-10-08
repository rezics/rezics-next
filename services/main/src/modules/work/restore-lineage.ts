import { StructureQualifierRootStore } from '../structure/qualifier-index.ts';
import { StructureGroupRootStore } from '../structure/group-root.ts';
import { DATASET, GRAPHS, RV, hash, iri, lit, type GraphLineage } from './activate.ts';
import type { FusekiClient } from '../../infrastructure/fuseki.ts';
import { knownSearchPosition } from '../search/snapshot-state.ts';
import type { Pool, PoolClient } from 'pg';
import { accessOutboxCoverage, accessStateCoverage,
  scanAccessOutbox, scanAccessState } from './access-recovery-coverage.ts';
import { relayCoverage, relayCoverageOnClient, type RelayCoverage } from '../outbox/relay.ts';
import { MAIN_RELAY_STREAM_SCOPE, type RelayHandoffPosition } from '../outbox/relay-position.ts';
import { assertAccountDeletionJournalCoverage } from
  '../outbox/account-deletion-journal.ts';
import { assertAccountSubjectDeletionsAbsent } from
  '../outbox/account-subject-deletion.ts';
import { assertCurrentRecoveryCoverageHead } from
  '../outbox/recovery-coverage-head.ts';
import { assertDeletionRecoverySet, type DeletionRecoverySet } from
  '../../../../account/src/deletion-recovery-set.ts';
import { openRecoveryPayload } from '../../../../account/src/recovery-envelope.ts';
import { accountRecoveryCoverage, assertAccountRecoveryCoverage,
  type AccountRecoveryCoverage } from '../../../../account/src/recovery-coverage.ts';
import { advancePgRecoveryFrontier, assertPgRecoveryFrontier, capturePgRecoveryFrontier,
  type PgRecoveryFrontier } from './pg-recovery-frontier.ts';
import { assertContentRecoveryCoverage, captureContentRecoveryCoverage,
  graphContentReferences, type ContentRecoveryCoverage, type ContentRecoveryProofContext } from './content-recovery-coverage.ts';
import { assertCommerceRecoveryCoverageOnClient, captureCommerceRecoveryCoverage,
  type CommerceRecoveryCoverage } from '../commerce/recovery-coverage.ts';
import { assertObjectRecoveryCoverage, captureObjectRecoveryCoverage,
  ObjectRecoveryConflict,
  type ObjectRecoveryCoverage, type ObjectRecoveryStore } from '../owner/object-coverage.ts';

export class RestoreLineageConflict extends Error {}
export class RecoveryHold extends Error {}

export interface RestoreLineageCutover {
  prior: GraphLineage & { sequence: string };
  next: GraphLineage;
}

export interface RestoredGraphReleaseExpectation {
  lineage: GraphLineage;
  restoreCutover: string;
  saved: { dataEpoch: string; graphSequence: string; main?: RelayHandoffPosition };
  effective: { dataEpoch: string; graphSequence: string; main?: RelayHandoffPosition };
}

export interface RestoredGraphReleaseProof {
  expectation: RestoredGraphReleaseExpectation;
  receipt: { id: string; requestDigest: string; dataEpoch: string; sequence: '0' };
}

/** Read native release evidence afresh; this never authorizes an owner effect. */
export async function readRestoredGraphReleaseProof(
  fuseki: FusekiClient, expected: RestoredGraphReleaseExpectation,
): Promise<RestoredGraphReleaseProof | null> {
  // Project only primitive contract members: caller extras/toJSON cannot change identity.
  const main = (value: RelayHandoffPosition | undefined) => value === undefined ? undefined : {
    streamScope: value?.streamScope, dataEpoch: value?.dataEpoch, sequence: value?.sequence,
  };
  expected = { lineage: { dataEpoch: expected?.lineage?.dataEpoch, routingEpoch: expected?.lineage?.routingEpoch },
    restoreCutover: expected?.restoreCutover,
    saved: { dataEpoch: expected?.saved?.dataEpoch, graphSequence: expected?.saved?.graphSequence,
      ...(expected?.saved?.main === undefined ? {} : { main: main(expected.saved.main) }) },
    effective: { dataEpoch: expected?.effective?.dataEpoch, graphSequence: expected?.effective?.graphSequence,
      ...(expected?.effective?.main === undefined ? {} : { main: main(expected.effective.main) }) } };
  const { lineage, saved, effective, restoreCutover } = expected;
  const paired = saved.main !== undefined;
  if (paired !== (effective.main !== undefined)) return null;
  let bytes = 0;
  const strings = [lineage.dataEpoch, lineage.routingEpoch, restoreCutover, saved.dataEpoch,
    saved.graphSequence, effective.dataEpoch, effective.graphSequence, ...(paired
      ? [saved.main!.streamScope, saved.main!.dataEpoch, saved.main!.sequence,
        effective.main!.streamScope, effective.main!.dataEpoch, effective.main!.sequence] : [])];
  if (!strings.every(value => typeof value === 'string' && value.length <= 16_384
    && (bytes += Buffer.byteLength(JSON.stringify(value))) <= 16_384)
    || Buffer.byteLength(JSON.stringify(expected)) > 16_384) return null;
  const canonical = (value: string) => /^(0|[1-9][0-9]*)$/.test(value);
  if (saved.dataEpoch !== effective.dataEpoch
    || restoreCutover !== `urn:rezics:restore:${lineage.dataEpoch}`
    || !canonical(saved.graphSequence) || !canonical(effective.graphSequence)
    || BigInt(effective.graphSequence) < BigInt(saved.graphSequence)) return null;
  if (paired && [saved, effective].some(cut => cut.main?.streamScope !== MAIN_RELAY_STREAM_SCOPE
    || cut.main.dataEpoch !== cut.dataEpoch || !canonical(cut.main.sequence))) return null;
  if (paired && BigInt(effective.main!.sequence) < BigInt(saved.main!.sequence)) return null;
  // Keep the release writer's ordered v1/v2 identity, including graph/Main separation.
  const id = `urn:rezics:receipt:restore-release:${hash(lineage.dataEpoch)}`;
  const requestDigest = hash(JSON.stringify(paired
    ? { family: 'restore-release-v2', lineage, priorDataEpoch: effective.dataEpoch,
      priorSequence: effective.graphSequence, priorMainSequence: effective.main!.sequence,
      streamScope: MAIN_RELAY_STREAM_SCOPE }
    : { family: 'restore-release-v1', lineage, priorDataEpoch: effective.dataEpoch,
      priorSequence: effective.graphSequence }));
  const result = await fuseki.query(`SELECT ?graph ?subject ?predicate ?object WHERE {
    { BIND(${iri(GRAPHS.control)} AS ?graph) BIND(${iri(DATASET)} AS ?subject)
      GRAPH ?graph { ?subject ?predicate ?object }
      VALUES ?predicate { ${['dataEpoch', 'routingEpoch', 'sequence', 'restoreCutover', 'restoreHold']
        .map(name => `<${RV}${name}>`).join(' ')} } }
    UNION { BIND(${iri(GRAPHS.control)} AS ?graph) BIND(IRI(${lit(restoreCutover)}) AS ?subject)
      GRAPH ?graph { ?subject ?predicate ?object } }
    ${paired ? `UNION { BIND(${iri(GRAPHS.control)} AS ?graph) BIND(${iri(MAIN_RELAY_STREAM_SCOPE)} AS ?subject)
      GRAPH ?graph { ?subject ?predicate ?object } }` : ''}
    UNION { BIND(${iri(GRAPHS.receipts)} AS ?graph) BIND(${iri(id)} AS ?subject)
      GRAPH ?graph { ?subject ?predicate ?object } }
  } LIMIT 22`, 16_384);
  const rows = result.results?.bindings;
  if (!rows || rows.length > 21) return null;
  type Term = NonNullable<typeof rows>[number][string];
  const uri = (value: string): Term => ({ type: 'uri', value });
  const literal = (value: string, datatype = 'string'): Term => ({ type: 'literal', value,
    datatype: `http://www.w3.org/2001/XMLSchema#${datatype}` });
  const same = (actual: Term | undefined, wanted: Term): boolean => !!actual
    && actual.type === wanted.type && actual.value === wanted.value
    // SPARQL JSON may omit xsd:string; integer identity still requires its datatype.
    && (actual.datatype === wanted.datatype || actual.datatype === undefined
      && wanted.datatype === 'http://www.w3.org/2001/XMLSchema#string')
    && actual['xml:lang'] === undefined;
  const type = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
  const facts = new Map<string, Map<string, Term>>();
  for (const row of rows) {
    const graph = row.graph, subject = row.subject, predicate = row.predicate, object = row.object;
    if (!graph || !subject || !predicate || !object
      || !same(graph, uri(graph.value)) || !same(subject, uri(subject.value))
      || !same(predicate, uri(predicate.value))) return null;
    const key = `${graph.value}\n${subject.value}`;
    const fields = facts.get(key) ?? new Map<string, Term>();
    if (fields.has(predicate.value)) return null;
    fields.set(predicate.value, object);
    facts.set(key, fields);
  }
  const exact = (graph: string, subject: string, wanted: [string, Term][]): boolean => {
    const fields = facts.get(`${graph}\n${subject}`);
    return fields?.size === wanted.length && wanted.every(([predicate, object]) => same(fields.get(predicate), object));
  };
  const field = (name: string, value: string, datatype = 'string'): [string, Term] =>
    [RV + name, literal(value, datatype)];
  const marker = facts.get(`${GRAPHS.control}\n${restoreCutover}`);
  const graphCursor = marker?.get(RV + 'reconciledPriorSequence');
  const mainCursor = marker?.get(RV + 'reconciledPriorMainSequence');
  if (paired && Boolean(graphCursor) !== Boolean(mainCursor)
    || !paired && mainCursor
    || !graphCursor && effective.graphSequence !== saved.graphSequence
    || paired && !mainCursor && effective.main!.sequence !== saved.main!.sequence) return null;
  const markerFacts: [string, Term][] = [[type, uri(RV + 'RestoreCutover')],
    field('dataEpoch', lineage.dataEpoch), field('priorDataEpoch', saved.dataEpoch),
    field('priorSequence', saved.graphSequence, 'integer')];
  if (paired) markerFacts.push(field('priorMainSequence', saved.main!.sequence, 'integer'));
  if (graphCursor) markerFacts.push(field('reconciledPriorSequence', effective.graphSequence, 'integer'));
  if (mainCursor) markerFacts.push(field('reconciledPriorMainSequence', effective.main!.sequence, 'integer'));
  const receiptFacts: [string, Term][] = [[type, uri(RV + 'OperationReceipt')],
    field('requestDigest', requestDigest), [RV + 'datasetId', uri(DATASET)],
    field('dataEpoch', lineage.dataEpoch), field('sequence', '0', 'integer')];
  if (paired) receiptFacts.push(field('priorMainSequence', effective.main!.sequence, 'integer'),
    field('streamScope', MAIN_RELAY_STREAM_SCOPE));
  if (facts.size !== (paired ? 4 : 3)
    || !exact(GRAPHS.control, DATASET, [field('dataEpoch', lineage.dataEpoch),
      field('routingEpoch', lineage.routingEpoch), field('sequence', '0', 'integer'),
      [RV + 'restoreCutover', uri(restoreCutover)]])
    || paired && !exact(GRAPHS.control, MAIN_RELAY_STREAM_SCOPE, [field('dataEpoch', lineage.dataEpoch),
      field('streamSequence', '0', 'integer'), field('legacyThroughSequence', '0', 'integer')])
    || !exact(GRAPHS.control, restoreCutover, markerFacts)
    || !exact(GRAPHS.receipts, id, receiptFacts)) return null;
  return { expectation: expected, receipt: { id, requestDigest, dataEpoch: lineage.dataEpoch, sequence: '0' } };
}


/**
 * The exact saved and effective native cuts of one restore marker, read from
 * the held or released control graph and checked against the signed capture.
 * It supplies an expectation only; the release proof reader rereads the
 * native evidence and never accepts this value as a capability.
 */
export async function readRestoredGraphReleaseExpectation(
  fuseki: FusekiClient, lineage: GraphLineage, coverage: RecoveryCoverage,
): Promise<RestoredGraphReleaseExpectation> {
  const marker = `urn:rezics:restore:${lineage.dataEpoch}`;
  const cuts = (await fuseki.query(`PREFIX rv: <${RV}>
    SELECT ?savedMainSequence ?reconciledMainSequence ?savedSequence ?reconciledSequence WHERE {
      GRAPH ${iri(GRAPHS.control)} {
        ${iri(DATASET)} rv:dataEpoch ${lit(lineage.dataEpoch)} ; rv:routingEpoch ${lit(lineage.routingEpoch)} ;
          rv:sequence 0 ; rv:restoreCutover ${iri(marker)} .
        ${iri(marker)} rv:priorDataEpoch ${lit(coverage.priorDataEpoch)} ; rv:priorSequence ?savedSequence .
        OPTIONAL { ${iri(marker)} rv:reconciledPriorSequence ?reconciledSequence }
        OPTIONAL { ${iri(marker)} rv:priorMainSequence ?savedMainSequence }
        OPTIONAL { ${iri(marker)} rv:reconciledPriorMainSequence ?reconciledMainSequence }
      } } LIMIT 2`)).results?.bindings ?? [];
  const cut = cuts[0];
  const canonical = /^(0|[1-9][0-9]*)$/;
  if (cuts.length !== 1 || !cut
    || ['savedMainSequence', 'reconciledMainSequence', 'savedSequence', 'reconciledSequence']
      .some(key => cut[key] && !canonical.test(cut[key]!.value))
    || cut.reconciledMainSequence && !cut.savedMainSequence
    || !cut.savedSequence) {
    throw new RestoreLineageConflict('restored graph Main cut is unavailable or ambiguous');
  }
  const position = (sequence: string): RelayHandoffPosition => ({
    streamScope: MAIN_RELAY_STREAM_SCOPE, dataEpoch: coverage.priorDataEpoch, sequence });
  const paired = cut.savedMainSequence !== undefined;
  return { lineage: { dataEpoch: lineage.dataEpoch, routingEpoch: lineage.routingEpoch },
    restoreCutover: marker,
    saved: { dataEpoch: coverage.priorDataEpoch, graphSequence: cut.savedSequence.value,
      ...(paired ? { main: position(cut.savedMainSequence!.value) } : {}) },
    effective: { dataEpoch: coverage.priorDataEpoch,
      graphSequence: cut.reconciledSequence?.value ?? cut.savedSequence.value,
      ...(paired ? { main: position(cut.reconciledMainSequence?.value ?? cut.savedMainSequence!.value) } : {}) } };
}

export interface RecoveryCoverage {
  priorDataEpoch: string;
  priorSequence: string;
  accountPg: PgRecoveryFrontier;
  account: AccountRecoveryCoverage;
  accessOutboxCount: string;
  accessOutboxDigest: string;
  accessStateCount: string;
  accessStateDigest: string;
  relay: RelayCoverage;
  content?: ContentRecoveryCoverage;
  commerce: CommerceRecoveryCoverage;
  objects?: ObjectRecoveryCoverage;
}

export interface DeletionReleaseEvidence {
  accountPool: Pool;
  hmacKey: string;
  sealedSets: readonly string[];
}

export interface AuthenticatedRecoveryCoverage {
  sealedCoverage: string;
  hmacKey: string;
  accountPool: Pool;
  deletions?: DeletionReleaseEvidence;
  contentPool?: Pool;
  objectStore?: ObjectRecoveryStore;
  /** Borrowed Content snapshot used by exact recovery pin verification. */
  contentClient?: PoolClient;
  /** Captured handoff in the isolated copy, distinct from the retained journal. */
  restoredRelayPool?: Pool;
  /**
   * Reconcile retained erasures after verifying the captured cut, then release
   * graph and Access under the same journal lock and borrowed owner clients.
   * The callback owns neither transaction nor client lifecycle.
   */
  releaseErasures?: (clients: RestoredReleaseClients,
    releaseGraph: () => Promise<void>) => Promise<void>;
  /**
   * Durable qualification: the callback commits its retained-journal record
   * while both holds are closed (`commitQualification`), then releases in fresh
   * transactions. `resume` continues a record committed by an earlier pass; the
   * Content, object and graph-reference base comparison that replay has since
   * changed is then not repeated.
   */
  qualification?: { resume: boolean };
}

export interface RestoredReleaseClients {
  accessClient: PoolClient;
  relayClient: PoolClient;
  fenceGeneration: string;
  /** Saved and effective native cuts of this restore, read from its marker. */
  graphRelease: RestoredGraphReleaseExpectation;
  /**
   * Commit the relay transaction, then the Access one, and open fresh ones that
   * retake the allocator and the closed fence at the captured generation.
   * Only with `qualification`; the caller's own transactions are never committed.
   */
  commitQualification: () => Promise<void>;
}

/** A genuine owner interruption after the native release was authenticated:
 * the operation is not definitively held and may be resumed with the same key. */
export class RestoreInterrupted extends Error {}

export { accessOutboxCoverage, accessStateCoverage } from './access-recovery-coverage.ts';

export interface GraphRecoverySource extends GraphLineage {
  sequence: string;
  relay: RelayHandoffPosition;
}

/** The diagnostic graph cut and Main's delivery cut share one source snapshot. */
export async function readGraphRecoverySource(fuseki: FusekiClient): Promise<GraphRecoverySource> {
  const result = await fuseki.query(`PREFIX rv: <${RV}>
    SELECT ?epoch ?routing ?sequence ?streamEpoch ?streamSequence WHERE { GRAPH ${iri(GRAPHS.control)} {
      ${iri(DATASET)} rv:dataEpoch ?epoch ; rv:routingEpoch ?routing ; rv:sequence ?sequence .
      ${iri(MAIN_RELAY_STREAM_SCOPE)} rv:dataEpoch ?streamEpoch ; rv:streamSequence ?streamSequence .
    } } LIMIT 2`);
  const rows = result.results?.bindings ?? [];
  const row = rows[0];
  if (rows.length !== 1 || !row?.epoch || !row.routing || !row.sequence || !row.streamEpoch || !row.streamSequence
    || row.streamEpoch.value !== row.epoch.value || !/^[0-9]+$/.test(row.sequence.value)
    || !/^[0-9]+$/.test(row.streamSequence.value)) {
    throw new RestoreLineageConflict('graph recovery source control is unavailable or ambiguous');
  }
  return { dataEpoch: row.epoch.value, routingEpoch: row.routing.value, sequence: row.sequence.value,
    relay: { streamScope: MAIN_RELAY_STREAM_SCOPE, dataEpoch: row.streamEpoch.value, sequence: row.streamSequence.value } };
}

function validRecoveryRelayCut(relay: RelayCoverage, epoch: string): boolean {
  return relay?.streamScope === MAIN_RELAY_STREAM_SCOPE && relay.dataEpoch === epoch
    && /^[0-9]+$/.test(relay.sequence) && relay.batchCount === relay.sequence
    && /^[0-9a-f]{64}$/.test(relay.batchDigest) && /^[0-9]+$/.test(relay.eventCount)
    && /^[0-9a-f]{64}$/.test(relay.eventDigest);
}

/** All allocated Main positions must have reached the acknowledged relay cut. */
export function assertGraphRecoveryRelayCut(source: GraphRecoverySource, relay: RelayCoverage): void {
  if (!validRecoveryRelayCut(relay, source.dataEpoch) || source.relay.streamScope !== MAIN_RELAY_STREAM_SCOPE
    || source.relay.dataEpoch !== source.dataEpoch || source.relay.sequence !== relay.sequence) {
    throw new RestoreLineageConflict('source graph or relay moved during recovery capture');
  }
}

/** Capture only after Account, graph and relay writers are externally quiesced. */
export async function captureGraphRecoveryCoverage(
  fuseki: FusekiClient, accountPool: Pool, accessPool: Pool,
  relayPool: Pool, consumer: string, contentPool: Pool,
  objectStore?: ObjectRecoveryStore, contentProof?: ContentRecoveryProofContext,
): Promise<RecoveryCoverage> {
  if (!contentPool) throw new RestoreLineageConflict('Content owner is required for recovery coverage');
  if (objectStore?.structureObjects) objectStore = { ...objectStore,
    structureGroupRoots: new StructureGroupRootStore(contentPool, objectStore.structureObjects),
    structureQualifierRoots: new StructureQualifierRootStore(contentPool, objectStore.structureObjects) };
  const fence = await accessPool.query<{ open: boolean }>(
    'SELECT open FROM access.recovery_fence WHERE id = true');
  if (fence.rows[0]?.open !== false) {
    throw new RestoreLineageConflict('Access recovery fence must be held for capture');
  }
  const before = await readGraphRecoverySource(fuseki);
  await assertGraphAdmissionOpen(fuseki, {
    dataEpoch: before.dataEpoch, routingEpoch: before.routingEpoch,
  });
  const graphReferences = await graphContentReferences(fuseki);
  const content = await captureContentRecoveryCoverage(contentPool, graphReferences, contentProof ? { ...contentProof, fuseki } : undefined);
  const commerce = await captureCommerceRecoveryCoverage(accessPool);
  const objects = objectStore ? await captureObjectRecoveryCoverage(fuseki, objectStore) : undefined;
  const outbox = await accessOutboxCoverage(accessPool);
  const state = await accessStateCoverage(accessPool);
  const accountPg = await capturePgRecoveryFrontier(accountPool);
  const account = await accountRecoveryCoverage(accountPool);
  const relay = contentProof ? await relayCoverageOnClient(contentProof.relayClient, consumer)
    : await relayCoverage(relayPool, consumer);
  await assertAccountSubjectDeletionsAbsent(accountPool, relayPool, contentProof?.relayClient);
  await assertAccountDeletionJournalCoverage(accessPool, relayPool, undefined, contentProof?.relayClient);
  const after = await readGraphRecoverySource(fuseki);
  assertGraphRecoveryRelayCut(before, relay);
  if (before.dataEpoch !== after.dataEpoch || before.routingEpoch !== after.routingEpoch
    || before.sequence !== after.sequence || before.relay.sequence !== after.relay.sequence) {
    throw new RestoreLineageConflict('source graph or relay moved during recovery capture');
  }
  // A second checkout of a pool that this capture already holds deadlocks a
  // one-connection pool, so each pool's reads run one after another.
  const [[outboxAfter, stateAfter], [accountPgAfter, accountAfter], relayAfter] = await Promise.all([
    (async () => [await accessOutboxCoverage(accessPool), await accessStateCoverage(accessPool)] as const)(),
    (async () => [await capturePgRecoveryFrontier(accountPool), await accountRecoveryCoverage(accountPool)] as const)(),
    contentProof ? relayCoverageOnClient(contentProof.relayClient, consumer) : relayCoverage(relayPool, consumer),
  ]);
  const final = await readGraphRecoverySource(fuseki);
  const graphReferencesAfter = await graphContentReferences(fuseki);
  const contentAfter = await captureContentRecoveryCoverage(contentPool, graphReferencesAfter, contentProof ? { ...contentProof, fuseki } : undefined);
  const commerceAfter = await captureCommerceRecoveryCoverage(accessPool);
  const objectsAfter = objectStore ? await captureObjectRecoveryCoverage(fuseki, objectStore) : undefined;
  // The cluster can emit checkpoint/hint-bit WAL while every owner row stays
  // fixed. Keep the latest replay floor after both full comparisons, rather
  // than recapturing every immutable object for background WAL alone.
  // https://www.postgresql.org/docs/18/runtime-config-wal.html#GUC-WAL-LOG-HINTS
  const retainedPg = advancePgRecoveryFrontier(
    advancePgRecoveryFrontier(accountPg, accountPgAfter), await capturePgRecoveryFrontier(accountPool));
  const fenceAfter = await accessPool.query<{ open: boolean }>(
    'SELECT open FROM access.recovery_fence WHERE id = true');
  const moved = [
    fenceAfter.rows[0]?.open !== false ? 'Access fence' : null,
    before.dataEpoch !== final.dataEpoch || before.routingEpoch !== final.routingEpoch
      || before.sequence !== final.sequence || before.relay.sequence !== final.relay.sequence ? 'graph control' : null,
    outbox.count !== outboxAfter.count || outbox.digest !== outboxAfter.digest
      ? 'Access outbox' : null,
    state.count !== stateAfter.count || state.digest !== stateAfter.digest
      ? 'Access state' : null,
    account.rowCount !== accountAfter.rowCount || account.rowDigest !== accountAfter.rowDigest
      ? 'Account rows' : null,
    JSON.stringify(relay) !== JSON.stringify(relayAfter) ? 'relay' : null,
    JSON.stringify(graphReferences) !== JSON.stringify(graphReferencesAfter)
      ? 'graph Content references' : null,
    JSON.stringify(content) !== JSON.stringify(contentAfter) ? 'Content owner' : null,
    JSON.stringify(commerce) !== JSON.stringify(commerceAfter) ? 'Commerce owner' : null,
    JSON.stringify(objects) !== JSON.stringify(objectsAfter) ? 'immutable objects' : null,
  ].filter((part): part is string => part !== null);
  if (moved.length) {
    throw new RestoreLineageConflict(`owner or graph moved during recovery capture: ${moved.join(', ')}`);
  }
  return { priorDataEpoch: before.dataEpoch, priorSequence: before.sequence,
    accountPg: retainedPg, account,
    accessOutboxCount: outbox.count, accessOutboxDigest: outbox.digest,
    accessStateCount: state.count, accessStateDigest: state.digest, relay,
    content, commerce, ...(objects ? { objects } : {}) };
}

/**
 * Every retained Account deletion intent needs a current two-owner proof.
 * A passed client stays in the caller's transaction: this does not begin,
 * commit, roll back or release it.
 */
export async function assertGraphDeletionEvidence(
  accessPool: Pool, evidence?: DeletionReleaseEvidence, client?: PoolClient,
): Promise<void> {
  const owned = !client;
  const held = client ?? await accessPool.connect();
  try {
    if (owned) await held.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    const fence = await held.query<{ open: boolean }>(
      'SELECT open FROM access.recovery_fence WHERE id = true FOR SHARE');
    if (fence.rows[0]?.open !== false) {
      throw new RestoreLineageConflict('Access recovery fence is not held');
    }
    const result = await held.query<{ principal_id: string; authority_epoch: string }>(
      `SELECT principal_id, authority_epoch FROM access.outbox
       WHERE kind = 'account.deletion_fenced' ORDER BY principal_id`);
    const markers = result.rows;
    if (markers.length !== (evidence?.sealedSets.length ?? 0)) {
      throw new RestoreLineageConflict('Account deletion recovery evidence is incomplete');
    }
    if (markers.length > 0) {
      if (!evidence?.accountPool || !evidence.hmacKey) {
        throw new RestoreLineageConflict('Account deletion recovery evidence is unavailable');
      }
      const byPrincipal = new Map(markers.map(row => [row.principal_id, row.authority_epoch]));
      for (const sealed of evidence.sealedSets) {
        let set: DeletionRecoverySet;
        try { set = openRecoveryPayload<DeletionRecoverySet>(
          sealed, evidence.hmacKey, 'deletion-recovery-set'); }
        catch { throw new RestoreLineageConflict('Account deletion recovery envelope is invalid'); }
        const epoch = byPrincipal.get(set.deletion?.accessPrincipalId);
        if (!epoch || epoch !== set.deletion.enforcementEpoch) {
          throw new RestoreLineageConflict('Account deletion intent differs from retained evidence');
        }
        byPrincipal.delete(set.deletion.accessPrincipalId);
        try { await assertDeletionRecoverySet(evidence.accountPool, accessPool, set, held); }
        catch { throw new RestoreLineageConflict('deleted Account/Access state differs from retained evidence'); }
      }
      if (byPrincipal.size !== 0) {
        throw new RestoreLineageConflict('Account deletion recovery evidence is incomplete');
      }
    }
    if (owned) await held.query('COMMIT');
  } catch (error) {
    if (owned) { try { await held.query('ROLLBACK'); } catch { /* retain original error */ } }
    throw error;
  } finally {
    if (owned) held.release();
  }
}

export async function assertGraphAdmissionOpen(fuseki: FusekiClient, lineage: GraphLineage): Promise<void> {
  if (knownSearchPosition(fuseki, lineage)) return;
  const result = await fuseki.query(`PREFIX rv: <${RV}> ASK { GRAPH ${iri(GRAPHS.control)} {
    ${iri(DATASET)} rv:dataEpoch ${lit(lineage.dataEpoch)} ; rv:routingEpoch ${lit(lineage.routingEpoch)} .
    FILTER NOT EXISTS { ${iri(DATASET)} rv:restoreHold true }
  } }`);
  if (result.boolean !== true) throw new RecoveryHold('graph admission is held or lineage differs');
}

async function control(fuseki: FusekiClient): Promise<{ dataEpoch: string; routingEpoch: string; sequence: string }> {
  const result = await fuseki.query(`PREFIX rv: <${RV}>
    SELECT ?epoch ?routing ?sequence WHERE { GRAPH ${iri(GRAPHS.control)} {
      ${iri(DATASET)} rv:dataEpoch ?epoch ; rv:routingEpoch ?routing ; rv:sequence ?sequence .
    } }`);
  const rows = result.results?.bindings ?? [];
  if (rows.length !== 1 || !rows[0]?.epoch || !rows[0]?.routing || !rows[0]?.sequence) {
    throw new RestoreLineageConflict('product control record is unavailable or ambiguous');
  }
  return { dataEpoch: rows[0].epoch.value, routingEpoch: rows[0].routing.value,
    sequence: rows[0].sequence.value };
}

/** Run only on a fenced, isolated restored dataset before product admission. */
export async function cutoverRestoredGraphLineage(
  fuseki: FusekiClient, cutover: RestoreLineageCutover,
): Promise<{ lineage: GraphLineage; sequence: '0' | string; replayed: boolean }> {
  const { prior, next } = cutover;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const numericRouting = /^(0|[1-9][0-9]*)$/.test(prior.routingEpoch)
    && /^(0|[1-9][0-9]*)$/.test(next.routingEpoch)
    && BigInt(next.routingEpoch) > BigInt(prior.routingEpoch);
  const uuidRouting = uuid.test(prior.routingEpoch) && uuid.test(next.routingEpoch)
    && prior.routingEpoch !== next.routingEpoch;
  if (!uuid.test(prior.dataEpoch) || !uuid.test(next.dataEpoch)
    || prior.dataEpoch === next.dataEpoch || !/^[0-9]+$/.test(prior.sequence)
    || (!numericRouting && !uuidRouting)) {
    throw new RestoreLineageConflict('invalid restore lineage transition');
  }
  const before = await control(fuseki);
  if (before.dataEpoch === next.dataEpoch && before.routingEpoch === next.routingEpoch) {
    return { lineage: next, sequence: before.sequence, replayed: true };
  }
  if (before.dataEpoch !== prior.dataEpoch || before.routingEpoch !== prior.routingEpoch
    || before.sequence !== prior.sequence) {
    throw new RestoreLineageConflict('restored graph cut differs from recorded position');
  }
  // Read both cuts together before the command resets the scoped Main counter.
  // Existing cutover receipts return above without changing their original identity.
  const source = await readGraphRecoverySource(fuseki);
  if (source.dataEpoch !== prior.dataEpoch || source.routingEpoch !== prior.routingEpoch
    || source.sequence !== prior.sequence) {
    throw new RestoreLineageConflict('restored graph cut moved before lineage cutover');
  }
  const marker = `urn:rezics:restore:${next.dataEpoch}`;
  const receipt = `urn:rezics:receipt:restore-cutover:${hash(next.dataEpoch)}`;
  const digest = hash(JSON.stringify({ family: 'restore-cutover-v1', prior, next }));
  let updateError: unknown;
  let updateStatus: string | undefined;
  let updateReport: unknown;
  try { const result = await fuseki.commandWithReceipt({ receipt, digest, validations: [], deadlineMs: 10_000,
    update: `PREFIX rv: <${RV}>
    DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(prior.dataEpoch)} ;
      rv:routingEpoch ${lit(prior.routingEpoch)} ; rv:sequence ?oldSequence ;
      rv:restoreCutover ?priorMarker . } }
    INSERT { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(next.dataEpoch)} ;
      rv:routingEpoch ${lit(next.routingEpoch)} ; rv:sequence 0 ;
      rv:restoreCutover ${iri(marker)} ; rv:restoreHold true .
      ${iri(marker)} a rv:RestoreCutover ; rv:priorDataEpoch ${lit(prior.dataEpoch)} ;
        rv:priorSequence ?oldSequence ; rv:priorMainSequence ?oldMainSequence ;
        rv:dataEpoch ${lit(next.dataEpoch)} . }
    GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ;
      rv:requestDigest ${lit(digest)} ; rv:datasetId ${iri(DATASET)} ;
      rv:dataEpoch ${lit(next.dataEpoch)} ; rv:sequence 0 . } }
    WHERE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(prior.dataEpoch)} ;
      rv:routingEpoch ${lit(prior.routingEpoch)} ; rv:sequence ?oldSequence .
      ${iri(MAIN_RELAY_STREAM_SCOPE)} rv:dataEpoch ${lit(prior.dataEpoch)} ; rv:streamSequence ?oldMainSequence . }
      FILTER(?oldSequence = ${prior.sequence} && ?oldMainSequence = ${source.relay.sequence})
      OPTIONAL { GRAPH ${iri(GRAPHS.control)} {
        ${iri(DATASET)} rv:restoreCutover ?priorMarker . } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(marker)} ?p ?o } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
    }` });
    updateStatus = result.status;
    if (result.status === 'invalid') updateReport = result.report;
  }
  catch (error) { updateError = error; }
  const after = await control(fuseki);
  if (after.dataEpoch !== next.dataEpoch || after.routingEpoch !== next.routingEpoch
    || after.sequence !== '0') {
    throw new RestoreLineageConflict(updateError
      ? 'restore lineage update outcome is unknown'
      : `restored graph lineage was not activated (${updateStatus ?? 'no status'}: ${JSON.stringify(updateReport)})`);
  }
  return { lineage: next, sequence: '0', replayed: false };
}

/** Signed coverage retains independent diagnostic and scoped relay cuts. */
export function assertRecoveryCoverage(coverage: RecoveryCoverage): void {
  if (!coverage || !/^[0-9]+$/.test(coverage.priorSequence)
    || !/^[0-9]+$/.test(coverage.accountPg?.systemIdentifier ?? '')
    || !/^[0-9A-F]+\/[0-9A-F]+$/i.test(coverage.accountPg?.flushedLsn ?? '')
    || !/^[0-9A-F]{24}$/i.test(coverage.accountPg?.walFile ?? '')
    || !/^[0-9]+$/.test(coverage.account?.rowCount ?? '')
    || !/^[0-9a-f]{64}$/.test(coverage.account?.rowDigest ?? '')
    || !/^[0-9]+$/.test(coverage.accessOutboxCount)
    || !/^[0-9a-f]{64}$/.test(coverage.accessOutboxDigest)
    || !/^[0-9]+$/.test(coverage.accessStateCount)
    || !/^[0-9a-f]{64}$/.test(coverage.accessStateDigest)
    || !coverage.commerce || coverage.commerce.version !== 1
    || !validRecoveryRelayCut(coverage.relay, coverage.priorDataEpoch)) {
    throw new RestoreLineageConflict('invalid recovery coverage');
  }
}

export function assertRetainedRecoveryRelayCut(coverage: RecoveryCoverage, retained: RelayCoverage): void {
  if (!validRecoveryRelayCut(retained, coverage.priorDataEpoch)
    || retained.streamScope !== coverage.relay.streamScope || retained.consumer !== coverage.relay.consumer
    || retained.sequence !== coverage.relay.sequence || retained.batchCount !== coverage.relay.batchCount
    || retained.batchDigest !== coverage.relay.batchDigest || retained.eventCount !== coverage.relay.eventCount
    || retained.eventDigest !== coverage.relay.eventDigest) {
    throw new RestoreLineageConflict('relay handoff differs from recovery coverage');
  }
}

/** Release only after an independently retained authority/receipt frontier is compared.
 * Supplying both Access and relay clients preserves the caller's transactions.
 * The legacy relay-only argument retains its original transaction lifecycle.
 */
export async function releaseRestoredGraphHold(
  fuseki: FusekiClient, accessPool: Pool, relayPool: Pool,
  lineage: GraphLineage, evidence: AuthenticatedRecoveryCoverage,
  relayClient?: PoolClient, borrowedAccessClient?: PoolClient,
): Promise<void> {
  if (borrowedAccessClient && !relayClient) {
    throw new RestoreLineageConflict('borrowed restore requires both Access and relay clients');
  }
  let coverage: RecoveryCoverage;
  try { coverage = openRecoveryPayload<RecoveryCoverage>(
    evidence?.sealedCoverage, evidence?.hmacKey, 'graph-recovery-coverage'); }
  catch { throw new RestoreLineageConflict('recovery coverage envelope is invalid'); }
  assertRecoveryCoverage(coverage);
  if (!evidence.releaseErasures) {
    throw new RestoreLineageConflict('retained erasure restore release is unavailable');
  }
  if (!evidence.restoredRelayPool || evidence.restoredRelayPool === relayPool) {
    throw new RestoreLineageConflict('separate restored relay handoff is unavailable');
  }
  let capturedRelay: RelayCoverage;
  let capturedClient: PoolClient | undefined;
  try {
    // This snapshot belongs to the captured copy. The pure scan never begins
    // or commits either caller-owned retained-journal or Access transaction.
    capturedClient = await evidence.restoredRelayPool.connect();
    await capturedClient.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    capturedRelay = await relayCoverageOnClient(capturedClient, coverage.relay.consumer);
    await capturedClient.query('COMMIT');
  } catch (error) {
    if (capturedClient) {
      try { await capturedClient.query('ROLLBACK'); } catch { /* retain original error */ }
    }
    throw new RestoreLineageConflict('captured relay handoff is unavailable', { cause: error });
  } finally { capturedClient?.release(); }
  assertRetainedRecoveryRelayCut(coverage, capturedRelay);
  let accessClient: PoolClient | undefined;
  let relayHeadClient: PoolClient | undefined;
  const borrowedRelay = relayClient !== undefined;
  const borrowedOwners = borrowedAccessClient !== undefined;
  let accessTransaction: string | undefined;
  let relayTransaction: string | undefined;
  const borrowedTransaction = async (owner: 'Access' | 'relay', client: PoolClient,
    isolation: 'repeatable read' | 'read committed', expected?: string): Promise<string> => {
    try {
      const actualIsolation = (await client.query('SHOW transaction_isolation')).rows[0]?.transaction_isolation;
      if (actualIsolation !== isolation) {
        throw new RestoreLineageConflict(`borrowed ${owner} restore requires an active ${isolation} transaction`);
      }
      // Consecutive IDs are stable only inside the caller's explicit transaction;
      // an idle autocommit client obtains different IDs before any lock/effect.
      const first = (await client.query<{ id: string }>('SELECT txid_current()::text AS id')).rows[0]?.id;
      const second = (await client.query<{ id: string }>('SELECT txid_current()::text AS id')).rows[0]?.id;
      if (typeof first !== 'string' || !/^[0-9]+$/.test(first) || first !== second) {
        throw new RestoreLineageConflict(`borrowed ${owner} restore requires an active ${isolation} transaction`);
      }
      if (expected !== undefined && first !== expected) {
        throw new RestoreLineageConflict(`borrowed ${owner} restore transaction changed`);
      }
      return first;
    } catch (error) {
      if (error instanceof RestoreLineageConflict) throw error;
      throw new RestoreLineageConflict(`borrowed ${owner} restore transaction is unavailable`, { cause: error });
    }
  };
  const assertBorrowedTransactions = async () => {
    if (!borrowedOwners) return;
    await borrowedTransaction('relay', relayHeadClient!, 'read committed', relayTransaction);
    await borrowedTransaction('Access', accessClient!, 'repeatable read', accessTransaction);
  };
  try {
    relayHeadClient = relayClient ?? await relayPool.connect();
    if (borrowedOwners) {
      relayTransaction = await borrowedTransaction('relay', relayHeadClient, 'read committed');
      accessTransaction = await borrowedTransaction('Access', borrowedAccessClient!, 'repeatable read');
    } else {
      await relayHeadClient.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      await relayHeadClient.query("SET LOCAL lock_timeout = '5s'");
    }
    // Every release takes the journal allocator before the Access fence. Keep
    // that order across owners and retain both locks through both releases.
    await relayHeadClient.query("SELECT pg_advisory_xact_lock(hashtextextended('rezics-relay-erasure-epoch', 0))");
    const client = borrowedAccessClient ?? await accessPool.connect();
    accessClient = client;
    if (!borrowedOwners) {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      await client.query("SET LOCAL TIME ZONE 'UTC'");
    }
    const fence = await client.query<{ open: boolean; generation: string }>(
      'SELECT open, generation::text AS generation FROM access.recovery_fence WHERE id = true FOR UPDATE');
    await assertBorrowedTransactions();
    const fenceGeneration = fence.rows[0]?.generation;
    if (fence.rows[0]?.open !== false || typeof fenceGeneration !== 'string'
      || !/^[0-9]+$/.test(fenceGeneration)) {
      throw new RestoreLineageConflict('Access recovery fence is not held');
    }
    const outbox = await scanAccessOutbox(client);
    if (outbox.count !== coverage.accessOutboxCount || outbox.digest !== coverage.accessOutboxDigest) {
      throw new RestoreLineageConflict('Access outbox differs from recovery coverage');
    }
    const state = await scanAccessState(client);
    if (state.count !== coverage.accessStateCount || state.digest !== coverage.accessStateDigest) {
      throw new RestoreLineageConflict('Access state differs from recovery coverage');
    }
    try { await assertCommerceRecoveryCoverageOnClient(client, coverage.commerce); }
    catch { throw new RestoreLineageConflict('Commerce owner differs from recovery coverage'); }
    try { await assertPgRecoveryFrontier(evidence.accountPool, coverage.accountPg); }
    catch { throw new RestoreLineageConflict('Account WAL differs from recovery coverage'); }
    try { await assertAccountRecoveryCoverage(evidence.accountPool, coverage.account); }
    catch { throw new RestoreLineageConflict('Account rows differ from recovery coverage'); }
    try { await assertAccountSubjectDeletionsAbsent(evidence.accountPool, relayPool, relayHeadClient); }
    catch { throw new RestoreLineageConflict('retained Account deletion subject exists in restored Account'); }
    await assertAccountDeletionJournalCoverage(accessPool, relayPool, client, relayHeadClient);
    await assertGraphDeletionEvidence(accessPool, evidence.deletions, client);
    try { await assertCurrentRecoveryCoverageHead(relayHeadClient, coverage); }
    catch { throw new RestoreLineageConflict('signed recovery coverage is not the retained current capture'); }
    if (!coverage.content) throw new RestoreLineageConflict('Content recovery coverage is missing');
    if (!evidence.contentPool) throw new RestoreLineageConflict('restored Content owner is unavailable');
    if (!coverage.objects) throw new RestoreLineageConflict('immutable object recovery coverage is missing');
    if (!evidence.objectStore) throw new RestoreLineageConflict('restored immutable object owner is unavailable');
    // Replay has changed the restored Content and object copies since the
    // qualification committed; their durable record, not the signed base, binds them.
    if (!evidence.qualification?.resume) {
      try { await assertContentRecoveryCoverage(evidence.contentPool, fuseki, coverage.content,
        { fuseki, relayClient: relayHeadClient, contentClient: evidence.contentClient }); }
      catch { throw new RestoreLineageConflict('Content owner or graph references differ from recovery coverage'); }
      const restoredObjects = evidence.objectStore.structureObjects
        ? { ...evidence.objectStore, structureGroupRoots: new StructureGroupRootStore(
          evidence.contentPool, evidence.objectStore.structureObjects),
          structureQualifierRoots: new StructureQualifierRootStore(
            evidence.contentPool, evidence.objectStore.structureObjects) } : evidence.objectStore;
      try { await assertObjectRecoveryCoverage(fuseki, restoredObjects, coverage.objects); }
      catch (error) { throw new RestoreLineageConflict(
        `graph or immutable objects differ from recovery coverage (${error instanceof ObjectRecoveryConflict
          ? error.kind : 'unavailable'})`); }
    }
    const marker = `urn:rezics:restore:${lineage.dataEpoch}`;
    const receipt = `urn:rezics:receipt:restore-release:${hash(lineage.dataEpoch)}`;
    const graphRelease = await readRestoredGraphReleaseExpectation(fuseki, lineage, coverage);
    const cut = { savedMainSequence: graphRelease.saved.main?.sequence };
    const pairedMain = cut.savedMainSequence !== undefined;
    const mainCutGuard = pairedMain
      ? `${iri(marker)} rv:priorMainSequence ?savedMainSequence .
         OPTIONAL { ${iri(marker)} rv:reconciledPriorMainSequence ?reconciledMainSequence }
         FILTER(COALESCE(?reconciledMainSequence, ?savedMainSequence) = ${coverage.relay.sequence})`
      : `FILTER NOT EXISTS { ${iri(marker)} rv:priorMainSequence ?savedMainSequence }
         FILTER NOT EXISTS { ${iri(marker)} rv:reconciledPriorMainSequence ?reconciledMainSequence }`;
    // Exact legacy markers retain their original release digest and receipt.
    // Paired markers additionally bind the signed scoped Main cut.
    const releaseDigest = hash(JSON.stringify(pairedMain
      ? { family: 'restore-release-v2', lineage, priorDataEpoch: coverage.priorDataEpoch,
        priorSequence: coverage.priorSequence, priorMainSequence: coverage.relay.sequence,
        streamScope: MAIN_RELAY_STREAM_SCOPE }
      : { family: 'restore-release-v1', lineage,
        priorDataEpoch: coverage.priorDataEpoch, priorSequence: coverage.priorSequence }));
    const mainReceiptFacts = pairedMain
      ? `; rv:priorMainSequence ${coverage.relay.sequence} ; rv:streamScope ${lit(MAIN_RELAY_STREAM_SCOPE)}` : '';
    const releasedQuery = `PREFIX rv: <${RV}> ASK {
      GRAPH ${iri(GRAPHS.control)} {
        ${iri(DATASET)} rv:dataEpoch ${lit(lineage.dataEpoch)} ; rv:routingEpoch ${lit(lineage.routingEpoch)} ;
          rv:sequence 0 ; rv:restoreCutover ${iri(marker)} .
        ${iri(marker)} rv:priorDataEpoch ${lit(coverage.priorDataEpoch)} ; rv:priorSequence ?savedSequence .
        OPTIONAL { ${iri(marker)} rv:reconciledPriorSequence ?reconciledSequence }
        FILTER(COALESCE(?reconciledSequence, ?savedSequence) = ${coverage.priorSequence})
        ${mainCutGuard}
        FILTER NOT EXISTS { ${iri(DATASET)} rv:restoreHold true }
      }
      GRAPH ${iri(GRAPHS.receipts)} {
        ${iri(receipt)} a rv:OperationReceipt ; rv:requestDigest ${lit(releaseDigest)} ;
          rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(lineage.dataEpoch)} ; rv:sequence 0 ${mainReceiptFacts} .
      }
    }`;
    const held = await fuseki.query(`PREFIX rv: <${RV}> ASK { GRAPH ${iri(GRAPHS.control)} {
      ${iri(DATASET)} rv:dataEpoch ${lit(lineage.dataEpoch)} ; rv:routingEpoch ${lit(lineage.routingEpoch)} ;
        rv:sequence 0 ; rv:restoreCutover ${iri(marker)} ; rv:restoreHold true .
      ${iri(marker)} rv:priorDataEpoch ${lit(coverage.priorDataEpoch)} ;
        rv:priorSequence ?savedSequence .
      OPTIONAL { ${iri(marker)} rv:reconciledPriorSequence ?reconciledSequence }
      FILTER(COALESCE(?reconciledSequence, ?savedSequence) = ${coverage.priorSequence})
        ${mainCutGuard}
    } }`);
    // A replay may alter Content/object copies. Verify the signed base before
    // it starts; an interrupted release additionally requires its exact receipt.
    if (held.boolean !== true && (await fuseki.query(releasedQuery)).boolean !== true) {
      throw new RestoreLineageConflict('restored graph cut is not held for erasure reconciliation');
    }
    // A resumed pass whose native release already committed has nothing to
    // release; the owner callback authenticates that receipt itself.
    let graphReleased = evidence.qualification?.resume === true && held.boolean !== true;
    const releaseGraph = async () => {
      if (graphReleased) throw new RestoreLineageConflict('restored graph release already completed');
      await assertBorrowedTransactions();
      const beforeRelease = (await client.query<{ open: boolean; generation: string }>(
        'SELECT open, generation::text AS generation FROM access.recovery_fence WHERE id = true')).rows[0];
      if (beforeRelease?.open !== false || beforeRelease.generation !== fenceGeneration) {
        throw new RestoreLineageConflict('captured Access fence changed before graph release');
      }
      await assertBorrowedTransactions();
      const delivering = await client.query(`SELECT 1 FROM access.search_read_lease WHERE state = 'delivering'
        UNION ALL SELECT 1 FROM access.download_read_lease WHERE state = 'delivering' LIMIT 1`);
      if (delivering.rowCount !== 0) {
        throw new RestoreLineageConflict('Access delivery is still in progress before graph release');
      }
      let updateError: unknown;
      if (held.boolean === true) {
        try { await fuseki.commandWithReceipt({ receipt, digest: releaseDigest, validations: [], deadlineMs: 10_000,
        update: `PREFIX rv: <${RV}>
        DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
        INSERT { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ;
          rv:requestDigest ${lit(releaseDigest)} ; rv:datasetId ${iri(DATASET)} ;
          rv:dataEpoch ${lit(lineage.dataEpoch)} ; rv:sequence 0 ${mainReceiptFacts} . } }
        WHERE { GRAPH ${iri(GRAPHS.control)} {
          ${iri(DATASET)} rv:dataEpoch ${lit(lineage.dataEpoch)} ; rv:routingEpoch ${lit(lineage.routingEpoch)} ;
            rv:sequence 0 ; rv:restoreCutover ${iri(marker)} ; rv:restoreHold true .
          ${iri(marker)} rv:priorDataEpoch ${lit(coverage.priorDataEpoch)} ;
            rv:priorSequence ?savedSequence .
          OPTIONAL { ${iri(marker)} rv:reconciledPriorSequence ?reconciledSequence }
          FILTER(COALESCE(?reconciledSequence, ?savedSequence) = ${coverage.priorSequence})
        ${mainCutGuard}
        }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
        }` }); }
        catch (error) { updateError = error; }
      }
      // Recovery cannot use a cached ordinary search position as release proof.
      const released = await fuseki.query(releasedQuery);
      if (released.boolean !== true) {
        throw new RestoreLineageConflict(updateError
          ? 'recovery release outcome is unknown' : 'recovery hold was not released');
      }
      graphReleased = true;
    };
    try {
      await assertBorrowedTransactions();
      const commitQualification = async () => {
        if (!evidence.qualification || borrowedOwners) {
          throw new RestoreLineageConflict('durable qualification needs this release to own both transactions');
        }
        await assertBorrowedTransactions();
        // Replay is irreversible, so its record must survive a later failure.
        await relayHeadClient!.query('COMMIT');
        await client.query('COMMIT');
        await relayHeadClient!.query('BEGIN ISOLATION LEVEL READ COMMITTED');
        await relayHeadClient!.query("SET LOCAL lock_timeout = '5s'");
        await relayHeadClient!.query("SELECT pg_advisory_xact_lock(hashtextextended('rezics-relay-erasure-epoch', 0))");
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        await client.query("SET LOCAL TIME ZONE 'UTC'");
        const again = await client.query<{ open: boolean; generation: string }>(
          'SELECT open, generation::text AS generation FROM access.recovery_fence WHERE id = true FOR UPDATE');
        if (again.rows[0]?.open !== false || again.rows[0].generation !== fenceGeneration) {
          throw new RestoreLineageConflict('captured Access fence changed after qualification');
        }
        await borrowedTransaction('relay', relayHeadClient!, 'read committed');
        await borrowedTransaction('Access', client, 'repeatable read');
      };
      await evidence.releaseErasures({ accessClient: client, relayClient: relayHeadClient,
        fenceGeneration, graphRelease, commitQualification }, releaseGraph);
    } catch (error) {
      if (error instanceof RestoreLineageConflict || error instanceof RestoreInterrupted) throw error;
      throw new RestoreLineageConflict(`retained erasure reconciliation failed: ${
        error instanceof Error ? error.message : 'owner replay outcome is unavailable'}`, { cause: error });
    }
    await assertBorrowedTransactions();
    if (!graphReleased) throw new RestoreLineageConflict('retained erasure reconciliation did not release the graph');
    const releasedFence = (await client.query<{ open: boolean; generation: string }>(
      'SELECT open, generation::text AS generation FROM access.recovery_fence WHERE id = true')).rows[0];
    if (releasedFence?.open !== true || releasedFence.generation !== (BigInt(fenceGeneration) + 1n).toString()) {
      throw new RestoreLineageConflict('retained erasure reconciliation did not release the captured Access fence');
    }
    if ((await fuseki.query(releasedQuery)).boolean !== true) {
      throw new RestoreLineageConflict('restored graph release evidence changed before Access commit');
    }
    await assertBorrowedTransactions();
    if (!borrowedOwners) {
      // A durable owner operation records its release binding on the relay, so
      // that commits first: an Access failure then leaves a binding that never
      // matches an open fence, while an opened fence always has its binding.
      if (evidence.qualification) {
        await relayHeadClient.query('COMMIT');
        await client.query('COMMIT');
      } else {
        await client.query('COMMIT');
        await relayHeadClient.query('COMMIT');
      }
    }
  } catch (error) {
    if (relayHeadClient && !borrowedOwners) {
      try { await relayHeadClient.query('ROLLBACK'); } catch { /* retain original error */ }
    }
    if (accessClient && !borrowedOwners) {
      try { await accessClient.query('ROLLBACK'); } catch { /* retain original error */ }
    }
    throw error;
  } finally {
    if (!borrowedRelay) relayHeadClient?.release();
    if (!borrowedOwners) accessClient?.release();
  }
}
