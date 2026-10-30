WITH input AS NOT MATERIALIZED (
  SELECT k.route, k.thread_id, k.post_id, k.revision_id, :query::text AS query
  FROM jsonb_to_recordset(:keys::jsonb)
    AS k(route integer, thread_id uuid, post_id uuid, revision_id uuid)
)
SELECT i.thread_id::text AS thread_id,
       matched.matches
FROM input i
CROSS JOIN LATERAL (
  SELECT to_tsvector('simple'::regconfig, r.search_text)
           @@ plainto_tsquery('simple'::regconfig, i.query) AS matches
  FROM content.post p
  JOIN content.revision r ON r.route = p.route AND r.thread_id = p.thread_id
    AND r.post_id = p.post_id AND r.revision_id = i.revision_id
  WHERE p.route = i.route AND p.thread_id = i.thread_id
    AND p.post_id = i.post_id AND p.head_revision_id = i.revision_id
    AND p.availability = 'available' AND r.availability = 'available'
    AND r.search_text IS NOT NULL
  LIMIT 1
) matched;
