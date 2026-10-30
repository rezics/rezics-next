SELECT route, board_id
FROM content.board
WHERE realm_id IS NULL AND visibility = 'published'
  AND (route, board_id) > (:after_route::integer, :after_board::uuid)
ORDER BY route, board_id
LIMIT :limit::integer;
