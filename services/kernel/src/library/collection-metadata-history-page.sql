SELECT revision, transaction_id AS "transactionId", recorded_at AS "recordedAt", changed_fields AS "changedFields"
FROM library.collection_metadata_history
WHERE route = :route AND collection_id = :collection_id AND curator_account_id = :curator_account_id
  AND (:after_revision::integer IS NULL OR revision < :after_revision::integer)
ORDER BY revision DESC
LIMIT :page_limit;
