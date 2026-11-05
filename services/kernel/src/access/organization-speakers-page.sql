-- Seek past each actor, including all of its other current assignments.
WITH RECURSIVE input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :principal_id::uuid AS principal_id, :at::timestamptz AS at
), speakers AS (
  (SELECT assigned_actor_id, 1 AS ordinal
   FROM access.principal_assignment p CROSS JOIN input i
   WHERE p.route = i.route AND p.principal_id = i.principal_id
     AND revoked_at IS NULL AND assigned_actor_id > :after::uuid
     AND COALESCE(lower(valid), '-infinity'::timestamptz) <= i.at
     AND valid @> i.at
   ORDER BY assigned_actor_id LIMIT 1)
  UNION ALL
  SELECT next.assigned_actor_id, speakers.ordinal + 1
  FROM speakers CROSS JOIN input i
  CROSS JOIN LATERAL (
    SELECT assigned_actor_id
    FROM access.principal_assignment
    WHERE route = i.route AND principal_id = i.principal_id
      AND revoked_at IS NULL AND assigned_actor_id > speakers.assigned_actor_id
      AND COALESCE(lower(valid), '-infinity'::timestamptz) <= i.at
      AND valid @> i.at
    ORDER BY assigned_actor_id LIMIT 1
  ) next
  WHERE speakers.ordinal < :limit::integer
)
SELECT assigned_actor_id::text AS id FROM speakers ORDER BY ordinal;
