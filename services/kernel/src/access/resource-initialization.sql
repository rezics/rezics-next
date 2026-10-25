WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :resource_id::uuid AS resource_id, :resource_type::text AS resource_type,
         :creator_id::uuid AS creator_id, :at::timestamptz AS at
), initialized AS (
  INSERT INTO access.resource_initialization (route, resource_id, resource_type, creator_id, initialized_at)
  SELECT route, resource_id, resource_type, creator_id, at FROM input
  RETURNING route, resource_id
)
INSERT INTO access.resource_role_grant
  (route, resource_id, subject_kind, subject_id, subject_role, grant_role, valid, transaction_id)
SELECT i.route, i.resource_id, r.subject_kind, r.subject_id, '', r.grant_role,
       tstzrange(i.at, NULL, '[)'), :transaction_id
FROM input i JOIN initialized n ON n.route = i.route AND n.resource_id = i.resource_id
CROSS JOIN jsonb_to_recordset(:grants::jsonb) AS r(subject_kind text, subject_id uuid, grant_role text)
RETURNING grant_role;
