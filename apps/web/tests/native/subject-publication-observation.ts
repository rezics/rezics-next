import { Pool } from 'pg';
import { withBoundedReadOnlyTransaction } from '../../../../services/kernel/src/database/pool.ts';
import { subjectAlias, subjectIndexName } from '../../../../services/kernel/src/search/indices.ts';
import { createOpenSearch, OpenSearchError } from '../../../../services/kernel/src/search/opensearch.ts';
import { encode } from '../../../../services/kernel/src/search/public-filter-codec.ts';
import { subjectPartition } from '../../../../services/kernel/src/search/source.ts';
import type { NativeWebStack } from './stack.ts';

/** Observe the original generation-1 job, its Source and only the next certified repair window. */
export async function readSubjectPublicationFrontier(
  stack: NativeWebStack,
  deadline: number,
  fixtureIds: readonly string[] = [],
): Promise<unknown> {
  if (!stack.searchWorker) return;
  const target = subjectIndexName(stack.searchWorker.prefix, 1);
  const writers = fixtureIds.slice(0, 2);
  const pool = new Pool({ connectionString: stack.databaseUrl, max: 1, connectionTimeoutMillis: 1_000 });
  try {
    return await withBoundedReadOnlyTransaction(pool, deadline, async (client) => {
      const {
        rows: [job],
      } = await client.query<{ job: string; consumer: unknown }>(
        `SELECT j.job,j.consumer FROM search.generation_publication j
         LEFT JOIN search.public_filter_target t ON (t.partition_no,t.physical_target)=(0,j.physical_target)
         WHERE j.partition_no=0 AND j.physical_target=$1 AND j.family='subjects'
           AND (t.incarnation IS NULL OR t.incarnation=j.native_incarnation)
         ORDER BY (j.fence IS NOT NULL) DESC,j.activated_at,j.job LIMIT 1`,
        [target],
      );
      const result = await client.query<{ observation: unknown }>(
        `WITH target AS MATERIALIZED (
           SELECT incarnation FROM search.public_filter_target WHERE partition_no=0 AND physical_target=$1
         ), publication AS MATERIALIZED (
           SELECT j.job,j.source_home,j.phase,j.fence,j.pass,j.home,j.after_id,j.revision,
                  j.consumer,j.observation,j.native_incarnation
           FROM search.generation_publication j WHERE (j.partition_no,j.job)=(0,$4::uuid)
         ), registration AS MATERIALIZED (
           SELECT split_part(r.consumer_bootstrap, ':', 2)::uuid AS bootstrap
           FROM publication p JOIN target t ON t.incarnation=p.native_incarnation
           JOIN search.public_filter_registration r ON r.partition_no=p.source_home
             AND r.physical_target=$1 AND r.state='active' AND r.consumer_bootstrap IS NOT NULL
             AND md5(r.consumer)=md5($5) AND r.consumer=$5
           WHERE split_part(r.consumer_bootstrap, ':', 1)=p.source_home::text
           LIMIT 1
         ), source AS MATERIALIZED (
           SELECT b.partition_no,b.bootstrap,b.state,b.account_after,b.coverage_after,b.coverage_sealed,
                  b.coverage_publication,b.publication_execution,b.publication_job
           FROM publication p LEFT JOIN registration r ON true
           JOIN semantic.public_filter_bootstrap b ON b.partition_no=p.source_home
             AND (b.publication_job=p.job OR (b.publication_job IS NULL AND b.bootstrap=r.bootstrap))
           WHERE b.snapshot_kind='prepared' AND b.read_definition::text=p.consumer->>'readDefinition'
             AND (p.observation IS NULL OR p.observation=b.publication_observation)
           ORDER BY (b.publication_job IS NOT NULL) DESC LIMIT 1
         ), tip AS MATERIALIZED (
           SELECT t.step,t.verified_ordinal,t.verified_home,t.complete,t.ack_after,fields.next
           FROM source s JOIN semantic.public_filter_repair_step t
             ON (t.partition_no,t.bootstrap,t.execution)=(s.partition_no,s.bootstrap,s.publication_execution)
           CROSS JOIN LATERAL (
             SELECT jsonb_object_agg(field->>0, field->1->1) AS next
             FROM jsonb_array_elements((
               SELECT entry->1->1 FROM jsonb_array_elements(t.state::jsonb->1) AS entry
               WHERE entry->>0='next' AND entry->1->>0='object'
             )) AS field
             WHERE field->1->>0='value' AND (
               (field->>0='owner' AND field->1->>1 IN ('semantic','accounts'))
               OR (field->>0='phase' AND field->1->>1 IN ('scan','advance','project','account','window','bridge'))
               OR (field->>0='partition' AND jsonb_typeof(field->1->1)='number'
                 AND field->1->1 BETWEEN '0'::jsonb AND '4096'::jsonb))
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
           'phase',j.phase,'fenced',j.fence IS NOT NULL,
           'subjectPass',j.pass::text,'subjectHome',j.home,'subjectAfterId',j.after_id,'subjectRevision',j.revision::text,
           'sourceState',s.state,'sourcePinned',s.publication_job IS NOT NULL,
           'accountAfter',s.account_after,'coverage',s.coverage_after,'sealed',s.coverage_sealed,
           'publicationCoverage',s.coverage_publication IS NOT NULL,
           'verifiedPages',f.verified_ordinal,'verifiedHome',f.verified_home,
           'terminal',f.complete,'ackAfter',f.ack_after,'next',f.next,
           'writers',(SELECT jsonb_agg(jsonb_build_object(
               'home',wanted.home,'state',w.dispatch_state,'inFlight',w.writer_token IS NOT NULL,
               'sourcePosition',w.source_position::text,'visiblePosition',w.visible_position::text)
               ORDER BY wanted.ordinality)
             FROM unnest($2::uuid[],$3::integer[]) WITH ORDINALITY wanted(id,home,ordinality)
             LEFT JOIN search.identity_writer w ON (w.partition_no,w.physical_target,w.original_id)
               =(wanted.home,$1,wanted.id) AND w.incarnation=t.incarnation),
           'retainedSuccessor',CASE WHEN n.step IS NOT NULL THEN jsonb_build_object(
             'verified',n.verified_root IS NOT NULL,'protocol',n.receipt_protocol,'inputLimit',n.input_limit,
             'predecessor',n.predecessor,
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
         FROM (SELECT 1) sample
         LEFT JOIN target t ON true
         LEFT JOIN publication j ON true
         LEFT JOIN source s ON true
         LEFT JOIN frontier f ON true
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
               AND bound_field->1->>1 ~ '^[0-9]{1,19}$'
             GROUP BY record_field->>0
           ) states
         ) saved ON true`,
        [target, writers, writers.map(subjectPartition), job?.job ?? null, job ? encode(job.consumer) : null],
      );
      return result.rows[0]?.observation;
    });
  } finally {
    await pool.end();
  }
}

