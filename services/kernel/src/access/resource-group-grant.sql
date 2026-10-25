-- Probe one open identity role grant through the partial key index, then check T.
-- An interval already open at T is kept.
WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :resource_id::uuid AS resource_id,
         :subject_id::uuid AS subject_id, :subject_role::text AS subject_role,
         :grant_role::text AS grant_role, :at::timestamptz AS at,
         :transaction_id::uuid AS transaction_id
), candidate AS MATERIALIZED (
  SELECT g.valid
  FROM access.resource_role_grant g
  JOIN input i
    ON g.route = i.route AND g.resource_id = i.resource_id
   AND g.subject_kind = 'identity' AND g.subject_id = i.subject_id
   AND g.subject_role = i.subject_role AND g.grant_role = i.grant_role
   AND upper_inf(g.valid)
), open_row AS (
  SELECT c.valid FROM candidate c, input i WHERE c.valid @> i.at
), inserted AS (
  INSERT INTO access.resource_role_grant
    (route, resource_id, subject_kind, subject_id, subject_role, grant_role, valid, transaction_id)
  SELECT route, resource_id, 'identity', subject_id, subject_role, grant_role,
         tstzrange(at, NULL, '[)'), transaction_id
  FROM input
  WHERE NOT EXISTS (SELECT 1 FROM open_row)
  RETURNING grant_role
)
SELECT CASE
  WHEN EXISTS (SELECT 1 FROM open_row) THEN 'open'
  WHEN EXISTS (SELECT 1 FROM inserted) THEN 'inserted'
  ELSE 'absent'
END AS outcome;
