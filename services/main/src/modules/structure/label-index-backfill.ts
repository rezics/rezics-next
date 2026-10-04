import { randomUUID } from 'node:crypto';
import { DATASET, GRAPHS, RV, hash, iri, lit, type WorkActivationEnvironment } from '../work/activate.ts';
import { NATIVE_ID } from './graph.ts';

export const OCCURRENCE_LABEL_INDEX_STATE = 'urn:rezics:graph:occurrence-search-state';
export const OCCURRENCE_LABEL_BACKFILL_COST = { batch: 64, queryBytes: 8192, deadlineMs: 600_000 } as const;
const state = iri(OCCURRENCE_LABEL_INDEX_STATE);

export interface OccurrenceLabelProgress {
  generation: string;
  revision: string;
  textGeneration: string;
  receipt: string;
  action: 'initialize' | 'project' | 'reset';
  checkpoint: string | null;
  nextCheckpoint: string;
  projected: number;
}
type ProjectionInput = { generation?: string; reset?: boolean; job?: string;
  onProgress?: (progress: OccurrenceLabelProgress) => void };

/** Retain the exact failing item in relay retry logs and operator backfills. */
export class OccurrenceLabelProjectionStalled extends Error {
  constructor(reason: string, readonly projection: Omit<OccurrenceLabelProgress, 'nextCheckpoint' | 'projected'>,
    options?: ErrorOptions) {
    super(`${reason}: ${JSON.stringify(projection)}`, options);
  }
}

/** One native transaction projects or removes <=64 placements. The receipt and
 * durable batch checkpoint survive a lost reply or process restart. Current
 * Structure revisions fence every batch; staging never writes text documents. */
