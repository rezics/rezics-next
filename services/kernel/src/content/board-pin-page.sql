SELECT thread_id, pin_slot
FROM content.board_thread
WHERE route = :route::integer AND board_id = :board_id::uuid AND pin_slot IS NOT NULL
ORDER BY pin_slot ASC
LIMIT :limit::integer;
