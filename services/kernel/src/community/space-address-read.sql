SELECT space_id AS "spaceId", state
FROM community.space_address_claim
WHERE route = :route AND normalized_address = :address AND state = 'active';
