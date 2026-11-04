SELECT post_id, thread_id
FROM content.revision
WHERE route = :route::integer
  AND revision_id = :id::uuid
  AND ((:target_kind = 'thread' AND thread_id = :target_id::uuid)
    OR (:target_kind = 'post' AND post_id = :target_id::uuid));
