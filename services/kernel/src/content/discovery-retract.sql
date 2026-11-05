UPDATE content.realm_discovery_contribution c
SET contributing = false, source_version = source_version + 1
WHERE c.route = :route::integer AND c.thread_id = :thread_id::uuid AND c.contributing
RETURNING route, thread_id, board_id, realm_id, space_id, realm_epoch::text,
          creation_day::text, source_version::text, contributing;
