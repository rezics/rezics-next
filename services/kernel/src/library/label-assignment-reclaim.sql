UPDATE library.label_assignment
SET revision = revision + 1, slot_no = NULL,
    deleted_at = :deleted_at::timestamptz, purge_after = :purge_after::timestamptz,
    updated_at = :time::timestamptz, transaction_id = :transaction_id
WHERE route = :route AND account_id = :account_id AND subject_id = :subject_id
  AND label_id = :label_id AND assignment_id = :assignment_id AND revision = :revision
  AND slot_no = :slot_no AND deleted_at IS NULL
RETURNING assignment_id;
