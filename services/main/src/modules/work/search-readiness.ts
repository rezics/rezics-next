import { DATASET, GRAPHS, RV, iri, lit, PUBLIC_SEARCH_ANCHOR,
  TEXT_INDEX_PROFILE, TEXT_INDEX_PROBE, TEXT_INDEX_PROBE_TITLE,
  TEXT_INDEX_PROBE_GRAPH, textIndexProbePattern, type GraphLineage } from './activate.ts';
import { setTimeout as delay } from 'node:timers/promises';
import { PUBLIC_SEARCH_GRAPH } from './select-main.ts';
import { knownSearchPosition } from '../search/snapshot-state.ts';
import { FusekiQueryResponseTooLarge, FusekiReadBudgetExceeded, fusekiReadBudget,
  type FusekiClient, type SearchDeltaProof, type SparqlResult } from '../../infrastructure/fuseki.ts';

// Kept for old fixture guards; this is no longer a population admission limit.
export const MAX_PUBLIC_UNITS = 20_000;
export const MAX_PHRASE_CANDIDATES = 512;
export const PHRASE_HIT_PROBE = MAX_PHRASE_CANDIDATES + 1;
export const MAX_SEARCH_RESPONSE_BYTES = 1_048_576;
const MAX_PROOF_RESPONSE_BYTES = 65_536;

export class SearchIndexUnavailable extends Error {}
export class SearchIndexBudgetExceeded extends Error {}
/** A committed graph position changed between separate read snapshots. */
export class SearchSnapshotMoved extends SearchIndexUnavailable {}
export class SearchRequestTimedOut extends SearchIndexUnavailable {}
/** The JVM started after an unclean stop; only an empty-index rebuild clears it (OPS15). */
export class SearchIndexUncertain extends SearchIndexUnavailable {}

export const MAX_SEARCH_REQUEST_MS = 1_500;
export const MAX_SEARCH_FUSEKI_CALLS = 72;
export const MAX_SEARCH_FUSEKI_BYTES = 8_388_608;
// A proven movement already fences the old snapshot. Keep the retry pause short
// so a subsequent native writer and its delta proof fit the same wall deadline.
const RETRY_DELAYS_MS = [25, 50] as const;

export interface SearchAttemptDiagnostic {
  attempt: number;
  phase: 'read' | 'writer-wait';
  elapsedMs: number;
  error: string;
  message: string;
}

function reportAttempt(diagnostics: SearchAttemptDiagnostic[] | undefined,
  attempt: number, phase: SearchAttemptDiagnostic['phase'], started: number, error: unknown): void {
  if (!diagnostics) return;
  diagnostics.push({ attempt, phase, elapsedMs: Math.round(performance.now() - started),
    error: error instanceof Error ? error.constructor.name : typeof error,
    message: error instanceof Error ? error.message : String(error) });
}

/** Retry only a proven position race; corruption and budget failures retain their typed outcome. */
export async function withStableSearchSnapshot<T>(fuseki: FusekiClient | undefined, read: () => Promise<T>,
  deadlineMs = MAX_SEARCH_REQUEST_MS, diagnostics?: SearchAttemptDiagnostic[]): Promise<T> {
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > MAX_SEARCH_REQUEST_MS) {
    throw new Error('invalid public search deadline');
  }
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new SearchRequestTimedOut('public search request exceeded wall deadline'));
    }, deadlineMs);
  });
  try {
    return await fusekiReadBudget.run({ signal: controller.signal,
      callsLeft: MAX_SEARCH_FUSEKI_CALLS, bytesLeft: MAX_SEARCH_FUSEKI_BYTES }, async () => {
      // A fixed attempt count can reject a coherent read while time and call
      // budgets remain (observed under consecutive native index writes). Every
      // movement pays a delay; the shared wall and Fuseki budgets bound retries.
      for (let attempt = 1; ; attempt++) {
        const readStarted = performance.now();
        try { return await Promise.race([read(), expired]); }
        catch (error) {
          reportAttempt(diagnostics, attempt, 'read', readStarted, error);
          if (controller.signal.aborted) {
            throw new SearchRequestTimedOut('public search request exceeded wall deadline', { cause: error });
          }
          if (!(error instanceof SearchSnapshotMoved)) throw error;
          const waitStarted = performance.now();
          try {
            await delay(RETRY_DELAYS_MS[attempt - 1] ?? 50, undefined, { signal: controller.signal });
            // A long native writer can outlive both fixed waits. Poll only after
            // a proven movement, with the same call and wall budgets as the read.
            while (fuseki && (await serverState(fuseki)).publicSearchWriteActive) {
              await delay(75, undefined, { signal: controller.signal });
            }
          }
          catch (cause) {
            if (controller.signal.aborted) {
              const timeout = new SearchRequestTimedOut('public search request exceeded wall deadline', { cause });
              reportAttempt(diagnostics, attempt, 'writer-wait', waitStarted, timeout);
              throw timeout;
            }
            reportAttempt(diagnostics, attempt, 'writer-wait', waitStarted, cause);
            throw cause;
          }
        }
      }
    });
  } finally { if (timer) clearTimeout(timer); }
}

