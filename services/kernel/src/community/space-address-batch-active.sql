WITH wanted AS MATERIALIZED (
  SELECT route, address, space_id
  FROM unnest(:routes::integer[], :addresses::text[], :space_ids::uuid[]) AS input(route, address, space_id)
)
SELECT wanted.space_id AS requested_space_id, wanted.address,
       claim.space_id AS claimed_space_id
FROM wanted
JOIN community.space_address_claim claim
  ON claim.route = wanted.route
 AND claim.normalized_address = wanted.address
 AND claim.state = 'active';
