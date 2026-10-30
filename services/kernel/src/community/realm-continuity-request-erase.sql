DELETE FROM community.realm_claim_request
WHERE route = :owner_route::integer AND realm_id = :owner_id::uuid AND request_id = :key::uuid
  AND account_id = :account_id::uuid AND requested_at = :due_at::timestamptz
RETURNING request_id;
