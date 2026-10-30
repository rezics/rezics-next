SELECT request_id, state, orphaned_at::text, requested_at::text, approved_at::text,
       orphaned_at = :orphaned::timestamptz AS current_episode
FROM community.realm_claim_request
WHERE route = :route::integer AND realm_id = :realm::uuid
  AND orphaned_at = :orphaned::timestamptz AND account_id = :account::uuid;
