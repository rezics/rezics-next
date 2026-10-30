WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :collection_id::uuid AS collection_id, :account_id::uuid AS account_id
), reference AS (
  DELETE FROM library.builtin_collection_reference AS victim USING input
  WHERE victim.route = input.route AND victim.collection_id = input.collection_id
  RETURNING true AS removed
), pins AS (
  UPDATE library.collection_pins
  SET collection_ids = array_remove(collection_ids, input.collection_id), revision = revision + 1
  FROM input
  WHERE library.collection_pins.route = input.route AND library.collection_pins.account_id = input.account_id
    AND input.collection_id = ANY(collection_ids)
  RETURNING true AS removed
)
SELECT removed FROM reference UNION ALL SELECT removed FROM pins;
