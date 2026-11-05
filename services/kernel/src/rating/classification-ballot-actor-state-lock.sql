SELECT eligible, generation::text AS generation, tombstoned, cleanup_pending,
       source_epoch, source_position::text AS source_position
FROM rating.classification_ballot_actor
WHERE route = :route::integer AND actor_id = :actor_id::uuid
FOR UPDATE;
