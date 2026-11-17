import { Pool } from 'pg';
import { withBoundedReadOnlyTransaction } from '../../../../services/kernel/src/database/pool.ts';
import { subjectIndexName } from '../../../../services/kernel/src/search/indices.ts';
import type { NativeWebStack } from './stack.ts';

/** Compare only the next certified Source window with its original retained home. */
export async function readSubjectPublicationFrontier(stack: NativeWebStack, deadline: number): Promise<unknown> {
  if (!stack.searchWorker) return;
  const target = subjectIndexName(stack.searchWorker.prefix, 1);
  const pool = new Pool({ connectionString: stack.databaseUrl, max: 1, connectionTimeoutMillis: 1_000 });
  try {
    return await withBoundedReadOnlyTransaction(pool, deadline, async (client) => {
      const result = await client.query<{ observation: unknown }>(
        `WITH publication AS MATERIALIZED (
           SELECT job,source_home,phase,fence FROM search.generation_publication
           WHERE partition_no=0 AND physical_target=$1 AND family='subjects'
           ORDER BY (fence IS NOT NULL) DESC,activated_at DESC LIMIT 1
         ), source AS MATERIALIZED (
           SELECT b.partition_no,b.bootstrap,b.state,b.coverage_after,b.coverage_sealed,b.coverage_publication,
                  b.publication_execution,b.publication_observation,p.phase,p.fence
           FROM publication p JOIN semantic.public_filter_bootstrap b
             ON (b.partition_no,b.publication_job)=(p.source_home,p.job)
           WHERE b.state='adopted' LIMIT 1
         ), tip AS MATERIALIZED (
           SELECT t.step,t.verified_ordinal,t.complete,fields.next
           FROM source s JOIN semantic.public_filter_repair_step t
             ON (t.partition_no,t.bootstrap,t.execution)=(s.partition_no,s.bootstrap,s.publication_execution)
           CROSS JOIN LATERAL (
             SELECT jsonb_object_agg(field->>0, field->1->1) AS next
             FROM jsonb_array_elements((
               SELECT entry->1->1 FROM jsonb_array_elements(t.state::jsonb->1) AS entry
               WHERE entry->>0='next' AND entry->1->>0='object'
             )) AS field
             WHERE field->1->>0='value' AND field->>0 IN ('owner','phase','partition')
           ) fields
           WHERE t.verified_root IS NOT NULL AND t.verified_next IS NULL
           LIMIT 1
         ), frontier AS (
           SELECT t.*,CASE WHEN t.next->>'owner'='semantic' AND t.next->>'phase'='window'
             AND jsonb_typeof(t.next->'partition')='number'
             AND (t.next->>'partition')::numeric BETWEEN 0 AND 4095
             THEN (t.next->>'partition')::integer END AS home
           FROM tip t
         )
         SELECT jsonb_build_object(
           'phase',s.phase,'fenced',s.fence IS NOT NULL,'sourceState',s.state,
           'coverage',s.coverage_after,'sealed',s.coverage_sealed,
           'publicationCoverage',s.coverage_publication IS NOT NULL,
           'verifiedPages',f.verified_ordinal,'terminal',f.complete,'next',f.next,
           'retainedSuccessor',CASE WHEN n.step IS NOT NULL THEN jsonb_build_object(
             'verified',n.verified_root IS NOT NULL,'protocol',n.receipt_protocol,'inputLimit',n.input_limit,
             'observation',s.publication_observation,'execution',n.execution,'predecessor',n.predecessor,
             'bridge',saved.bridge) END,
           'home',CASE WHEN f.home IS NOT NULL THEN jsonb_build_object(
             'enrolled',e.partition_no IS NOT NULL,'complete',e.complete,'hasReceipt',e.receipt IS NOT NULL,
             'consumerMatches',e.creation_consumer='public_filter_' || replace(s.bootstrap::text,'-',''),
             'ownerState',p.write_state,'ownerEpochMatches',p.epoch=e.owner_epoch,
             'checkpointEpochMatches',CASE WHEN c.partition_no IS NOT NULL THEN c.epoch IS NULL OR c.epoch=p.epoch END,
             'headVsBase',CASE WHEN p.position IS NOT NULL AND e.creation_position IS NOT NULL
               THEN sign(p.position-e.creation_position) END,
             'checkpointVsBase',CASE WHEN c.position IS NOT NULL AND e.creation_position IS NOT NULL
               THEN sign(c.position-e.creation_position) END,
             'checkpointPresent',c.partition_no IS NOT NULL)
           END
         ) AS observation
         FROM source s LEFT JOIN frontier f ON true
         LEFT JOIN core.partition p ON p.partition_no=f.home
         LEFT JOIN semantic.public_filter_home_enrollment e ON (e.partition_no,e.bootstrap)=(f.home,s.bootstrap)
         LEFT JOIN core.consumer_checkpoint c ON (c.partition_no,c.consumer)=(f.home,e.creation_consumer)
         LEFT JOIN semantic.public_filter_repair_step n
           ON (n.partition_no,n.bootstrap,n.execution,n.predecessor)
             =(s.partition_no,s.bootstrap,s.publication_execution,f.step)
         LEFT JOIN LATERAL (
           SELECT jsonb_object_agg(state_key,bounds) AS bridge FROM (
             SELECT record_field->>0 AS state_key,jsonb_object_agg(bound_field->>0,bound_field->1->1) AS bounds
             FROM jsonb_array_elements(n.state::jsonb->1) AS record_field
             CROSS JOIN LATERAL jsonb_array_elements(CASE
               WHEN record_field->>0 IN ('input','next') AND record_field->1->>0='object'
                 THEN record_field->1->1 END) AS bridge_field
             CROSS JOIN LATERAL jsonb_array_elements(CASE
               WHEN bridge_field->>0='bridge' AND bridge_field->1->>0='object'
                 THEN bridge_field->1->1 END) AS bound_field
             WHERE bound_field->>0 IN ('position','through') AND bound_field->1->>0='bigint'
             GROUP BY record_field->>0
           ) states
         ) saved ON true`,
        [target],
      );
      return result.rows[0]?.observation;
    });
  } finally {
    await pool.end();
  }
}
