UPDATE library.collection_metadata_history_state
SET coverage = 'partial',
    known_from_revision = (SELECT min(revision) FROM library.collection_metadata_history
                           WHERE route = :route AND collection_id = :collection_id),
    pruned_before_revision = (SELECT min(revision) FROM library.collection_metadata_history
                              WHERE route = :route AND collection_id = :collection_id),
    transaction_id = :transaction_id,
    updated_at = :updated_at
WHERE route = :route AND collection_id = :collection_id AND curator_account_id = :curator_account_id
RETURNING collection_id AS "collectionId";
