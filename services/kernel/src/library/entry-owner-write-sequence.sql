UPDATE library.entry
SET owner_write_seq = :seq::bigint
WHERE route = :route AND account_id = :account_id AND subject_id = :subject_id
  AND revision = :revision AND transaction_id = :transaction_id
  AND :seq::bigint > 0 AND (owner_write_seq IS NULL OR (owner_write_seq > 0 AND owner_write_seq < :seq::bigint))
RETURNING subject_id;
