SELECT r.head_revision_id::text, r.lifecycle_version::text, r.discovery_epoch::text,
       r.ownership_state, r.orphaned_at::text AS realm_orphaned_at,
       r.claim_eligible_at::text AS realm_claim_eligible_at,
       c.request_id::text, c.account_id::text, c.state,
       c.orphaned_at::text AS request_orphaned_at, c.requested_at::text, c.approved_at::text,
       (c.orphaned_at + interval '720 hours')::text AS request_claim_eligible_at,
       COALESCE(r.ownership_state = 'orphaned' AND c.orphaned_at = r.orphaned_at, false) AS current_episode,
       COALESCE(c.requested_at >= c.orphaned_at + interval '720 hours'
         AND c.requested_at <= :at::timestamptz, false) AS current_request
FROM community.realm r
JOIN community.realm_revision h ON h.route = r.route AND h.realm_id = r.realm_id
  AND h.revision_id = r.head_revision_id
LEFT JOIN community.realm_claim_request c ON c.route = r.route AND c.realm_id = r.realm_id
  AND c.request_id = :request::uuid
WHERE r.route = :route::integer AND r.realm_id = :realm::uuid AND r.state = 'active'
LIMIT 1;
