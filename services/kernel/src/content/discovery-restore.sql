UPDATE content.realm_discovery_contribution c
SET contributing = true, source_version = source_version + 1
WHERE c.route = :route::integer AND c.thread_id = :thread_id::uuid AND NOT c.contributing
  AND c.source_version = :source_version::bigint
  AND c.realm_epoch = :realm_epoch::bigint
  AND EXISTS (SELECT 1 FROM content.thread t
    WHERE t.route = c.route AND t.thread_id = c.thread_id
      AND t.visibility = 'published' AND t.availability = 'available'
      AND EXISTS (SELECT 1 FROM content.post p
        WHERE p.route = t.route AND p.post_id = t.first_post_id AND p.thread_id = t.thread_id
          AND p.visibility = 'published' AND p.availability = 'available'))
RETURNING route, thread_id, board_id, realm_id, space_id, realm_epoch::text,
          creation_day::text, source_version::text, contributing;
