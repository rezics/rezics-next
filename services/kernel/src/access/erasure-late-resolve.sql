WITH existing AS MATERIALIZED (
  SELECT route, account_id, participant, locator, resolved_at
  FROM access.erasure_late_item
  WHERE route = :route::integer AND account_id = :account_id::uuid
    AND participant = :participant::text AND locator = :locator::text
  FOR UPDATE
), updated AS (
  UPDATE access.erasure_late_item l SET resolved_at = :at::timestamptz
  FROM existing e
  WHERE (l.route, l.account_id, l.participant, l.locator) = (e.route, e.account_id, e.participant, e.locator)
    AND e.resolved_at IS NULL
  RETURNING true AS changed
)
SELECT changed FROM updated
UNION ALL SELECT false FROM existing WHERE resolved_at IS NOT NULL;