export interface PublicTextPosition {
  dataEpoch: string;
  sequence: string;
  generation: string;
  population: number;
  serverInstanceId: string;
  publicSearchWriteEpoch: string;
}

const generationIri = /^urn:rezics:text-index-generation:[0-9a-f-]{36}$/;
const instanceIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const decimal = /^(0|[1-9][0-9]*)$/;

async function serverState(fuseki: FusekiClient): Promise<{
  instanceId: string; publicSearchWriteEpoch: string; publicSearchWriteActive: boolean;
  publicSearchDeltaAvailable: boolean }> {
  let health: Awaited<ReturnType<FusekiClient['commandHealth']>>;
  try { health = await fuseki.commandHealth(); }
  catch (error) {
    if (error instanceof FusekiReadBudgetExceeded || error instanceof FusekiQueryResponseTooLarge) throw error;
    throw new SearchIndexUnavailable('Fuseki process identity cannot be verified', { cause: error });
  }
  const instanceId = (health as { instanceId?: unknown }).instanceId;
  if (typeof instanceId !== 'string' || !instanceIdPattern.test(instanceId)) {
    throw new SearchIndexUnavailable('Fuseki process identity is unavailable');
  }
  // Older modules omit the field; the pinned image always reports it.
  if ((health as { textIndexUncertain?: unknown }).textIndexUncertain === true) {
    throw new SearchIndexUncertain('Fuseki text index is uncertain after an unclean stop');
  }
  const epoch = health.publicSearchWriteEpoch;
  if (typeof epoch !== 'string' || !decimal.test(epoch)
    || typeof health.publicSearchWriteActive !== 'boolean'
    || health.publicSearchWriteActive !== (BigInt(epoch) % 2n === 1n)) {
    throw new SearchIndexUnavailable('Fuseki public index mutation state is unavailable');
  }
  return { instanceId, publicSearchWriteEpoch: epoch,
    publicSearchWriteActive: health.publicSearchWriteActive,
    publicSearchDeltaAvailable: health.publicSearchDeltaAvailable === true };
}

export async function assertSameTextInstance(fuseki: FusekiClient,
  position: PublicTextPosition): Promise<void> {
  const state = await serverState(fuseki);
  if (state.instanceId !== position.serverInstanceId) {
    throw new SearchIndexUnavailable('Fuseki restarted during public search');
  }
  if (state.publicSearchWriteActive
    || state.publicSearchWriteEpoch !== position.publicSearchWriteEpoch) {
    throw new SearchSnapshotMoved('public index mutation overlapped search');
  }
}

function count(value: string | undefined): number {
  const number = Number(value);
  if (value === undefined || !decimal.test(value) || !Number.isSafeInteger(number)) {
    throw new SearchIndexUnavailable('public text index population is invalid');
  }
  return number;
}

/** A missing result is transient only when a fresh, anchored control read proves
 * that the graph moved. A missing anchor or unchanged control remains unavailable. */
