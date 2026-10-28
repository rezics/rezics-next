DELETE FROM library.entry_deleted
WHERE route = :route::integer
  AND account_id = :account_id::uuid
  AND deletion_id = :deletion_id::uuid
  AND restore_until = :expected_original_deadline::timestamptz
  AND restore_until <= :time::timestamptz
RETURNING true AS deleted;
