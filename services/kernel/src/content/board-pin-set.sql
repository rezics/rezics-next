UPDATE content.board_thread
SET pin_slot = :pin_slot::smallint
WHERE route = :route::integer AND board_id = :board_id::uuid AND thread_id = :thread_id::uuid
RETURNING thread_id;
