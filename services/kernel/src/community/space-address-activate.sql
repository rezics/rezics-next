WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :address::text AS address, :space_id::uuid AS space_id,
         :reservation_id::uuid AS reservation_id, :at::timestamptz AS at,
         :transaction_id::uuid AS transaction_id
), changed AS (
  UPDATE community.space_address_claim c
  SET state = 'active', expires_at = NULL, reserved_until = NULL, transaction_id = i.transaction_id
  FROM input i
  WHERE c.route = i.route AND c.normalized_address = i.address
    AND c.space_id = i.space_id AND c.state = 'pending'
    AND c.reservation_id = i.reservation_id AND c.expires_at > i.at
  RETURNING c.space_id
)
SELECT space_id AS "spaceId" FROM changed
UNION ALL
SELECT c.space_id AS "spaceId"
FROM community.space_address_claim c, input i
WHERE c.route = i.route AND c.normalized_address = i.address
  AND c.space_id = i.space_id AND c.state = 'active'
  AND NOT EXISTS (SELECT 1 FROM changed);
