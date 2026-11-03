SELECT thread_id, pin_slot
FROM content.board_thread
WHERE route = :route::integer AND board_id = :board_id::uuid AND thread_id = :thread_id::uuid
FOR UPDATE;
