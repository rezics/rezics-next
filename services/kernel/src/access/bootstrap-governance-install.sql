WITH marker AS (
  INSERT INTO access.governance_bootstrap (route, resource_id, account_id, transaction_id)
  VALUES (:route::integer, :resource_id::uuid, :account_id::uuid, :transaction_id::uuid)
  RETURNING route, resource_id, account_id, transaction_id
)
INSERT INTO access.resource_role_grant
  (route, resource_id, subject_kind, subject_id, subject_role, grant_role, valid, transaction_id)
SELECT route, resource_id, 'identity', account_id, '', :role::text, '(,)'::tstzrange, transaction_id
FROM marker
RETURNING grant_role;
