UPDATE library.entry
SET incarnation_id = :incarnation_id::uuid
WHERE route = :route AND account_id = :account_id AND subject_id = :subject_id
  AND revision = :revision AND transaction_id = :transaction_id AND incarnation_id IS NULL
RETURNING incarnation_id AS "incarnationId";
