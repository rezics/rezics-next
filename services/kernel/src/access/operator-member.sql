SELECT m.role, m.valid::text AS valid
FROM access.organization_member m
WHERE m.route = :route AND m.organization_id = :organization_id AND m.member_account_id = :human_id
  AND m.valid @> :at::timestamptz;
