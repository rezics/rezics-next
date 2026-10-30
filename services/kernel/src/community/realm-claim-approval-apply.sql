UPDATE community.realm_claim_request
SET state = 'approved', approved_at = :at::timestamptz
WHERE route = :route::integer AND realm_id = :realm::uuid AND request_id = :request::uuid
  AND account_id = :account::uuid AND orphaned_at = :orphaned::timestamptz
  AND requested_at = :requested::timestamptz AND state = 'pending'
RETURNING approved_at::text;
