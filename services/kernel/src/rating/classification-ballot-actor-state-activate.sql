UPDATE rating.classification_ballot_actor
SET eligible = true, generation = generation + 1, cleanup_pending = true
WHERE route = :route::integer AND actor_id = :actor_id::uuid
  AND NOT eligible AND NOT tombstoned
RETURNING eligible, generation::text AS generation, tombstoned, cleanup_pending,
          source_epoch, source_position::text AS source_position;
