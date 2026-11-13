-- Match Subject discovery's indexed thread association and same-home current Post reference.
-- A current public release must exist, but the saved publication may be any admitted history.
WITH input AS NOT MATERIALIZED (
  SELECT :subject_route::integer AS subject_route,
         :subject_id::uuid AS subject_id,
         :catalogue_route::integer AS catalogue_route,
         :catalogue_id::uuid AS catalogue_id
),
eligible_catalogue AS NOT MATERIALIZED (
  SELECT c.route, c.catalogue_id, c.thread_id
  FROM input
  JOIN content.hosted_catalogue c
    ON c.route = input.catalogue_route AND c.catalogue_id = input.catalogue_id
  JOIN content.post p
    ON p.route = c.route AND p.thread_id = c.thread_id AND p.post_id = c.catalogue_id
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
)
SELECT EXISTS (
  SELECT 1
  FROM input
  JOIN eligible_catalogue c ON true
  WHERE EXISTS (
    SELECT 1
    FROM content.subject_thread st
    WHERE st.route = input.subject_route
      AND st.subject_id = input.subject_id
      AND st.thread_route = c.route
      AND st.thread_id = c.thread_id
  )
  OR (
    c.route = input.subject_route
    AND EXISTS (
      SELECT 1
      FROM content.post p
      JOIN content.revision r
        ON r.route = p.route
       AND r.thread_id = p.thread_id
       AND r.post_id = p.post_id
       AND r.revision_id = p.head_revision_id
      WHERE p.route = c.route
        AND p.thread_id = c.thread_id
        AND p.post_id = c.catalogue_id
        AND input.subject_id = ANY (r.subject_ids)
    )
  )
) AS associated;
