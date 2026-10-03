import { randomUUID } from 'node:crypto';
import { DATASET, GRAPHS, RV, hash, iri, lit, type WorkActivationEnvironment } from '../work/activate.ts';
import { NATIVE_ID } from './graph.ts';

export const OCCURRENCE_LABEL_INDEX_STATE = 'urn:rezics:graph:occurrence-search-state';
export const OCCURRENCE_LABEL_BACKFILL_COST = { batch: 64, queryBytes: 8192, deadlineMs: 600_000 } as const;
const state = iri(OCCURRENCE_LABEL_INDEX_STATE);

/** One native transaction projects or removes <=64 placements. The receipt and
 * durable batch checkpoint survive a lost reply or process restart. Current
 * Structure revisions fence every batch; staging never writes text documents. */
async function projectOccurrenceLabelsBatch(env: WorkActivationEnvironment,
  input: { generation?: string; reset?: boolean; job?: string } = {}): Promise<number | null> {
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
  const initialize = checkpoint === undefined || rows[0]!.targetText?.value !== textGeneration;
  const digest = hash(JSON.stringify(input.reset
    ? { family: 'occurrence-lucene-reset-v1', generation, job: input.job ?? randomUUID() }
    : { family: 'occurrence-lucene-v1', generation, revision, checkpoint, build, textGeneration }));
  const receipt = `urn:rezics:receipt:chapter-search-index:${digest}`;
  const batch = `urn:rezics:outbox:${hash(`${receipt}\0batch`)}`;
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
        GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
          rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n ; rv:textIndexGeneration ${iri(textGeneration!)} . }
        GRAPH ${iri(GRAPHS.current)} { ?structure rv:selectedGeneration ${iri(generation)} ; rv:structureHead ${iri(revision)} . }
        ${input.reset || initialize ? '' : `GRAPH ${state} { ${iri(generation)} rv:indexBatch ${lit(checkpoint!)} ; rv:targetRevision ${iri(revision)} ; rv:indexBuild ${iri(build!)} . }`}
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
        BIND(?n + 1 AS ?next)
      }` });
  if (result.status === 'guard-unmatched') return 0;
  if (result.status !== 'committed' || result.position.dataEpoch !== env.lineage.dataEpoch) {
    throw new Error(`Occurrence label projection ${result.status}`
      + (result.status === 'invalid' ? `: ${JSON.stringify(result.report)}` : ''));
  }
  if (initialize || input.reset) return 0;
  const proof = (await env.fuseki.query(`PREFIX rv: <${RV}>
    SELECT ?count WHERE { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} rv:occurrenceProjectedCount ?count . } } LIMIT 2`,
    OCCURRENCE_LABEL_BACKFILL_COST.queryBytes)).results?.bindings ?? [];
  const projected = Number(proof[0]?.count?.value);
  if (proof.length !== 1 || !Number.isInteger(projected) || projected < 0 || projected > OCCURRENCE_LABEL_BACKFILL_COST.batch)
    throw new Error('Occurrence label projection has no bounded receipt proof');
  return projected;
}

export async function projectOccurrenceLabelsOnce(env: WorkActivationEnvironment,
  input: { generation?: string; reset?: boolean; job?: string } = {}): Promise<boolean> {
  return await projectOccurrenceLabelsBatch(env, input) !== null;
}

export async function backfillOccurrenceLabels(env: WorkActivationEnvironment, input: {
  generation?: string; reset?: boolean; job?: string; signal?: AbortSignal;
} = {}): Promise<{ indexed: number; batches: number; job: string }> {
  const job = input.job ?? randomUUID(), started = performance.now();
  let batches = 0, indexed = 0;
  if (input.reset) { await projectOccurrenceLabelsOnce(env, { ...input, job }); batches++; }
  for (;;) {
    input.signal?.throwIfAborted();
    if (performance.now() - started >= OCCURRENCE_LABEL_BACKFILL_COST.deadlineMs)
      throw new Error('Occurrence label backfill exceeded 600 seconds; rerun to resume committed batches');
    const projected = await projectOccurrenceLabelsBatch(env, { generation: input.generation });
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
