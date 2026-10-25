WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :realm_id::uuid AS realm_id, :account_id::uuid AS account_id,
         :reservation_id::uuid AS reservation_id, :at::timestamptz AS at, :transaction_id::uuid AS transaction_id
)
INSERT INTO community.realm_member_terminal
  (route, realm_id, account_id, reservation_id, transaction_id, at)
SELECT i.route, i.realm_id, i.account_id, i.reservation_id, i.transaction_id, i.at
FROM input i
WHERE NOT EXISTS (
  SELECT 1 FROM community.realm_member m
  WHERE m.route = i.route AND m.realm_id = i.realm_id AND m.account_id = i.account_id
    AND m.reservation_id = i.reservation_id
)
ON CONFLICT (route, realm_id, account_id, reservation_id) DO NOTHING
RETURNING reservation_id::text AS "reservationId";
