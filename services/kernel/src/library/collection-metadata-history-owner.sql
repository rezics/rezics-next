WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :collection_id::uuid AS collection_id,
         :curator_account_id::uuid AS curator_account_id, :revision::integer AS revision,
         :transaction_id::uuid AS transaction_id, :updated_at::timestamptz AS updated_at
), removed AS (
  DELETE FROM library.collection_metadata_history AS history USING input
  WHERE history.route = input.route AND history.collection_id = input.collection_id
    AND history.curator_account_id IS DISTINCT FROM input.curator_account_id
  RETURNING true AS removed
)
UPDATE library.collection_metadata_history_state AS state
SET curator_account_id = input.curator_account_id, coverage = 'unknown',
    known_from_revision = input.revision, pruned_before_revision = NULL,
    transaction_id = input.transaction_id, updated_at = input.updated_at
FROM input
WHERE state.route = input.route AND state.collection_id = input.collection_id
  AND state.curator_account_id IS DISTINCT FROM input.curator_account_id
RETURNING state.collection_id AS "collectionId";
