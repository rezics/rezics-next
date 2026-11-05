UPDATE content.board
SET pin_revision = pin_revision + 1
WHERE route = :route::integer AND board_id = :board_id::uuid
RETURNING pin_revision;
