SELECT realm_id
FROM content.board
WHERE route = :route::integer AND board_id = :id::uuid;
