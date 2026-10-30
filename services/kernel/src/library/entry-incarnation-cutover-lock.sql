SELECT subject_id
FROM library.entry
WHERE route = :route AND account_id = :account_id AND subject_id = :subject_id
  AND revision = :revision AND transaction_id = :transaction_id
  AND xmin::text = :version::text AND incarnation_id IS NULL
FOR UPDATE;
