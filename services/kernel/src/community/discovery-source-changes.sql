SELECT realm_epoch::text, generation::text, previous_generation::text, transaction_id, value
FROM community.realm_discovery_change
WHERE route = :route::integer AND realm_id = :realm_id::uuid
  AND generation > :after_generation::bigint
ORDER BY generation ASC LIMIT :limit::integer;
