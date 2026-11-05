WITH input AS NOT MATERIALIZED (SELECT :at::timestamptz AS at), identity AS MATERIALIZED (
  SELECT * FROM community.realm
  WHERE route = :route::integer AND realm_id = :realm::uuid FOR UPDATE
)
SELECT h.ownership_state, h.orphaned_at::text, h.claim_eligible_at::text,
       h.state = 'active' AND h.created_at <= i.at
         AND r.created_at <= i.at AS active,
       h.claim_eligible_at = h.orphaned_at + interval '720 hours'
         AND h.claim_eligible_at <= i.at AS eligible
FROM identity h CROSS JOIN input i
JOIN community.realm_revision r ON r.route = h.route AND r.realm_id = h.realm_id
  AND r.revision_id = h.head_revision_id;
