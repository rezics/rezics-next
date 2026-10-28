WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id,
         :grant_role::text AS grant_role, :at::timestamptz AS at,
         :transaction_id::uuid AS transaction_id
), current_grant AS MATERIALIZED (
  -- The full temporal key and containment at T skip this key's closed history.
  SELECT g.valid
  FROM access.resource_role_grant g
  JOIN input i ON g.route = i.route AND g.resource_id = i.account_id
    AND g.subject_kind = 'identity' AND g.subject_id = i.account_id
    AND g.subject_role = '' AND g.grant_role = i.grant_role AND g.valid @> i.at
), inserted AS (
  INSERT INTO access.resource_role_grant
    (route, resource_id, subject_kind, subject_id, subject_role, grant_role, valid, transaction_id)
  SELECT route, account_id, 'identity', account_id, '', grant_role,
         tstzrange(at, NULL, '[)'), transaction_id
  FROM input
  WHERE NOT EXISTS (SELECT 1 FROM current_grant)
  RETURNING grant_role
)
SELECT CASE
  WHEN EXISTS (SELECT 1 FROM current_grant) THEN 'current'
  WHEN EXISTS (SELECT 1 FROM inserted) THEN 'inserted'
  ELSE 'absent'
END AS outcome;
