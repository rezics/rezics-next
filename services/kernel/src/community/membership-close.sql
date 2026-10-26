-- Close and terminal share one snapshot. Update and delete touch disjoint rows:
-- a same-T interval would become empty, so it is removed instead of truncated.
WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :realm_id::uuid AS realm_id, :account_id::uuid AS account_id,
         :reservation_id::uuid AS reservation_id, :at::timestamptz AS at, :transaction_id::uuid AS transaction_id
), closed AS (
  UPDATE community.realm_member m
  SET valid = tstzrange(lower(m.valid), i.at, '[)'), transaction_id = i.transaction_id
  FROM input i
  WHERE m.route = i.route AND m.realm_id = i.realm_id AND m.account_id = i.account_id
    AND m.reservation_id = i.reservation_id AND m.role = 'member' AND m.valid @> i.at
    AND (lower_inf(m.valid) OR lower(m.valid) < i.at)
  RETURNING m.route, m.realm_id, m.account_id, m.reservation_id
), removed AS (
  DELETE FROM community.realm_member m
  USING input i
  WHERE m.route = i.route AND m.realm_id = i.realm_id AND m.account_id = i.account_id
    AND m.reservation_id = i.reservation_id AND m.role = 'member' AND m.valid @> i.at
    AND NOT lower_inf(m.valid) AND lower(m.valid) >= i.at
  RETURNING m.route, m.realm_id, m.account_id, m.reservation_id
), changed AS (
  SELECT * FROM closed
  UNION ALL
  SELECT * FROM removed
)
INSERT INTO community.realm_member_terminal
  (route, realm_id, account_id, reservation_id, transaction_id, at)
SELECT i.route, c.realm_id, c.account_id, c.reservation_id, i.transaction_id, i.at
FROM changed c
CROSS JOIN input i
ON CONFLICT (route, realm_id, account_id, reservation_id) DO NOTHING
RETURNING reservation_id::text AS "reservationId";