export async function assertSnapshotMoved(fuseki: FusekiClient,
  position: Pick<PublicTextPosition, 'dataEpoch' | 'sequence' | 'generation'>): Promise<void> {
  const result = await fuseki.query(`PREFIX rv: <${RV}> SELECT ?epoch ?sequence ?generation WHERE {
    GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ?epoch ;
      rv:sequence ?sequence ; rv:textIndexGeneration ?generation .
      FILTER NOT EXISTS { ${iri(DATASET)} rv:restoreHold true } }
    GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} {
      ${iri(PUBLIC_SEARCH_ANCHOR)} a rv:SearchGraphAnchor . }
  }`, MAX_PROOF_RESPONSE_BYTES);
  const rows = result.results?.bindings ?? [];
  const row = rows[0];
  if (rows.length === 1 && row?.epoch?.value === position.dataEpoch
    && decimal.test(row.sequence?.value ?? '')
    && generationIri.test(row.generation?.value ?? '')
    && (row.sequence!.value !== position.sequence || row.generation!.value !== position.generation)) {
    throw new SearchSnapshotMoved('public search graph position changed');
  }
}

/** Relation rows themselves prove movement only when their complete control
 * binding is unambiguous. Empty rows need a fresh anchored control probe. */
export async function assertQuerySnapshotMoved(fuseki: FusekiClient,
  position: Pick<PublicTextPosition, 'dataEpoch' | 'sequence' | 'generation'>,
  rows: NonNullable<SparqlResult['results']>['bindings'], generationKey: string): Promise<void> {
  const first = rows[0];
  if (!first) { await assertSnapshotMoved(fuseki, position); return; }
  const epoch = first.epoch?.value;
  const sequence = first.sequence?.value;
  const generation = first[generationKey]?.value;
  if (epoch === position.dataEpoch && decimal.test(sequence ?? '')
    && generationIri.test(generation ?? '')
    && rows.every(row => row.epoch?.value === epoch && row.sequence?.value === sequence
      && row[generationKey]?.value === generation)
    && (sequence !== position.sequence || generation !== position.generation)) {
    throw new SearchSnapshotMoved('public search relation crossed graph positions');
  }
}

/**
 * Consume native generation qualification; control/probe remains per request.
 * Startup/rebuild owns the full audit and native writes maintain it with bounded
 * deltas. An unavailable proof never falls back to a request-time corpus scan.
 */
export async function assertPublicTextReady(fuseki: FusekiClient,
  lineage: GraphLineage): Promise<PublicTextPosition> {
  const known = knownSearchPosition(fuseki, lineage);
  if (known) return known;
  const state = await serverState(fuseki);
  if (state.publicSearchWriteActive) throw new SearchSnapshotMoved('public index write is in progress');
  let control: SparqlResult;
  try { control = await fuseki.query(`PREFIX rv: <${RV}>
    PREFIX text: <http://jena.apache.org/text#>
    SELECT ?epoch ?sequence ?generation${state.publicSearchDeltaAvailable ? '' : ' ?population'} WHERE {
      GRAPH ${iri(GRAPHS.control)} {
        ${iri(DATASET)} rv:dataEpoch ?epoch ; rv:sequence ?sequence ;
          rv:routingEpoch ${lit(lineage.routingEpoch)} ; rv:textIndexProfile ${iri(TEXT_INDEX_PROFILE)} ;
          rv:textIndexGeneration ?generation .
        FILTER NOT EXISTS { ${iri(DATASET)} rv:restoreHold true }
      }
      FILTER(?epoch = ${lit(lineage.dataEpoch)})
      GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} {
        ${iri(PUBLIC_SEARCH_ANCHOR)} a rv:SearchGraphAnchor .
      }
      ${textIndexProbePattern()}
      ${state.publicSearchDeltaAvailable ? '' : 'BIND(rv:publicTextInventory() AS ?population)'}
    }`, MAX_PROOF_RESPONSE_BYTES); }
  catch (error) {
    if (error instanceof FusekiReadBudgetExceeded || error instanceof FusekiQueryResponseTooLarge) throw error;
    throw new SearchIndexUnavailable('public text control or inventory is unavailable', { cause: error });
  }
  const rows = control.results?.bindings ?? [];
  const row = rows[0];
  if (rows.length !== 1 || row?.epoch?.value !== lineage.dataEpoch
    || !row.sequence || !decimal.test(row.sequence.value)
    || !row.generation || !generationIri.test(row.generation.value)) {
    const after = await serverState(fuseki);
    if (after.instanceId === state.instanceId
      && (after.publicSearchWriteActive
        || after.publicSearchWriteEpoch !== state.publicSearchWriteEpoch)) {
      throw new SearchSnapshotMoved('public index mutation crossed readiness control');
    }
    throw new SearchIndexUnavailable('public text index control proof is unavailable');
  }
  const position: PublicTextPosition = {
    dataEpoch: row.epoch.value, sequence: row.sequence.value,
    generation: row.generation.value, population: 0,
    serverInstanceId: state.instanceId, publicSearchWriteEpoch: state.publicSearchWriteEpoch,
  };
  if (!state.publicSearchDeltaAvailable) {
    // Only disposable fault-injection datasets expose bypass writers. They
    // cannot reuse a journal baseline; audit with a streaming native collector.
    // The native collector and control proof share one graph read snapshot.
    position.population = count(row.population?.value);
    await assertSameTextInstance(fuseki, position);
    return position;
  }
  // The native writer maintains a startup/rebuild-qualified generation. This
  // bounded envelope replaces Main's per-mutation whole-catalogue inventory.
  let proof: SearchDeltaProof;
  try { proof = await fuseki.searchDeltaSince('-1'); }
  catch (error) {
    if (error instanceof FusekiReadBudgetExceeded || error instanceof FusekiQueryResponseTooLarge) throw error;
    throw new SearchIndexUnavailable('qualified public text generation is unavailable', { cause: error });
  }
  if (!validDeltaEnvelope(proof, position) || proof.qualifiedPopulation === undefined) {
    await assertSameTextInstance(fuseki, position);
    await assertSnapshotMoved(fuseki, position);
    throw new SearchIndexUnavailable('public text generation has no native qualification');
  }
  position.population = count(proof.qualifiedPopulation);
  await assertSameTextInstance(fuseki, position);
  return position;
}

