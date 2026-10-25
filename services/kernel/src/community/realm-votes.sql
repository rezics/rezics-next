-- One primary-key read of community.realm for each requested Realm in this partition.
-- The route range binds the statement to the partition; equality on (route, realm_id) is the primary key.
WITH input AS NOT MATERIALIZED (
  SELECT :partition::integer AS partition
),
requested AS MATERIALIZED (
  SELECT record.route, record.realm_id
  FROM jsonb_to_recordset(:realms::jsonb) AS record(route integer, realm_id uuid)
  CROSS JOIN input
  WHERE record.route >= input.partition * 16
    AND record.route < (input.partition + 1) * 16
)
SELECT realm.realm_id::text AS realm_id, realm.votes
FROM requested
CROSS JOIN input
JOIN LATERAL (
  SELECT stored.realm_id, stored.votes
  FROM community.realm AS stored
  WHERE stored.route = requested.route
    AND stored.realm_id = requested.realm_id
    AND stored.state = 'active'
    AND stored.route >= input.partition * 16
    AND stored.route < (input.partition + 1) * 16
  LIMIT 1
) AS realm ON true;
