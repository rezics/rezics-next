WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id
)
SELECT
  -- Pending is the number observed in one bounded intent page, not an unbounded total.
  (SELECT count(*)::integer FROM (
    SELECT p.transaction_id FROM community.member_locator_pending p CROSS JOIN input i
    WHERE p.account_id = i.account_id
    ORDER BY p.route, p.realm_id, p.transaction_id LIMIT 50
  ) AS outstanding) AS pending,
  (SELECT l.realm_id::text FROM community.member_locator l CROSS JOIN input i
   WHERE l.route = i.route AND l.account_id = i.account_id ORDER BY l.realm_id LIMIT 1) AS first;
