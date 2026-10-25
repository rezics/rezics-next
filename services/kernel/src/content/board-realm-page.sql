SELECT board_id
FROM content.board
WHERE route = :route::integer
  AND realm_id = :realm_id::uuid
  AND board_id < COALESCE(:after_board::nullable(uuid), 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid)
ORDER BY board_id DESC
LIMIT :limit::integer;
