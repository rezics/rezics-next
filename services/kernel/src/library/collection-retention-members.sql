WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :collection_id::uuid AS collection_id
), keys AS MATERIALIZED (
  SELECT member_id FROM library.collection_member AS child CROSS JOIN input
  WHERE child.route = input.route AND child.collection_id = input.collection_id
  ORDER BY member_id LIMIT 64
)
DELETE FROM library.collection_member AS victim USING keys, input
WHERE victim.route = input.route AND victim.collection_id = input.collection_id
  AND victim.member_id = keys.member_id
RETURNING true AS removed;
