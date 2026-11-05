DELETE FROM library.builtin_state_reference_source
WHERE route = :route AND account_id = :account_id AND subject_id = :subject_id
  AND source_revision = :source_revision AND source_transaction_id = :source_transaction_id
RETURNING true AS removed;
