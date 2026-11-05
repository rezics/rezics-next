WITH input AS NOT MATERIALIZED (
  SELECT :state::text AS state, :orphaned::nullable(timestamptz) AS orphaned,
    :eligible::nullable(timestamptz) AS eligible, :original_state::text AS original_state,
    :original_orphaned::nullable(timestamptz) AS original_orphaned,
    :original_eligible::nullable(timestamptz) AS original_eligible
)
UPDATE community.realm h
SET ownership_state = i.state, orphaned_at = i.orphaned, claim_eligible_at = i.eligible
FROM input i
WHERE h.route = :route::integer AND h.realm_id = :realm::uuid
  AND h.ownership_state = i.original_state
  AND h.orphaned_at IS NOT DISTINCT FROM i.original_orphaned
  AND h.claim_eligible_at IS NOT DISTINCT FROM i.original_eligible
  AND ((i.state = 'owned' AND i.orphaned IS NULL AND i.eligible IS NULL)
    OR (i.state = 'orphaned' AND isfinite(i.orphaned)
      AND i.eligible = i.orphaned + interval '720 hours'
      AND (i.original_state <> 'orphaned'
        OR (i.orphaned = i.original_orphaned AND i.eligible = i.original_eligible))))
RETURNING h.ownership_state, h.orphaned_at::text, h.claim_eligible_at::text;
