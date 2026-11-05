SELECT board_id
FROM content.board
WHERE route = :route::integer AND board_id = :board_id::uuid
FOR UPDATE;
