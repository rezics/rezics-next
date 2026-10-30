SELECT request_id, state, orphaned_at::text, requested_at::text, approved_at::text,
       COALESCE(orphaned_at = :orphaned::nullable(timestamptz), false) AS current_episode
FROM community.realm_claim_request
WHERE route = :route::integer AND realm_id = :realm::uuid AND request_id = :request::uuid
  AND account_id = :account::uuid;
