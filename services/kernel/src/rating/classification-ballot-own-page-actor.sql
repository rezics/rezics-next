SELECT eligible, generation::text AS generation, tombstoned, cleanup_pending AS "cleanupPending"
FROM rating.classification_ballot_actor
WHERE route = :route::integer AND actor_id = :actor_id::uuid;
