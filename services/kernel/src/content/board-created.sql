SELECT board_id, recorded_transaction_id, created_at::text,
       xmin::text = pg_current_xact_id_if_assigned()::text AS inserted_here
FROM content.board
WHERE route = :route::integer AND board_id = :id::uuid;
