import type { Pool } from 'pg';
import type { GraphSuppressionProof } from './graph.ts';

/** Every restored active pin and supersession must name this retained journal
 * erasure and its exact graph receipt. Indexed probes cover at most 64 target
 * revisions; no body bytes are read. */
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
  ) OR EXISTS (
    SELECT 1 FROM content.publication_erasure_supersession s
    WHERE s.revision_id = ANY($1::uuid[])
      AND (s.erasure_id IS DISTINCT FROM $2::uuid
        OR s.erasure_epoch IS DISTINCT FROM $3::bigint
        OR s.graph_receipt IS DISTINCT FROM $4
        OR s.graph_data_epoch IS DISTINCT FROM $5
        OR s.graph_sequence IS DISTINCT FROM $6::bigint
        OR NOT EXISTS (SELECT 1 FROM content.publication_preparation p
          WHERE p.operation_id = s.operation_id AND p.revision_id = s.revision_id
            AND p.status = 'active' AND p.pin_active)
        OR NOT EXISTS (SELECT 1 FROM content.revision_erasure e
          WHERE e.revision_id = s.revision_id AND e.erasure_id = s.erasure_id
            AND e.erasure_epoch = s.erasure_epoch))
  ) AS mismatch`, [revisionIds, erasureId, erasureEpoch, proof?.receipt ?? null,
    proof?.dataEpoch ?? null, proof?.sequence ?? null])).rows[0];
  return row?.mismatch === false;
}
