WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :realm_id::uuid AS realm_id, :account_id::uuid AS account_id,
         :reservation_id::uuid AS reservation_id, :at::timestamptz AS at, :transaction_id::uuid AS transaction_id
)
INSERT INTO community.realm_member
  (route, realm_id, account_id, role, valid, reservation_id, transaction_id)
SELECT i.route, i.realm_id, i.account_id, 'member', tstzrange(i.at, NULL, '[)'), i.reservation_id, i.transaction_id
FROM input i
WHERE NOT EXISTS (
  SELECT 1 FROM community.realm_member m
  WHERE m.route = i.route AND m.realm_id = i.realm_id AND m.account_id = i.account_id AND m.valid @> i.at
) AND NOT EXISTS (
  SELECT 1 FROM community.realm_member_terminal t
  WHERE t.route = i.route AND t.realm_id = i.realm_id AND t.account_id = i.account_id
    AND t.reservation_id = i.reservation_id
)
RETURNING reservation_id::text AS "reservationId";