async function readSubjectAlias(prefix: string | undefined, url: string | undefined, deadline: number) {
  if (!prefix || !url) return null;
  const search = createOpenSearch(url, { maxResponseBytes: 8_192 });
  try {
    const { status, body } = await search.request<Record<string, unknown>>(
      'GET',
      `/_alias/${subjectAlias(prefix)}`,
      undefined,
      { timeoutMs: Math.max(1, deadline - Date.now()) },
    );
    return {
      status,
      targets: Object.keys(body).length,
      includesGenerationOne: Object.hasOwn(body, subjectIndexName(prefix, 1)),
    };
  } catch (error) {
    if (error instanceof OpenSearchError) return { status: error.status };
    return null;
  }
}

/** One best-effort sample after the HTTP cutoff. Keep raw native errors and payloads off transport logs. */
export async function readSubjectSearchCutoff(stack: NativeWebStack, ids: readonly string[]) {
  const sampledAtMs = Date.now();
  const deadline = sampledAtMs + 1_500;
  const [publication, alias] = await Promise.allSettled([
    readSubjectPublicationFrontier(stack, deadline, ids),
    readSubjectAlias(stack.searchWorker?.prefix, process.env.OPENSEARCH_URL, deadline),
  ]);
  return {
    sampledAtMs,
    publication: publication.status === 'fulfilled' ? (publication.value ?? null) : null,
    alias: alias.status === 'fulfilled' ? alias.value : null,
  };
}
