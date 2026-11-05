SELECT m.role, m.valid::text AS valid
FROM access.organization_member m
JOIN access.account a ON a.route = m.route AND a.account_id = m.organization_id
  AND a.kind = 'organization' AND a.state = 'active' AND NOT a.authn_fenced
WHERE m.route = :route AND m.organization_id = :organization_id AND m.member_account_id = :human_id
  AND m.valid @> :at::timestamptz;
