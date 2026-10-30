-- Exact current Zone keys only; source configuration and history are never read.
SELECT z.zone_id::text AS id, z.owner_id::text AS "ownerId",
       z.visibility <> 'private' AS public
FROM unnest(:routes::integer[], :ids::uuid[]) AS wanted(route, id)
JOIN LATERAL (
  SELECT zone_id, owner_id, visibility
  FROM zones.zone
  WHERE route = wanted.route AND zone_id = wanted.id
    AND state = 'active' AND configuration IS NOT NULL
    AND NOT (withholding ? '')
  LIMIT 1
) z ON true;
