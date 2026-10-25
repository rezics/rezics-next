WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :address::text AS address, :space_id::uuid AS space_id,
         :expires_at::timestamptz AS expires_at, :reservation_id::uuid AS reservation_id,
         :transaction_id::uuid AS transaction_id, :at::timestamptz AS at
)
INSERT INTO community.space_address_claim
  (route, normalized_address, space_id, state, expires_at, reserved_until, reservation_id, transaction_id)
SELECT i.route, i.address, i.space_id, 'pending', i.expires_at, NULL, i.reservation_id, i.transaction_id
FROM input i
ON CONFLICT (route, normalized_address) DO UPDATE
SET space_id = CASE WHEN community.space_address_claim.state = 'active'
                    THEN community.space_address_claim.space_id ELSE EXCLUDED.space_id END,
    state = CASE WHEN community.space_address_claim.state = 'active'
                 THEN community.space_address_claim.state ELSE 'pending' END,
    expires_at = CASE WHEN community.space_address_claim.state = 'active'
                      THEN community.space_address_claim.expires_at ELSE EXCLUDED.expires_at END,
    reserved_until = CASE WHEN community.space_address_claim.state = 'active'
                          THEN community.space_address_claim.reserved_until ELSE NULL END,
    reservation_id = CASE WHEN community.space_address_claim.state = 'active'
                          THEN community.space_address_claim.reservation_id ELSE EXCLUDED.reservation_id END,
    transaction_id = CASE WHEN community.space_address_claim.state = 'active'
                          THEN community.space_address_claim.transaction_id ELSE EXCLUDED.transaction_id END
WHERE (community.space_address_claim.state = 'pending'
         AND community.space_address_claim.expires_at <= (SELECT at FROM input))
   OR (community.space_address_claim.state = 'pending'
         AND community.space_address_claim.space_id = EXCLUDED.space_id
         AND community.space_address_claim.reservation_id = EXCLUDED.reservation_id)
   OR (community.space_address_claim.state = 'reserved'
         AND community.space_address_claim.space_id = EXCLUDED.space_id)
   OR (community.space_address_claim.state = 'reserved'
         AND community.space_address_claim.reserved_until <= (SELECT at FROM input))
   OR (community.space_address_claim.state = 'active'
         AND community.space_address_claim.space_id = EXCLUDED.space_id)
RETURNING space_id AS "spaceId", state, reservation_id AS "reservationId";
