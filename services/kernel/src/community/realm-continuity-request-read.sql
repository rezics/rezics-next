SELECT request_id, requested_at::text
FROM community.realm_claim_request
WHERE route = :route::integer AND realm_id = :realm::uuid
  AND orphaned_at = :orphaned::timestamptz AND account_id = :account::uuid;
