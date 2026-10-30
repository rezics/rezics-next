WITH input AS NOT MATERIALIZED (SELECT :orphaned::timestamptz AS orphaned)
SELECT c.request_id, c.state, c.orphaned_at::text, c.requested_at::text, c.approved_at::text,
       COALESCE(c.orphaned_at = i.orphaned, false) AS current_episode
FROM community.realm_claim_request c CROSS JOIN input i
WHERE c.route = :route::integer AND c.realm_id = :realm::uuid
  AND c.orphaned_at = i.orphaned AND c.account_id = :account::uuid
LIMIT 1;
