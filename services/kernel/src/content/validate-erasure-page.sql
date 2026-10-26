-- One statement for the whole page: every id is a post of this route and thread.
-- One primary-key seek per requested id; no thread, author or revision scan.
WITH input AS NOT MATERIALIZED (
  SELECT :ids::uuid[] AS ids, :route::integer AS route, :thread_id::uuid AS thread_id
)
SELECT count(found.post_id) = cardinality(i.ids) AS valid
FROM input i
CROSS JOIN unnest(i.ids) AS requested(post_id)
LEFT JOIN LATERAL (
  SELECT p.post_id
  FROM content.post p
  WHERE p.route = i.route AND p.post_id = requested.post_id AND p.thread_id = i.thread_id
  LIMIT 1
) found ON true
GROUP BY i.ids;
