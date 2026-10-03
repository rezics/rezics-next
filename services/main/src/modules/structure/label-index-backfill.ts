import { randomUUID } from 'node:crypto';
import { DATASET, GRAPHS, RV, hash, iri, lit, type WorkActivationEnvironment } from '../work/activate.ts';
import { NATIVE_ID } from './graph.ts';

export const OCCURRENCE_LABEL_INDEX_STATE = 'urn:rezics:graph:occurrence-search-state';
export const OCCURRENCE_LABEL_BACKFILL_COST = { batch: 64, queryBytes: 65_536, deadlineMs: 600_000 } as const;

/** Durable descriptors are the checkpoint. A lost response, process restart or
 * concurrent Structure write cannot skip an unindexed placement. The native
 * command owns postings/counts and commits them with its maintenance receipt.
 * Reads fail closed until indexedCount equals the selected generation's count.
 * A reset is explicit, generation-scoped and replayable with the same job ID. */
export async function backfillOccurrenceLabels(env: WorkActivationEnvironment, input: {
  generation?: string; reset?: boolean; job?: string; signal?: AbortSignal;
} = {}): Promise<{ indexed: number; batches: number; job: string }> {
  if (input.generation && !NATIVE_ID.test(input.generation) || input.reset && !input.generation) {
    throw new Error('A label-index reset requires one native generation IRI');
  }
  const job = input.job ?? randomUUID(), started = performance.now();
  const check = () => {
    input.signal?.throwIfAborted();
    if (performance.now() - started >= OCCURRENCE_LABEL_BACKFILL_COST.deadlineMs) {
      throw new Error('Occurrence label backfill exceeded 600 seconds; rerun to resume committed batches');
    }
  };
  const command = async (placements: string[], reset?: string, initialize?: string) => {
    check();
    const digest = hash(JSON.stringify({ family: 'occurrence-label-index-v1', job, placements, reset, initialize }));
    // The existing chapter-search maintenance admission is extended by its
    // native policy to a receipts-only occurrence index batch. Callers cannot
    // supply derived RDF, coverage counts or readiness markers.
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
            ${reset ? `rv:occurrenceSearchReset ${iri(reset)}` : initialize ? `rv:occurrenceSearchGeneration ${iri(initialize)}`
              : `rv:occurrenceSearchPlacement ${placements.map(iri).join(', ')}`} . }
          GRAPH ${iri(GRAPHS.outbox)} { ${iri(batch)} a rv:OutboxBatch ;
            rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next ; rv:eventCount 0 . }
        } WHERE {
          GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
            rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . }
          ${reset || initialize ? `GRAPH ${iri(GRAPHS.current)} { ${iri((reset ?? initialize)!)} a rv:StructureGeneration . }`
            : placements.map(placement => `FILTER EXISTS { GRAPH ${iri(GRAPHS.current)} {
              ${iri(placement)} a rv:OccurrencePlacement .
              FILTER NOT EXISTS { ${iri(placement)} rv:removedBy ?removed }
            } }`).join('\n')}
          FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
          BIND(?n + 1 AS ?next)
        }` });
    if (result.status === 'guard-unmatched') return false;
    if (result.status !== 'committed' || result.position.dataEpoch !== env.lineage.dataEpoch) {
      throw new Error(`Occurrence label backfill ${result.status}`
        + (result.status === 'invalid' ? `: ${JSON.stringify(result.report)}` : ''));
    }
    return true;
  };
  if (input.reset) await command([], input.generation);
  let indexed = 0, batches = 0;
  // An old empty generation has no placement from which to initialize its
  // version/count. Initialize missing headers without pretending coverage.
  for (;;) {
    check();
    const rows = (await env.fuseki.query(`PREFIX rv: <${RV}>
      SELECT ?generation WHERE { GRAPH ${iri(GRAPHS.current)} {
        ?structure rv:structureProfile ?profile ; rv:selectedGeneration ?generation .
        FILTER(?profile IN (rv:WorkComposition, rv:BookComposition))
        ${input.generation ? `FILTER(?generation = ${iri(input.generation)})` : ''}
        ?generation rv:generationState rv:Active .
      } FILTER NOT EXISTS { GRAPH ${iri(OCCURRENCE_LABEL_INDEX_STATE)} {
        ?generation rv:indexVersion "occurrence-substring-v1" .
      } } } LIMIT 1`, OCCURRENCE_LABEL_BACKFILL_COST.queryBytes)).results?.bindings ?? [];
    if (!rows.length) break;
    const generation = rows[0]?.generation?.value;
    if (!generation || !NATIVE_ID.test(generation)) throw new Error('Occurrence label generation is ambiguous');
    await command([], undefined, generation); batches++;
  }
  for (;;) {
    check();
    const rows = (await env.fuseki.query(`PREFIX rv: <${RV}>
      SELECT ?generation ?placement WHERE { GRAPH ${iri(GRAPHS.current)} {
        ?structure rv:structureProfile ?profile ; rv:selectedGeneration ?generation .
        FILTER(?profile IN (rv:WorkComposition, rv:BookComposition))
        ${input.generation ? `FILTER(?generation = ${iri(input.generation)})` : ''}
        ?generation rv:generationState rv:Active .
        ?placement a rv:OccurrencePlacement ; rv:generation ?generation .
        FILTER NOT EXISTS { ?placement rv:removedBy ?removed }
      } FILTER NOT EXISTS { GRAPH ${iri(OCCURRENCE_LABEL_INDEX_STATE)} {
        ?placement rv:indexedGeneration ?generation .
      } } } ORDER BY STR(?placement) LIMIT ${OCCURRENCE_LABEL_BACKFILL_COST.batch}`,
    OCCURRENCE_LABEL_BACKFILL_COST.queryBytes)).results?.bindings ?? [];
    if (!rows.length) return { indexed, batches, job };
    const placements = rows.map(row => row.placement?.value);
    if (placements.some(value => !value || !/^urn:rezics:placement:[0-9a-f]{64}$/.test(value))
      || new Set(placements).size !== placements.length) {
      throw new Error('Occurrence label backfill placements are ambiguous');
    }
    if (await command(placements as string[])) { indexed += placements.length; batches++; }
  }
}
