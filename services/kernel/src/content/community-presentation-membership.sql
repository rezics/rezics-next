WITH input AS NOT MATERIALIZED (
  SELECT k.route, k.id FROM jsonb_to_recordset(:keys::jsonb) AS k(route integer, id uuid)
)
SELECT i.id AS realm_id, m.reservation_id
FROM input i
CROSS JOIN LATERAL (
  SELECT m.reservation_id FROM community.realm_member m
  WHERE m.route = i.route AND m.realm_id = i.id AND m.account_id = :account_id::uuid
    AND upper_inf(m.valid) AND m.valid @> :at::timestamptz
  LIMIT 1
) m;
