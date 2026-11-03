UPDATE rating.classification_ballot_actor
SET cleanup_pending = false
WHERE route = :route::integer AND actor_id = :actor_id::uuid
  AND generation = :generation::bigint
RETURNING actor_id;