/** A title query needs proof of its dedicated field map. An unmapped predicate
 * must never turn a real title match into a complete empty result. */
export async function assertPublicTitleReady(fuseki: FusekiClient,
  lineage: GraphLineage): Promise<PublicTextPosition> {
  const position = await assertPublicTextReady(fuseki, lineage);
  let result: SparqlResult;
  try {
    result = await fuseki.query(`PREFIX rv: <${RV}>
      PREFIX text: <http://jena.apache.org/text#>
      SELECT ?literal ?graph WHERE { GRAPH ${iri(TEXT_INDEX_PROBE_GRAPH)} {
        ${iri(TEXT_INDEX_PROBE)} rv:publicTitle ${lit(TEXT_INDEX_PROBE_TITLE)}@en .
        (${iri(TEXT_INDEX_PROBE)} ?score ?literal ?graph)
          text:query (rv:publicTitle ${lit('"标题检索"')} 2) .
        FILTER(?literal = ${lit(TEXT_INDEX_PROBE_TITLE)}@en
          && ?graph = ${iri(TEXT_INDEX_PROBE_GRAPH)})
      } }`, MAX_PROOF_RESPONSE_BYTES);
  } catch (error) {
    if (error instanceof FusekiReadBudgetExceeded || error instanceof FusekiQueryResponseTooLarge) throw error;
    throw new SearchIndexUnavailable('public title field is not installed', { cause: error });
  }
  const rows = result.results?.bindings ?? [];
  if (rows.length !== 1 || rows[0]?.literal?.value !== TEXT_INDEX_PROBE_TITLE
    || rows[0]?.graph?.value !== TEXT_INDEX_PROBE_GRAPH) {
    throw new SearchIndexUnavailable('public title field has no indexed probe');
  }
  await assertSameTextInstance(fuseki, position);
  return position;
}

function validDeltaEnvelope(proof: SearchDeltaProof, position: PublicTextPosition): boolean {
  return proof.available === true && typeof proof.ordinal === 'string' && decimal.test(proof.ordinal)
    && proof.dataEpoch === position.dataEpoch && proof.sequence === position.sequence
    && proof.generation === position.generation
    && proof.writeEpoch === position.publicSearchWriteEpoch
    && typeof proof.luceneGeneration === 'string' && decimal.test(proof.luceneGeneration)
    && Array.isArray(proof.deltas);
}

export type SearchGenerationState = 'active' | 'uncertain' | 'quarantined' | 'restore-held'
  | 'unqualified' | 'over-budget';

