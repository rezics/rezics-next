-- Thread-scoped locator for opening-wrapper erasure. Same bound as the post page.
WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :thread_id::uuid AS thread_id,
         :after_disclosure_id::nullable(uuid) AS after_disclosure_id, :limit::integer AS page_limit
)
SELECT d.disclosure_id, d.thread_id, d.post_id, d.revision_id, d.catalogue_id,
       d.revoked_at IS NOT NULL AS revoked
FROM content.revision_disclosure d CROSS JOIN input i
WHERE d.route = i.route AND d.thread_id = i.thread_id
  AND (i.after_disclosure_id IS NULL OR d.disclosure_id > i.after_disclosure_id)
ORDER BY d.disclosure_id
LIMIT (SELECT page_limit FROM input);
