UPDATE library.shelf_writer_owner
SET state = 'open', ready = :ready::boolean, epoch = :epoch::bigint,
    active_generation = :generation_id::nullable(uuid), requested_run = NULL, enqueue_pending = false
WHERE route = :route::integer AND account_id = :account_id::uuid;
