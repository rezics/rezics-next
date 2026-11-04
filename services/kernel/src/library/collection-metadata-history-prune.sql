WITH oldest_over_limit AS (
  SELECT revision
  FROM library.collection_metadata_history
  WHERE route = :route AND collection_id = :collection_id
  ORDER BY revision DESC
  OFFSET 128
  LIMIT 1
)
DELETE FROM library.collection_metadata_history AS history
USING oldest_over_limit
WHERE history.route = :route AND history.collection_id = :collection_id
  AND history.revision = oldest_over_limit.revision
RETURNING history.revision;
