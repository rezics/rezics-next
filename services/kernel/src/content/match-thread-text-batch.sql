WITH input AS NOT MATERIALIZED (
  SELECT k.route, k.thread_id, k.post_id, k.revision_id, :query::text AS query
  FROM jsonb_to_recordset(:keys::jsonb)
    AS k(route integer, thread_id uuid, post_id uuid, revision_id uuid)
)
SELECT i.thread_id::text AS thread_id,
       to_tsvector('simple'::regconfig, r.search_text)
         @@ plainto_tsquery('simple'::regconfig, i.query) AS matches
FROM input i
JOIN content.post p ON p.route = i.route AND p.thread_id = i.thread_id
  AND p.post_id = i.post_id AND p.head_revision_id = i.revision_id
JOIN content.revision r ON r.route = i.route AND r.thread_id = i.thread_id
  AND r.post_id = i.post_id AND r.revision_id = i.revision_id
WHERE p.availability = 'available' AND r.availability = 'available'
  AND r.search_text IS NOT NULL
  AND (i.route, i.revision_id) = ANY(SELECT route, revision_id FROM input);
