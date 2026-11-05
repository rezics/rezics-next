INSERT INTO library.collection_metadata_history_state
  (route, collection_id, curator_account_id, coverage, known_from_revision, transaction_id, updated_at)
VALUES
  (:route, :collection_id, :curator_account_id, 'complete', 1, :transaction_id, :updated_at)
ON CONFLICT (route, collection_id) DO NOTHING
RETURNING collection_id AS "collectionId";
