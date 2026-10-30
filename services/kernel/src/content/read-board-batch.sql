-- One board row-kind statement, driven by full route/identity keys.
WITH input AS NOT MATERIALIZED (
  SELECT k.route, k.id
  FROM jsonb_to_recordset(:keys::jsonb) AS k(route integer, id uuid)
)
SELECT 'board'::text AS kind, b.board_id AS id, NULL::uuid AS thread_id,
       NULL::uuid AS board_id, NULL::uuid AS parent_id, NULL::uuid AS author_id,
       NULL::uuid AS head_id, NULL::uuid AS first_post_id, b.title AS title,
       b.visibility AS visibility, b.security_revision::text AS security_revision,
       'available'::text AS availability, b.created_at AS created_at,
       NULL::timestamptz AS revised_at, NULL::text AS licence,
       NULL::uuid[] AS subject_ids, NULL::uuid[] AS media_ids,
       NULL::bytea AS body, NULL::bytea AS sha256, NULL::text AS thread_kind,
       b.purpose AS board_purpose, NULL::jsonb AS vote_citation, b.realm_id AS realm_id,
       NULL::timestamptz AS deleted_at, false AS restorable, NULL::uuid AS decision_id,
       NULL::boolean AS matches
FROM input i
CROSS JOIN LATERAL (
  SELECT b.board_id, b.title, b.visibility, b.security_revision, b.created_at, b.purpose, b.realm_id
  FROM content.board b
  WHERE b.route = i.route AND b.board_id = i.id
  LIMIT 1
) b;
