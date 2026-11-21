import { createHash } from 'node:crypto';
import { assertCompleteSearch } from './complete-search.ts';
import type { PoolClient } from 'pg';
import { type OpenSearch, SearchUnavailableError } from './opensearch.ts';
import { readRepairWinnerCheckpoint } from './public-filter-repair-checkpoint.ts';
import type { SearchWriterPublicationFence } from './writer-guard.ts';

// The next raw key disqualifies the shortcut, including hidden and redirected keys.
export const SPARSE_SUBJECT_KEYS = 32;

type Candidate = { id: string; home: number; epoch: number; position: string };
export type SparseSubjectCut = { keys: Candidate[]; digest: Buffer };

/** The installed receiver topology covers empty homes. Every occupied native home
 * contributes its actual command clock, and the writer and physical shard clocks
 * bind the proof to this drained fence. The ordinary Source still decides eligibility.
 */
export async function readSparseSubjectCut(
  client: PoolClient,
  search: OpenSearch,
  owner: SearchWriterPublicationFence,
): Promise<SparseSubjectCut | 'dense' | null> {
  const { consumer, job, fence } = owner;
  const result = await client.query<{ keys: Candidate[]; authority: string | null; gate_revision: string }>(
    `WITH inventory AS MATERIALIZED (
       SELECT route,subject_id FROM semantic.subject ORDER BY route,subject_id LIMIT $5
     )
     SELECT (SELECT coalesce(jsonb_agg(jsonb_build_object('id',i.subject_id,'home',i.route/16,
         'epoch',p.epoch,'position',p.position::text) ORDER BY i.route,i.subject_id),'[]')
       FROM inventory i LEFT JOIN core.partition p ON p.partition_no=i.route/16 AND p.write_state='active') AS keys,
       encode(search.public_filter_ack_range_witness(m.bootstrap,0,4096,
         search.public_filter_ack_witness(ARRAY['','@source','@accounts','@ack-retention',g.physical_target])),
         'hex') AS authority,g.publication_revision::text AS gate_revision
     FROM search.identity_writer_gate g
     JOIN core.partition h ON h.partition_no=0 AND h.write_state='active' AND h.epoch=g.owner_epoch
     JOIN core.subject_subscription_v1 m ON (m.job,m.physical_target,m.incarnation,m.consumer)=
         (g.publication_job,g.physical_target,g.incarnation,g.publication_consumer)
     JOIN core.subject_retention_domain d ON d.singleton AND NOT d.fenced
       AND (d.registration_generation,d.restore_generation)=(m.registration_generation,m.restore_generation)
     JOIN search.public_filter_ack_manifest a ON (a.job,a.bootstrap,a.incarnation)=(m.job,m.bootstrap,m.incarnation)
     WHERE (g.partition_no,g.publication_job,g.publication_fence,g.physical_target,g.incarnation,g.publication_home)=
       (0,$1,$2,$3,$4,4096) AND g.publication_after IS NULL AND g.publication_consumer=$6::jsonb
       AND core.subject_membership_revision_v1()>=m.birth`,
    [job, fence, consumer.physicalTarget, consumer.incarnation, SPARSE_SUBJECT_KEYS + 1, consumer],
  );
  const cut = result.rows[0];
  if (cut && cut.keys.length > SPARSE_SUBJECT_KEYS) return 'dense';
  if (!cut?.authority || cut.keys.some((row) => row.position === null)) return null;
  const physical = await readRepairWinnerCheckpoint(search, consumer.physicalTarget, consumer.incarnation);
  const digest = createHash('sha256')
    .update(JSON.stringify([owner.job, fence, consumer.incarnation, cut, physical]))
    .digest();
  return { keys: cut.keys, digest };
}

// The surrounding shard checkpoints keep these physical pages on one exact engine
// cut. Even a short first page must consume OpenSearch's own composite after_key.
export async function matchSparseSubjectKeys(
  search: OpenSearch,
  target: string,
  expected: ReadonlySet<string>,
  examined: (keys: number) => void,
) {
  if (expected.size > SPARSE_SUBJECT_KEYS) return false;
  const remaining = new Set(expected);
  let after: { id: string } | undefined;
  for (let page = 0; page < 2; page++) {
    const { status, body } = await search.request<{
      aggregations?: {
        keys?: { buckets?: { key?: { id?: unknown }; doc_count?: number }[]; after_key?: { id: string } };
      };
    }>(
      'POST',
      `/${target}/_search`,
      {
        size: 1,
        _source: false,
        track_total_hits: false,
        aggs: {
          keys: {
            composite: {
              size: SPARSE_SUBJECT_KEYS + 1,
              sources: [{ id: { terms: { field: 'id', missing_bucket: true } } }],
              ...(after ? { after } : {}),
            },
          },
        },
      },
      { query: { allow_partial_search_results: false } },
    );
    assertCompleteSearch(body);
    const keys = body.aggregations?.keys;
    if (status !== 200 || !keys || !Array.isArray(keys.buckets) || keys.buckets.length > SPARSE_SUBJECT_KEYS + 1)
      throw new SearchUnavailableError('Sparse Subject key enumeration is unavailable');
    examined(keys.buckets.length);
    for (const bucket of keys.buckets) {
      if (bucket?.doc_count !== 1 || typeof bucket.key?.id !== 'string' || !remaining.delete(bucket.key.id))
        return false;
    }
    if (keys.after_key === undefined) return remaining.size === 0;
    if (!keys.buckets.length || typeof keys.after_key?.id !== 'string')
      throw new SearchUnavailableError('Sparse Subject key enumeration cannot advance');
    after = keys.after_key;
  }
  return false;
}
