SELECT route, thread_id, board_id, realm_id, space_id, realm_epoch::text,
       creation_day::text, source_version::text, contributing
FROM content.realm_discovery_contribution
WHERE route = :route::integer AND thread_id = :thread_id::uuid;
