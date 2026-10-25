-- Called only after a bounded candidate range and actual current disclosure.
-- Both identities include the immutable route; no board partition is joined.
WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :thread_id::uuid AS thread_id,
         :post_id::uuid AS post_id, :revision_id::uuid AS revision_id,
         :query::text AS query
)
SELECT to_tsvector('simple'::regconfig, r.search_text)
       @@ plainto_tsquery('simple'::regconfig, i.query) AS matches
FROM input i
JOIN content.revision r ON r.route = i.route AND r.thread_id = i.thread_id
  AND r.post_id = i.post_id AND r.revision_id = i.revision_id
JOIN content.post p ON p.route = i.route AND p.thread_id = i.thread_id
  AND p.post_id = i.post_id AND p.head_revision_id = r.revision_id
WHERE p.availability = 'available' AND r.availability = 'available'
  AND r.search_text IS NOT NULL;
