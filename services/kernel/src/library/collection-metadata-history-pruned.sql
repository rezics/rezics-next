WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :collection_id::uuid AS collection_id,
         :curator_account_id::uuid AS curator_account_id, :transaction_id::uuid AS transaction_id,
         :updated_at::timestamptz AS updated_at
), oldest_retained AS (
  SELECT min(history.revision) AS revision
  FROM library.collection_metadata_history AS history, input
  WHERE history.route = input.route AND history.collection_id = input.collection_id
)
UPDATE library.collection_metadata_history_state AS state
SET coverage = 'partial', known_from_revision = oldest_retained.revision,
    pruned_before_revision = oldest_retained.revision,
    transaction_id = input.transaction_id, updated_at = input.updated_at
FROM input, oldest_retained
WHERE state.route = input.route AND state.collection_id = input.collection_id
  AND state.curator_account_id = input.curator_account_id
RETURNING state.collection_id AS "collectionId";
