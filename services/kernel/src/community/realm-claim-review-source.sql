WITH input AS NOT MATERIALIZED (SELECT :at::timestamptz AS at)
SELECT h.head_revision_id::text, h.lifecycle_version::text, h.discovery_epoch::text,
       h.orphaned_at::text, h.claim_eligible_at::text
FROM community.realm h CROSS JOIN input i
JOIN community.realm_revision r ON r.route = h.route AND r.realm_id = h.realm_id
  AND r.revision_id = h.head_revision_id
WHERE h.route = :route::integer AND h.realm_id = :realm::uuid
  AND h.state = 'active' AND h.ownership_state = 'orphaned'
  AND h.created_at <= i.at AND r.created_at <= i.at
  AND h.claim_eligible_at = h.orphaned_at + interval '720 hours'
  AND h.claim_eligible_at <= i.at;
