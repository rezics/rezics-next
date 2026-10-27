SELECT m.role
FROM access.organization_member m
JOIN access.account a ON a.route = m.route AND a.account_id = m.organization_id
WHERE m.route = :route AND m.organization_id = :organization_id
  AND a.kind = 'organization' AND a.state = 'active' AND NOT a.authn_fenced
  AND m.member_account_id = :member_account_id AND m.valid @> :at::timestamptz
LIMIT 1;
