-- Post rows carry their head projection and current moderation provenance.
-- These related rows share the post's partition; no cross-partition joins occur.
WITH input AS NOT MATERIALIZED (
  SELECT k.route, k.id
  FROM jsonb_to_recordset(:keys::jsonb) AS k(route integer, id uuid)
)
SELECT 'post'::text AS kind, p.post_id AS id, p.thread_id AS thread_id,
       NULL::uuid AS board_id, p.reply_to_post_id AS parent_id,
       p.author_account_id AS author_id, p.head_revision_id AS head_id,
       NULL::uuid AS first_post_id, NULL::text AS title,
       p.visibility AS visibility, p.security_revision::text AS security_revision,
       CASE WHEN p.availability = 'erased' THEN 'erased' ELSE p.head_availability END AS availability,
       p.created_at AS created_at, CASE
         WHEN p.head_recorded_transaction_id IS DISTINCT FROM p.recorded_transaction_id THEN p.head_recorded_at
         ELSE NULL::timestamptz END AS revised_at,
       NULL::text AS licence, NULL::uuid[] AS subject_ids, NULL::uuid[] AS media_ids,
       NULL::bytea AS body, NULL::bytea AS sha256, NULL::text AS thread_kind,
       NULL::text AS board_purpose, NULL::jsonb AS vote_citation, NULL::uuid AS realm_id,
       p.deleted_at AS deleted_at,
       p.purge_started_at IS NULL AND NOT p.purge_completed AND p.head_availability = 'available' AS restorable,
       p.decision_id AS decision_id, NULL::boolean AS matches
FROM input i
CROSS JOIN LATERAL (
  SELECT p.post_id, p.thread_id, p.reply_to_post_id, p.author_account_id, p.head_revision_id,
         p.visibility, p.security_revision, p.availability, p.created_at, p.recorded_transaction_id,
         p.deleted_at, p.purge_started_at, p.purge_completed,
         h.availability AS head_availability, h.recorded_transaction_id AS head_recorded_transaction_id,
         h.recorded_at AS head_recorded_at, d.decision_id
  FROM content.post p
  JOIN content.revision h ON h.route = p.route AND h.thread_id = p.thread_id
    AND h.post_id = p.post_id AND h.revision_id = p.head_revision_id
  LEFT JOIN content.moderation_decision d ON d.route = p.route AND d.target_kind = 'post'
    AND d.target_id = p.post_id AND d.security_revision = p.security_revision
  WHERE p.route = i.route AND p.post_id = i.id
  LIMIT 1
) p;
