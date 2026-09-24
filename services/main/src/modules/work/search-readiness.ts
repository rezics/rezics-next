import { DATASET, GRAPHS, RV, iri, lit, PUBLIC_SEARCH_ANCHOR,
  TEXT_INDEX_PROFILE, TEXT_INDEX_PROBE, TEXT_INDEX_PROBE_BODY,
  TEXT_INDEX_PROBE_GRAPH, type GraphLineage } from './activate.ts';
import { setTimeout as delay } from 'node:timers/promises';
import { PUBLIC_SEARCH_GRAPH } from './select-main.ts';
import { FusekiQueryResponseTooLarge, FusekiReadBudgetExceeded, fusekiReadBudget,
  type FusekiClient, type SparqlResult } from '../../infrastructure/fuseki.ts';

// These are whole-request work limits, independent of the output page size.
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

export const MAX_SEARCH_SNAPSHOT_ATTEMPTS = 3;
export const MAX_SEARCH_REQUEST_MS = 1_500;
export const MAX_SEARCH_FUSEKI_CALLS = 72;
export const MAX_SEARCH_FUSEKI_BYTES = 8_388_608;
const RETRY_DELAYS_MS = [75, 250] as const;

/** Retry only a proven position race; corruption and budget failures retain their typed outcome. */
export async function withStableSearchSnapshot<T>(fuseki: FusekiClient | undefined, read: () => Promise<T>,
  deadlineMs = MAX_SEARCH_REQUEST_MS): Promise<T> {
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
      for (let attempt = 1; attempt <= MAX_SEARCH_SNAPSHOT_ATTEMPTS; attempt++) {
        try { return await Promise.race([read(), expired]); }
        catch (error) {
          if (controller.signal.aborted) {
            throw new SearchRequestTimedOut('public search request exceeded wall deadline', { cause: error });
          }
          if (!(error instanceof SearchSnapshotMoved) || attempt === MAX_SEARCH_SNAPSHOT_ATTEMPTS) throw error;
          try {
            await delay(RETRY_DELAYS_MS[attempt - 1], undefined, { signal: controller.signal });
            // A long native writer can outlive both fixed waits. Poll only after
            // a proven movement, with the same call and wall budgets as the read.
            while (fuseki && (await serverState(fuseki)).publicSearchWriteActive) {
              await delay(75, undefined, { signal: controller.signal });
            }
          }
          catch (cause) {
            if (controller.signal.aborted) {
              throw new SearchRequestTimedOut('public search request exceeded wall deadline', { cause });
            }
            throw cause;
          }
        }
      }
      throw new SearchSnapshotMoved('public search position moved beyond retry budget');
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

interface MembershipProof { population: number }
const qualified = new WeakMap<FusekiClient, Map<string, Promise<MembershipProof>>>();
const generationIri = /^urn:rezics:text-index-generation:[0-9a-f-]{36}$/;
const instanceIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const decimal = /^(0|[1-9][0-9]*)$/;

async function serverState(fuseki: FusekiClient): Promise<{
  instanceId: string; publicSearchWriteEpoch: string; publicSearchWriteActive: boolean }> {
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
  const epoch = health.publicSearchWriteEpoch;
  if (typeof epoch !== 'string' || !decimal.test(epoch)
    || typeof health.publicSearchWriteActive !== 'boolean'
    || health.publicSearchWriteActive !== (BigInt(epoch) % 2n === 1n)) {
    throw new SearchIndexUnavailable('Fuseki public index mutation state is unavailable');
  }
  return { instanceId, publicSearchWriteEpoch: epoch,
    publicSearchWriteActive: health.publicSearchWriteActive };
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
 * Requalify complete source/index membership once per JVM public-index mutation
 * epoch. Control/probe remains per request, and the phrase relation still binds
 * the exact graph sequence. Metadata-only commands can advance that sequence
 * without invalidating unchanged public MatchUnit membership.
 */
export async function assertPublicTextReady(fuseki: FusekiClient,
  lineage: GraphLineage): Promise<PublicTextPosition> {
  const state = await serverState(fuseki);
  if (state.publicSearchWriteActive) throw new SearchSnapshotMoved('public index write is in progress');
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
  const key = `${state.instanceId}\0${row.epoch.value}\0${row.generation.value}\0${state.publicSearchWriteEpoch}`;
  let entries = qualified.get(fuseki);
  if (!entries) {
    entries = new Map();
    qualified.set(fuseki, entries);
  }
  const existing = entries.get(key);
  if (existing) {
    const proof = await existing;
    await assertSameTextInstance(fuseki, position);
    return { ...position, population: proof.population };
  }
  const proof = qualifyMembership(fuseki, position);
  // Keep one generation/position only; concurrent requests for it share the proof.
  entries.clear();
  entries.set(key, proof);
  try {
    const membership = await proof;
    await assertSameTextInstance(fuseki, position);
    return { ...position, population: membership.population };
  }
  catch (error) { if (entries.get(key) === proof) entries.delete(key); throw error; }
}

async function qualifyMembership(fuseki: FusekiClient,
  position: PublicTextPosition): Promise<MembershipProof> {
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
    await assertSnapshotMoved(fuseki, position);
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
  return { population };
}
