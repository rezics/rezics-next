import { DATASET, GRAPHS, RV, iri, lit, type GraphLineage } from './activate.ts';
import type { FusekiClient } from '../../infrastructure/fuseki.ts';

export class RestoreLineageConflict extends Error {}

export interface RestoreLineageCutover {
  prior: GraphLineage & { sequence: string };
  next: GraphLineage;
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
  if (!uuid.test(prior.dataEpoch) || !uuid.test(next.dataEpoch)
    || prior.dataEpoch === next.dataEpoch || !/^[0-9]+$/.test(prior.sequence)
    || !/^[0-9]+$/.test(prior.routingEpoch) || !/^[0-9]+$/.test(next.routingEpoch)
    || BigInt(next.routingEpoch) <= BigInt(prior.routingEpoch)) {
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
  const marker = `urn:rezics:restore:${next.dataEpoch}`;
  let updateError: unknown;
  try { await fuseki.update(`PREFIX rv: <${RV}>
    DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(prior.dataEpoch)} ;
      rv:routingEpoch ${lit(prior.routingEpoch)} ; rv:sequence ?oldSequence . } }
    INSERT { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(next.dataEpoch)} ;
      rv:routingEpoch ${lit(next.routingEpoch)} ; rv:sequence 0 ; rv:restoreCutover ${iri(marker)} .
      ${iri(marker)} a rv:RestoreCutover ; rv:priorDataEpoch ${lit(prior.dataEpoch)} ;
        rv:priorSequence ?oldSequence ; rv:dataEpoch ${lit(next.dataEpoch)} . } }
    WHERE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(prior.dataEpoch)} ;
      rv:routingEpoch ${lit(prior.routingEpoch)} ; rv:sequence ?oldSequence . }
      FILTER(?oldSequence = ${prior.sequence})
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(marker)} ?p ?o } }
    }`); }
  catch (error) { updateError = error; }
  const after = await control(fuseki);
  if (after.dataEpoch !== next.dataEpoch || after.routingEpoch !== next.routingEpoch
    || after.sequence !== '0') {
    throw new RestoreLineageConflict(updateError
      ? 'restore lineage update outcome is unknown' : 'restored graph lineage was not activated');
  }
  return { lineage: next, sequence: '0', replayed: false };
}
