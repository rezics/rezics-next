SELECT pin_revision::text AS pin_revision
FROM content.board
WHERE route = :route::integer AND board_id = :board_id::uuid;
