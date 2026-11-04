SELECT coverage, known_from_revision AS "knownFromRevision", pruned_before_revision AS "prunedBeforeRevision"
FROM library.collection_metadata_history_state
WHERE route = :route AND collection_id = :collection_id AND curator_account_id = :curator_account_id;