async function projectOccurrenceLabelsBatch(env: WorkActivationEnvironment,
  input: ProjectionInput = {}): Promise<number | null> {
  if (input.generation && !NATIVE_ID.test(input.generation) || input.reset && !input.generation) {
    throw new Error('A label-index reset requires one native generation IRI');
  }
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}>
    SELECT ?generation ?revision ?checkpoint ?build ?targetText ?textGeneration WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:textIndexGeneration ?textGeneration . }
      GRAPH ${iri(GRAPHS.current)} {
      ?structure rv:structureProfile ?profile ; rv:selectedGeneration ?generation ; rv:structureHead ?revision .
      FILTER(?profile IN (rv:WorkComposition, rv:BookComposition))
      ${input.generation ? `FILTER(?generation = ${iri(input.generation)})` : ''}
      ?generation rv:generationState rv:Active .
    } OPTIONAL { GRAPH ${state} { ?generation rv:indexBatch ?checkpoint ; rv:indexBuild ?build ; rv:targetTextGeneration ?targetText } }
      ${input.reset ? '' : `FILTER NOT EXISTS { GRAPH ${state} { ?generation
        rv:indexVersion "occurrence-lucene-v1" ; rv:indexedRevision ?revision ; rv:indexedTextGeneration ?textGeneration . } }`}
    } LIMIT 1`, OCCURRENCE_LABEL_BACKFILL_COST.queryBytes)).results?.bindings ?? [];
  if (!rows.length) return null;
  const generation = rows[0]!.generation?.value, revision = rows[0]!.revision?.value;
  const checkpoint = rows[0]!.checkpoint?.value;
  if (!generation || !revision || !NATIVE_ID.test(generation) || !NATIVE_ID.test(revision)
    || checkpoint !== undefined && !/^\d+$/.test(checkpoint)) throw new Error('Occurrence label checkpoint is ambiguous');
  const build = rows[0]!.build?.value, textGeneration = rows[0]!.textGeneration?.value;
  if (!textGeneration)
    throw new Error('Occurrence label text generation is unavailable');
  const initialize = checkpoint === undefined || rows[0]!.targetText?.value !== textGeneration;
  const action: OccurrenceLabelProgress['action'] = input.reset ? 'reset' : initialize ? 'initialize' : 'project';
  // Initialization resets indexBatch to zero. Its pre-reset checkpoint can be
  // visited again by a later projection batch (G1056: persisted batch 1 replayed
  // an initialization receipt forever). Fence both the action and source target;
  // v2 also bypasses colliding v1 receipts already retained by long-lived stacks.
  const digest = hash(JSON.stringify(input.reset
    ? { family: 'occurrence-lucene-reset-v1', generation, job: input.job ?? randomUUID() }
    : { family: 'occurrence-lucene-v2', action, dataEpoch: env.lineage.dataEpoch, routingEpoch: env.lineage.routingEpoch,
      generation, revision, checkpoint, build, targetText: rows[0]!.targetText?.value, textGeneration }));
  const receipt = `urn:rezics:receipt:chapter-search-index:${digest}`;
  const batch = `urn:rezics:outbox:${hash(`${receipt}\0batch`)}`;
  const projection = { generation, revision, textGeneration, receipt, action, checkpoint: checkpoint ?? null };
  const stalled = (reason: string, cause?: unknown) => new OccurrenceLabelProjectionStalled(reason, projection,
    cause === undefined ? undefined : { cause });
  try {
    const guard = `GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
      rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n ; rv:textIndexGeneration ${iri(textGeneration)} . }
      GRAPH ${iri(GRAPHS.current)} { ?structure rv:selectedGeneration ${iri(generation)} ; rv:structureHead ${iri(revision)} . }
      ${input.reset || initialize ? '' : `GRAPH ${state} { ${iri(generation)} rv:indexBatch ${lit(checkpoint!)} ; rv:targetRevision ${iri(revision)} ; rv:indexBuild ${iri(build!)} . }`}`;
    const result = await env.fuseki.commandWithReceipt({ receipt, digest, validations: [], deadlineMs: 60_000,
      update: `PREFIX rv: <${RV}>
        DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n } }
        INSERT {
          GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
          GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ;
            rv:requestDigest ${lit(digest)} ; rv:outcome rv:Succeeded ; rv:datasetId ${iri(DATASET)} ;
            rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next ;
            ${input.reset ? `rv:occurrenceSearchReset ${iri(generation)}` : `rv:occurrenceSearchGeneration ${iri(generation)}
              ${initialize ? '' : `; rv:occurrenceSearchRevision ${iri(revision)} ; rv:occurrenceSearchOffset ${lit(checkpoint!)}`}`} . }
          GRAPH ${iri(GRAPHS.outbox)} { ${iri(batch)} a rv:OutboxBatch ;
            rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next ; rv:eventCount 0 . }
        } WHERE {
          ${guard}
          FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
          BIND(?n + 1 AS ?next)
        }` });
    if (result.status === 'guard-unmatched') {
      // A concurrent revision/worker may legitimately win. An unchanged selected
      // item must not hot-loop forever as successful delivery without progress.
      const unchanged = (await env.fuseki.query(`PREFIX rv: <${RV}> ASK {
        GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:textIndexGeneration ${iri(textGeneration)} . }
        GRAPH ${iri(GRAPHS.current)} { ?structure rv:selectedGeneration ${iri(generation)} ; rv:structureHead ${iri(revision)} . }
        ${checkpoint === undefined ? `FILTER NOT EXISTS { GRAPH ${state} { ${iri(generation)} rv:indexBatch ?checkpoint } }`
          : `GRAPH ${state} { ${iri(generation)} rv:indexBatch ${lit(checkpoint)} }`}
        ${build === undefined ? `FILTER NOT EXISTS { GRAPH ${state} { ${iri(generation)} rv:indexBuild ?build } }`
          : `GRAPH ${state} { ${iri(generation)} rv:indexBuild ${iri(build)} }`}
        ${rows[0]!.targetText === undefined ? `FILTER NOT EXISTS { GRAPH ${state} { ${iri(generation)} rv:targetTextGeneration ?targetText } }`
          : `GRAPH ${state} { ${iri(generation)} rv:targetTextGeneration ${iri(rows[0]!.targetText.value)} }`}
      }`, OCCURRENCE_LABEL_BACKFILL_COST.queryBytes)).boolean;
      if (unchanged === true) throw stalled('Occurrence label projection guard rejected an unchanged checkpoint');
      if (unchanged !== false) throw stalled('Occurrence label projection guard has no movement proof');
      return 0;
    }
    if (result.status !== 'committed' || result.position.dataEpoch !== env.lineage.dataEpoch) {
      throw new Error(`Occurrence label projection ${result.status}`
        + (result.status === 'invalid' ? `: ${JSON.stringify(result.report)}` : ''));
    }
    if (initialize || input.reset) {
      input.onProgress?.({ ...projection, nextCheckpoint: '0', projected: 0 });
      return 0;
    }
    const proof = (await env.fuseki.query(`PREFIX rv: <${RV}>
      SELECT ?count WHERE { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} rv:occurrenceProjectedCount ?count . } } LIMIT 2`,
      OCCURRENCE_LABEL_BACKFILL_COST.queryBytes)).results?.bindings ?? [];
    const projected = Number(proof[0]?.count?.value);
    if (proof.length !== 1 || !Number.isInteger(projected) || projected < 0 || projected > OCCURRENCE_LABEL_BACKFILL_COST.batch)
      throw stalled('Occurrence label projection has no bounded receipt proof');
    input.onProgress?.({ ...projection, nextCheckpoint: String(BigInt(checkpoint!) + 1n), projected });
    return projected;
  } catch (error) {
    if (error instanceof OccurrenceLabelProjectionStalled) throw error;
    throw stalled(error instanceof Error ? error.message : String(error), error);
  }
}

export async function projectOccurrenceLabelsOnce(env: WorkActivationEnvironment,
  input: ProjectionInput = {}): Promise<boolean> {
  return await projectOccurrenceLabelsBatch(env, input) !== null;
}

export async function backfillOccurrenceLabels(env: WorkActivationEnvironment, input: ProjectionInput & {
  signal?: AbortSignal } = {}): Promise<{ indexed: number; batches: number; job: string }> {
  const job = input.job ?? randomUUID(), started = performance.now();
  let batches = 0, indexed = 0;
  if (input.reset) { await projectOccurrenceLabelsOnce(env, { ...input, job }); batches++; }
  for (;;) {
    input.signal?.throwIfAborted();
    if (performance.now() - started >= OCCURRENCE_LABEL_BACKFILL_COST.deadlineMs)
      throw new Error('Occurrence label backfill exceeded 600 seconds; rerun to resume committed batches');
    const projected = await projectOccurrenceLabelsBatch(env, { generation: input.generation, onProgress: input.onProgress });
    if (projected === null) return { indexed, batches, job };
    indexed += projected; batches++;
  }
}

/** Existing search readiness reports a constant-sized lag witness, never an
 * inventory/count of all stories. Operators drain the same resumable worker. */
export async function occurrenceLabelReadiness(env: WorkActivationEnvironment) {
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}>
    SELECT ?generation WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:textIndexGeneration ?textGeneration . }
      GRAPH ${iri(GRAPHS.current)} {
      ?structure rv:structureProfile ?profile ; rv:selectedGeneration ?generation ; rv:structureHead ?revision .
      FILTER(?profile IN (rv:WorkComposition, rv:BookComposition)) ?generation rv:generationState rv:Active .
    } FILTER NOT EXISTS { GRAPH ${state} { ?generation rv:indexVersion "occurrence-lucene-v1" ; rv:indexedRevision ?revision ; rv:indexedTextGeneration ?textGeneration . } }
    } LIMIT 1`, OCCURRENCE_LABEL_BACKFILL_COST.queryBytes)).results?.bindings ?? [];
  return { status: rows.length ? 'indexing' as const : 'current' as const,
    pending: { value: rows.length, kind: 'at-least' as const } };
}
