UPDATE community.realm
SET ownership_state = 'owned', orphaned_at = NULL, claim_eligible_at = NULL
WHERE route = :route::integer AND realm_id = :realm::uuid AND state = 'active'
  AND ownership_state = 'orphaned' AND orphaned_at = :orphaned::timestamptz
  AND claim_eligible_at = :eligible::timestamptz
RETURNING realm_id;
