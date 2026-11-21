SELECT EXISTS (
  SELECT 1 FROM (
    SELECT valid FROM access.resource_role_grant
    WHERE route = :route::integer AND resource_id = :resource_id::uuid
      AND subject_kind = 'identity' AND subject_id = :account_id::uuid AND subject_role = ''
      AND grant_role = :grant_role::text
      AND valid <= tstzrange(point.at, NULL, '[)')
    ORDER BY valid DESC
    LIMIT 1
  ) AS predecessor
  WHERE predecessor.valid @> point.at
) AS held
FROM (SELECT :at::timestamptz AS at) AS point;