export interface SearchGenerationActivation {
  receipt: string;
  graphSequence: string;
  priorGeneration: string;
  sourceCut: { dataEpoch: string; sequence: string };
  indexDigest: string;
}

export interface CurrentSearchGeneration {
  contractVersion: '1';
  profile: string | null;
  state: SearchGenerationState;
  dataEpoch: string;
  sequence: string;
  generation: string | null;
  /** The receipt that activated this generation; null for the bootstrap generation. */
  activation: SearchGenerationActivation | null;
  population: number | null;
}

/**
 * OPS15/OPS16 operator read: the recorded generation/fence pair and whether the
 * public text gate qualifies it now. Cost: one bounded control read and the
 * existing public readiness proof under the 72-call, 8 MiB, 1.5-second shared
 * search budget. A failed proof is reported as a state, never as a usable
 * generation. Unreadable control is an error.
 */
export async function readCurrentSearchGeneration(fuseki: FusekiClient, lineage: GraphLineage,
  qualify: () => Promise<{ population: number }>): Promise<CurrentSearchGeneration> {
  const result = await fuseki.query(`PREFIX rv: <${RV}>
    SELECT ?epoch ?sequence ?profile ?generation ?held ?anchored ?receipt ?graphSequence
      ?prior ?ownerEpoch ?ownerSequence ?digest WHERE {
      GRAPH ${iri(GRAPHS.control)} {
        ${iri(DATASET)} rv:dataEpoch ?epoch ; rv:sequence ?sequence .
        OPTIONAL { ${iri(DATASET)} rv:textIndexProfile ?profile }
        OPTIONAL { ${iri(DATASET)} rv:textIndexGeneration ?generation }
        BIND(EXISTS { ${iri(DATASET)} rv:restoreHold true } AS ?held)
      }
      BIND(EXISTS { GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} {
        ${iri(PUBLIC_SEARCH_ANCHOR)} a rv:SearchGraphAnchor . } } AS ?anchored)
      OPTIONAL { GRAPH ${iri(GRAPHS.receipts)} {
        ?receipt rv:textIndexGeneration ?activated ; rv:outcome rv:Succeeded ;
          rv:dataEpoch ?receiptEpoch ; rv:sequence ?graphSequence ;
          rv:priorIndexGeneration ?prior ; rv:indexRebuildDigest ?digest ;
          rv:ownerDataEpoch ?ownerEpoch ; rv:ownerSequence ?ownerSequence . }
        # An unbound control generation makes this condition an error, so no match.
        FILTER(?activated = ?generation && ?receiptEpoch = ?epoch) }
    } LIMIT 2`, MAX_PROOF_RESPONSE_BYTES);
  const rows = result.results?.bindings ?? [];
  const row = rows[0];
  if (rows.length !== 1 || row?.epoch?.value !== lineage.dataEpoch
    || !decimal.test(row.sequence?.value ?? '')
    || (row.generation && !generationIri.test(row.generation.value))) {
    throw new SearchIndexUnavailable('search generation control is unavailable or ambiguous');
  }
  const activation = row.receipt ? { receipt: row.receipt.value,
    graphSequence: row.graphSequence!.value, priorGeneration: row.prior!.value,
    sourceCut: { dataEpoch: row.ownerEpoch!.value, sequence: row.ownerSequence!.value },
    indexDigest: row.digest!.value } : null;
  const read = { contractVersion: '1' as const, profile: row.profile?.value ?? null,
    dataEpoch: row.epoch.value, sequence: row.sequence!.value,
    generation: row.generation?.value ?? null, activation };
  if (row.held?.value === 'true') return { ...read, state: 'restore-held', population: null };
  try {
    const { population } = await qualify();
    return { ...read, state: 'active', population };
  } catch (error) {
    if (error instanceof SearchSnapshotMoved) throw error;
    if (error instanceof SearchIndexUncertain) return { ...read, state: 'uncertain', population: null };
    if (error instanceof SearchIndexBudgetExceeded) return { ...read, state: 'over-budget', population: null };
    if (!(error instanceof SearchIndexUnavailable)) throw error;
    return { ...read, state: row.anchored?.value === 'true' ? 'unqualified' : 'quarantined',
      population: null };
  }
}
