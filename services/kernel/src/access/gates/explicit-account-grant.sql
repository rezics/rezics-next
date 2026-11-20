-- unbound: Global Context, one direct account grant by its full temporal key.
SELECT EXISTS (
  SELECT 1 FROM access.resource_grant
  WHERE route = 0 AND resource_id = :resource_id::uuid
    AND subject_kind = 'identity' AND subject_id = :account_id::uuid AND subject_role = ''
    AND action = :action AND valid @> COALESCE(:at::timestamptz, statement_timestamp())
) AS granted;
