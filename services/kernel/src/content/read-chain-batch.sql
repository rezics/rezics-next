-- A batch of thread row keys. Every key includes its route and identity; the
-- caller groups keys by partition database before starting this snapshot.
WITH input AS NOT MATERIALIZED (
  SELECT k.route, k.id
  FROM jsonb_to_recordset(:keys::jsonb) AS k(route integer, id uuid)
)
SELECT 'thread'::text AS kind, t.thread_id AS id, t.thread_id AS thread_id,
       t.board_id AS board_id, NULL::uuid AS parent_id, t.author_account_id AS author_id,
       NULL::uuid AS head_id, t.first_post_id AS first_post_id, t.title AS title,
       t.visibility AS visibility, t.security_revision::text AS security_revision,
       t.availability AS availability, t.created_at AS created_at,
       NULL::timestamptz AS revised_at, NULL::text AS licence,
       NULL::uuid[] AS subject_ids, NULL::uuid[] AS media_ids,
       NULL::bytea AS body, NULL::bytea AS sha256, t.kind AS thread_kind,
       NULL::text AS board_purpose, NULL::jsonb AS vote_citation, NULL::uuid AS realm_id,
       NULL::timestamptz AS deleted_at, false AS restorable, NULL::uuid AS decision_id,
       NULL::boolean AS matches
FROM input i
CROSS JOIN LATERAL (
  SELECT t.thread_id, t.board_id, t.author_account_id, t.first_post_id, t.title,
         t.visibility, t.security_revision, t.availability, t.created_at, t.kind
  FROM content.thread t
  WHERE t.route = i.route AND t.thread_id = i.id
  LIMIT 1
) t;
