SELECT zone_id AS id FROM zones.zone
WHERE route = :route::integer AND owner_id = :owner_id::uuid AND state = :state::text
  AND zone_id > :after::uuid
ORDER BY zone_id LIMIT :limit::integer;
