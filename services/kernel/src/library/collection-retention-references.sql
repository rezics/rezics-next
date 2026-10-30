WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :collection_id::uuid AS collection_id
), keys AS MATERIALIZED (
  SELECT child.account_id, child.subject_id FROM library.builtin_state_reference_source AS child CROSS JOIN input
  WHERE child.route = input.route AND child.collection_id = input.collection_id
  ORDER BY subject_id LIMIT 64
)
DELETE FROM library.builtin_state_reference_source AS victim USING keys, input
WHERE victim.route = input.route AND victim.collection_id = input.collection_id
  AND victim.account_id = keys.account_id AND victim.subject_id = keys.subject_id
RETURNING true AS removed;
