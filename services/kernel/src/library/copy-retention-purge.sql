-- Exact ordinary due CAS: retained values never leave this transaction.
DELETE FROM library.copy
WHERE route = :route::integer AND copy_id = :copy_id::uuid AND account_id = :account_id::uuid
  AND deletion_id = :deletion_id::uuid AND revision = :revision::integer
  AND restore_until = :restore_until::timestamptz AND restore_until <= :time::timestamptz
RETURNING true AS removed;
