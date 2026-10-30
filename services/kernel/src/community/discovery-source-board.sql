INSERT INTO community.realm_discovery_board
(route, realm_id, realm_epoch, board_id, source_version, published)
VALUES (:route::integer, :realm_id::uuid, :realm_epoch::bigint, :board_id::uuid, :source_version::bigint, :published::boolean)
ON CONFLICT (route, realm_id, realm_epoch, board_id) DO UPDATE
SET source_version = EXCLUDED.source_version, published = EXCLUDED.published
WHERE community.realm_discovery_board.source_version < EXCLUDED.source_version
RETURNING source_version::text;
