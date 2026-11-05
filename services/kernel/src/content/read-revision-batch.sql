-- One revision row-kind statement; body bytes are projected only for final passes.
WITH input AS NOT MATERIALIZED (
  SELECT k.route, k.id
  FROM jsonb_to_recordset(:keys::jsonb) AS k(route integer, id uuid)
), options AS (SELECT :include_body::boolean AS include_body, :query::text AS query)
SELECT 'revision'::text AS kind, r.revision_id AS id, r.thread_id AS thread_id,
       r.board_id AS board_id, r.post_id AS parent_id, NULL::uuid AS author_id,
       NULL::uuid AS head_id, NULL::uuid AS first_post_id, NULL::text AS title,
       NULL::text AS visibility, NULL::text AS security_revision,
       r.availability AS availability, r.recorded_at AS created_at, NULL::timestamptz AS revised_at,
       r.licence AS licence, r.subject_ids AS subject_ids, r.media_ids AS media_ids,
       CASE WHEN options.include_body THEN r.body ELSE NULL::bytea END AS body,
       r.body_sha256 AS sha256, NULL::text AS thread_kind, NULL::text AS board_purpose,
       r.vote_citation AS vote_citation, NULL::uuid AS realm_id, NULL::timestamptz AS deleted_at,
       false AS restorable, NULL::uuid AS decision_id,
       CASE WHEN options.query = '' THEN true
         ELSE COALESCE(to_tsvector('simple'::regconfig, r.search_text)
           @@ plainto_tsquery('simple'::regconfig, options.query), false) END AS matches
FROM input i
CROSS JOIN options
CROSS JOIN LATERAL (
  SELECT r.revision_id, r.thread_id, r.board_id, r.post_id, r.availability, r.recorded_at,
         r.licence, r.subject_ids, r.media_ids, r.body, r.body_sha256, r.vote_citation, r.search_text
  FROM content.revision r
  WHERE r.route = i.route AND r.revision_id = i.id
  LIMIT 1
) r;
