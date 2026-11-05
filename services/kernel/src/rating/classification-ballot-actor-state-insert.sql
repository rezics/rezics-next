INSERT INTO rating.classification_ballot_actor
  (route, actor_id, eligible, generation, tombstoned, cleanup_pending, source_epoch, source_position)
VALUES (:route::integer, :actor_id::uuid, true, 1, false, false, 0, 0)
ON CONFLICT (route, actor_id) DO NOTHING
RETURNING eligible, generation::text AS generation, tombstoned, cleanup_pending,
          source_epoch, source_position::text AS source_position;
