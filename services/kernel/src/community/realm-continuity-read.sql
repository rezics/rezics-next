WITH input AS NOT MATERIALIZED (SELECT :at::timestamptz AS at)
SELECT ownership_state, orphaned_at::text, claim_eligible_at::text,
       claim_eligible_at <= i.at AS claim_eligible
FROM community.realm CROSS JOIN input i
WHERE route = :route::integer AND realm_id = :id::uuid
  AND state = 'active' AND created_at <= i.at;
