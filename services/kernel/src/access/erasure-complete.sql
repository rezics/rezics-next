WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id,
         :participants::text[] AS participants, :at::timestamptz AS at
)
UPDATE access.erasure e
SET completed_at = i.at
FROM input i
WHERE e.route = i.route AND e.account_id = i.account_id AND e.completed_at IS NULL
  AND e.workflow_until IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM access.erasure_late_item l
                  WHERE l.route = i.route AND l.account_id = i.account_id AND l.resolved_at IS NULL)
  AND (SELECT count(*) FROM access.erasure_acknowledgement
       WHERE route = i.route AND account_id = i.account_id
         AND participant = ANY(i.participants)) = cardinality(i.participants)
RETURNING completed_at::text;
