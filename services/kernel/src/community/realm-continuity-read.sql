SELECT ownership_state, orphaned_at::text, claim_eligible_at::text,
       claim_eligible_at <= :at::timestamptz AS claim_eligible
FROM community.realm
WHERE route = :route::integer AND realm_id = :id::uuid
  AND state = 'active' AND created_at <= :at::timestamptz;
