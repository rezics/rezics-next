import type { Pool } from 'pg';
import type { GraphSuppressionProof } from './graph.ts';

/** A restored active pin is safe only when its immutable Content supersession
 * names this retained journal erasure and the exact receipt still in the graph.
 * One indexed anti-join covers at most 64 revision IDs; no body bytes are read. */
export async function publicationSupersessionsMatch(content: Pool,
  revisionIds: readonly string[], erasureId: string, erasureEpoch: string,
  proof: GraphSuppressionProof | null): Promise<boolean> {
  if (!revisionIds.length || revisionIds.length > 64) return false;
  const row = (await content.query<{ mismatch: boolean }>(`SELECT EXISTS (
    SELECT 1 FROM content.publication_preparation p
    WHERE p.revision_id = ANY($1::uuid[]) AND p.status = 'active' AND p.pin_active
      AND NOT EXISTS (
        SELECT 1 FROM content.publication_erasure_supersession s
        JOIN content.revision_erasure e ON e.revision_id = s.revision_id
          AND e.erasure_id = s.erasure_id AND e.erasure_epoch = s.erasure_epoch
        WHERE s.operation_id = p.operation_id AND s.revision_id = p.revision_id
          AND s.erasure_id = $2::uuid AND s.erasure_epoch = $3::bigint
          AND s.graph_receipt = $4 AND s.graph_data_epoch = $5
          AND s.graph_sequence = $6::bigint)
  ) AS mismatch`, [revisionIds, erasureId, erasureEpoch, proof?.receipt ?? null,
    proof?.dataEpoch ?? null, proof?.sequence ?? null])).rows[0];
  return row?.mismatch === false;
}
