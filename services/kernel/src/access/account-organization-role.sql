SELECT role
FROM access.organization_member
WHERE route = :route AND organization_id = :organization_id
  AND member_account_id = :member_account_id AND valid @> :at::timestamptz
LIMIT 1;
