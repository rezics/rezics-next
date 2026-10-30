UPDATE library.copy
SET deletion_id = NULL, deleted_at = NULL, restore_until = NULL,
    revision = revision + 1, transaction_id = :transaction_id::uuid
WHERE route = :route::integer AND account_id = :account_id::uuid AND copy_id = :copy_id::uuid
  AND deletion_id = :deletion_id::uuid AND revision = :revision::integer
  AND :time::timestamptz < restore_until
RETURNING copy_id AS id;
