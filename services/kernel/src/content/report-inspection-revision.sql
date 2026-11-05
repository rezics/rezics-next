WITH selected AS (
  SELECT :target_kind::text AS target_kind, :target_id::uuid AS target_id
)
SELECT revision.post_id, revision.thread_id
FROM content.revision AS revision
CROSS JOIN selected
WHERE revision.route = :route::integer
  AND revision.revision_id = :id::uuid
  AND ((selected.target_kind = 'thread' AND revision.thread_id = selected.target_id)
    OR (selected.target_kind = 'post' AND revision.post_id = selected.target_id));
