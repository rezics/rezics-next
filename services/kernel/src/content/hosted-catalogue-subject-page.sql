-- Indexed subject_thread candidates plus same-route published catalogue-post subject_ids.
-- Current public discovery requires a non-empty publication; empty TOC rows stay out of this page.
WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route,
         :subject_id::uuid AS subject_id,
         :has_after::boolean AS has_after,
         :after_id::uuid AS after_id,
         :limit::integer AS page_limit
),
thread_hits AS (
  SELECT c.route, c.catalogue_id, c.thread_id, c.publication_id
  FROM input
  JOIN content.subject_thread st
    ON st.route = input.route AND st.subject_id = input.subject_id
  JOIN content.hosted_catalogue c
    ON c.route = st.thread_route AND c.thread_id = st.thread_id
),
post_hits AS (
  SELECT c.route, c.catalogue_id, c.thread_id, c.publication_id
  FROM input
  JOIN content.hosted_catalogue c ON c.route = input.route
  JOIN content.post p
    ON p.route = c.route AND p.thread_id = c.thread_id AND p.post_id = c.catalogue_id
  JOIN content.revision r
    ON r.route = p.route AND r.thread_id = p.thread_id AND r.post_id = p.post_id
   AND r.revision_id = p.head_revision_id
  WHERE input.subject_id = ANY (r.subject_ids)
),
candidates AS (
  SELECT route, catalogue_id, thread_id, publication_id FROM thread_hits
  UNION
  SELECT route, catalogue_id, thread_id, publication_id FROM post_hits
)
SELECT c.route, c.catalogue_id, c.thread_id, c.publication_id
FROM candidates c
JOIN content.post p
  ON p.route = c.route AND p.thread_id = c.thread_id AND p.post_id = c.catalogue_id
JOIN input ON true
WHERE c.publication_id IS NOT NULL
  AND p.availability = 'available'
  AND NOT p.author_erased
  AND p.visibility = 'published'
  AND EXISTS (
    SELECT 1
    FROM content.hosted_placement hp
    WHERE hp.route = c.route
      AND hp.catalogue_id = c.catalogue_id
      AND hp.revision_id = c.publication_id
  )
  AND (NOT input.has_after OR c.catalogue_id > input.after_id)
ORDER BY c.catalogue_id
LIMIT (SELECT page_limit FROM input);
