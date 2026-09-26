import type { FusekiClient } from '../../infrastructure/fuseki.ts';
import { DATASET, GRAPHS, RV, iri, lit, type GraphLineage } from '../work/activate.ts';
import { graphErasureSuppressed, suppressGraphContentRevisions } from './graph.ts';

/** One indexed control lookup binds replay and release to the restored dataset. */
export async function graphLineageSequence(fuseki: FusekiClient,
  lineage: GraphLineage): Promise<string | null> {
  const result = await fuseki.query(`PREFIX rv: <${RV}> SELECT ?sequence WHERE {
    GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(lineage.dataEpoch)} ;
      rv:routingEpoch ${lit(lineage.routingEpoch)} ; rv:sequence ?sequence .
      FILTER NOT EXISTS { ${iri(DATASET)} rv:restoreHold true }
    }
  }`, 65_536);
  const rows = result.results?.bindings ?? [];
  return rows.length === 1 && /^(0|[1-9][0-9]*)$/.test(rows[0]?.sequence?.value ?? '')
    ? rows[0]!.sequence!.value : null;
}

/**
 * One exact receipt probe, then at most three bounded native writes and probes.
 * Cost is O(T + U) for at most 64 revision targets and 64 indexed units; it
 * never scans unrelated graph history.
 */
export async function replayGraphErasure(fuseki: FusekiClient, lineage: GraphLineage,
  erasureId: string, epoch: string, revisionIds: readonly string[], replay: boolean): Promise<
    'erased' | 'replayed' | 'conflict'> {
  try { if (await graphLineageSequence(fuseki, lineage) === null) return 'conflict'; }
  catch { return 'conflict'; }
  try {
    if (await graphErasureSuppressed(fuseki, erasureId, epoch, revisionIds)) return 'erased';
  } catch { return 'conflict'; }
  if (!replay) return 'conflict';
  try { await suppressGraphContentRevisions(fuseki, lineage, erasureId, epoch, revisionIds); }
  catch { return 'conflict'; }
  try { return await graphErasureSuppressed(fuseki, erasureId, epoch, revisionIds)
    ? 'replayed' : 'conflict'; }
  catch { return 'conflict'; }
}

export async function assertGraphErasure(fuseki: FusekiClient, lineage: GraphLineage, erasureId: string,
  epoch: string, revisionIds: readonly string[]): Promise<boolean> {
  return await graphLineageSequence(fuseki, lineage) !== null
    && graphErasureSuppressed(fuseki, erasureId, epoch, revisionIds);
}
