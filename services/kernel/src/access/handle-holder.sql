SELECT account_id AS "accountId", state
FROM access.handle_claim
WHERE route = :route AND normalized_handle = :handle
  AND (state = 'active' OR (state = 'reserved' AND reserved_until > :at::timestamptz));
