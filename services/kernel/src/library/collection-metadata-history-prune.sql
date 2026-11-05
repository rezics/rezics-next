WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :collection_id::uuid AS collection_id
), oldest_over_limit AS (
  SELECT history.revision
  FROM library.collection_metadata_history AS history CROSS JOIN input
  WHERE history.route = input.route AND history.collection_id = input.collection_id
  ORDER BY history.revision DESC
  OFFSET 128
  LIMIT 1
)
DELETE FROM library.collection_metadata_history AS history
USING input, oldest_over_limit
WHERE history.route = input.route AND history.collection_id = input.collection_id
  AND history.revision = oldest_over_limit.revision
RETURNING history.revision;
