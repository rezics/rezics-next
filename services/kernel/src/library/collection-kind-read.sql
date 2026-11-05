SELECT account_id AS "accountId", generation::text, source_generation::text AS "sourceGeneration",
       capture, frontier, after_subject::text AS "afterSubject", version::text, complete, winner
FROM library.collection_kind_observation
WHERE route=:route::integer AND collection_id=:collection_id::uuid AND audience=:audience::text
LIMIT 1;
