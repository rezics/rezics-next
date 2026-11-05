WITH input AS (
  SELECT :route::integer AS route, :zone_id::uuid AS zone_id,
         :store::text AS store, :keys::bigint[] AS keys
), resource_rows AS (
  DELETE FROM access.resource_grant g USING input i
  WHERE i.store = 'resource_grant' AND g.route = i.route AND g.resource_id = i.zone_id
    AND g.erasure_key = ANY(i.keys)
  RETURNING 1
), role_rows AS (
  DELETE FROM access.resource_role_grant g USING input i
  WHERE i.store = 'resource_role_grant' AND g.route = i.route AND g.resource_id = i.zone_id
    AND g.erasure_key = ANY(i.keys)
  RETURNING 1
)
SELECT ((SELECT count(*) FROM resource_rows) + (SELECT count(*) FROM role_rows))::integer AS removed;
