SELECT board_id
FROM content.board
WHERE (route, board_id) > (:route::integer, :board_id::uuid)
ORDER BY route, board_id
LIMIT :limit::integer;
