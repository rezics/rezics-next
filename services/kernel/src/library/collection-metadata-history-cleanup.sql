WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :collection_id::uuid AS collection_id
), changes AS (
  DELETE FROM library.collection_metadata_history AS history USING input
  WHERE history.route = input.route AND history.collection_id = input.collection_id
    AND history.revision IN (
      SELECT revision FROM library.collection_metadata_history
      WHERE route = input.route AND collection_id = input.collection_id
      ORDER BY revision ASC LIMIT 25
    )
  RETURNING true AS removed
), state AS (
  DELETE FROM library.collection_metadata_history_state AS history USING input
  WHERE history.route = input.route AND history.collection_id = input.collection_id
    AND NOT EXISTS (SELECT 1 FROM library.collection_metadata_history
                    WHERE route = input.route AND collection_id = input.collection_id)
  RETURNING true AS removed
)
SELECT removed FROM changes UNION ALL SELECT removed FROM state;
