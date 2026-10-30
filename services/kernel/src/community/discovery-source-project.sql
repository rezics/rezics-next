WITH changed AS (
INSERT INTO community.realm_discovery_source
(route, realm_id, realm_epoch, source_route, thread_id, board_id, creation_day, source_version, contributing, space_id)
VALUES (:route::integer, :realm_id::uuid, :realm_epoch::bigint, :source_route::integer,
        :thread_id::uuid, :board_id::uuid, :creation_day::date, :source_version::bigint, :contributing::boolean, :space_id::uuid)
ON CONFLICT (route, realm_id, realm_epoch, source_route, thread_id) DO UPDATE
SET source_version = EXCLUDED.source_version, contributing = EXCLUDED.contributing, space_id = EXCLUDED.space_id
WHERE community.realm_discovery_source.source_version < EXCLUDED.source_version
RETURNING source_version::text
)
SELECT source_version FROM changed LIMIT 1;
