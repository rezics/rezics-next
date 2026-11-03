INSERT INTO rating.classification_ballot_actor
  (route, actor_id, eligible, generation, tombstoned, cleanup_pending, source_epoch, source_position)
VALUES (:route::integer, :actor_id::uuid, :eligible::boolean, 1, :tombstoned::boolean, true,
        :source_epoch::integer, :source_position::bigint)
ON CONFLICT (route, actor_id) DO UPDATE
SET eligible = EXCLUDED.eligible AND NOT (rating.classification_ballot_actor.tombstoned OR EXCLUDED.tombstoned),
    generation = rating.classification_ballot_actor.generation + 1,
    tombstoned = rating.classification_ballot_actor.tombstoned OR EXCLUDED.tombstoned,
    cleanup_pending = true,
    source_epoch = EXCLUDED.source_epoch,
    source_position = EXCLUDED.source_position
WHERE (rating.classification_ballot_actor.source_epoch, rating.classification_ballot_actor.source_position)
    < (EXCLUDED.source_epoch, EXCLUDED.source_position)
RETURNING eligible, generation::text AS generation, tombstoned, cleanup_pending,
          source_epoch, source_position::text AS source_position;
