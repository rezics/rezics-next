UPDATE library.shelf_maintenance_run SET enqueue_pending=false,enqueue_attempt=enqueue_attempt+1 WHERE route=:route::integer AND account_id=:account_id::uuid AND run_id=:run_id::uuid
 AND epoch=:epoch::bigint AND sequence=:sequence::bigint AND segment=:segment::integer AND enqueue_attempt=:attempt::bigint AND NOT cancelled;
