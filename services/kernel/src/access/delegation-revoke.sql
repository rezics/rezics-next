UPDATE access.principal_assignment p
SET revoked_at = transaction_timestamp(), valid = p.valid * tstzrange(NULL, transaction_timestamp(), '[)')
FROM access.account a
WHERE p.route = :route AND p.principal_id = :principal_id AND p.request_id = :request_id
  AND p.revoked_at IS NULL AND a.route = p.route AND a.account_id = p.principal_id
  AND a.kind = 'actor' AND a.state = 'active' AND NOT a.authn_fenced AND a.minimum_authn_epoch <= :authn_epoch
RETURNING p.request_id;
