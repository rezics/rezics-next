-- Lock the native identity before inspecting its current decision. The materialized
-- row is also the current head anchor; no historical ownership or membership scan.
WITH input AS NOT MATERIALIZED (SELECT :at::timestamptz AS at), identity AS MATERIALIZED (
  SELECT * FROM community.realm
  WHERE route = :route::integer AND realm_id = :id::uuid
  FOR UPDATE
)
SELECT h.ownership_state, h.orphaned_at::text, h.claim_eligible_at::text,
       h.claim_eligible_at <= i.at AS claim_eligible
FROM identity h CROSS JOIN input i
JOIN community.realm_revision r ON r.route = h.route AND r.realm_id = h.realm_id
  AND r.revision_id = h.head_revision_id
WHERE h.state = 'active' AND h.created_at <= i.at AND r.created_at <= i.at;
