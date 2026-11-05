SELECT fence_id::text AS "fenceId", epoch::text AS epoch, state, ready,
       active_generation::text AS "generationId"
FROM library.shelf_writer_owner
WHERE route = :route::integer AND account_id = :account_id::uuid
FOR UPDATE;
