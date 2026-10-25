WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :resource_id::uuid AS resource_id,
         :subject_kind::text AS subject_kind, :subject_id::uuid AS subject_id, :subject_role::text AS subject_role,
         :grant_role::text AS grant_role, :valid::tstzrange AS valid, :operation::text AS operation,
         :previous_role::text AS previous_role, :previous_valid::tstzrange AS previous_valid
), removed AS (
  DELETE FROM access.resource_role_grant g USING input i
  WHERE i.operation <> 'create' AND g.route = i.route AND g.resource_id = i.resource_id
    AND g.subject_kind = i.subject_kind AND g.subject_id = i.subject_id AND g.subject_role = i.subject_role
    AND g.grant_role = i.previous_role AND g.valid = i.previous_valid
  RETURNING g.grant_role
), inserted AS (
  INSERT INTO access.resource_role_grant
    (route, resource_id, subject_kind, subject_id, subject_role, grant_role, valid, transaction_id)
  SELECT route, resource_id, subject_kind, subject_id, subject_role, grant_role, valid, :transaction_id
  FROM input i WHERE i.operation <> 'revoke' AND (i.operation = 'create' OR (SELECT count(*) FROM removed) = 1)
  RETURNING grant_role
)
SELECT grant_role FROM inserted
UNION ALL SELECT grant_role FROM removed WHERE (SELECT operation FROM input) = 'revoke';
