WITH reassigned AS (
  UPDATE library.label_assignment
  SET revision = revision + 1, slot_no = :slot_no,
      deleted_at = NULL, purge_after = NULL,
      updated_at = :time::timestamptz, transaction_id = :transaction_id
  WHERE route = :route AND account_id = :account_id AND subject_id = :subject_id
    AND label_id = :label_id AND :retained::boolean
    AND assignment_id = :assignment_id::uuid AND revision = :revision::integer
    AND slot_no IS NULL AND deleted_at = :deleted_at::timestamptz
    AND purge_after = :purge_after::timestamptz
  RETURNING *
), inserted AS (
  INSERT INTO library.label_assignment
    (route, account_id, subject_id, label_id, revision, slot_no, created_at, updated_at, transaction_id)
  SELECT :route, :account_id, :subject_id, :label_id, 1, :slot_no,
         :time::timestamptz, :time::timestamptz, :transaction_id
  WHERE NOT :retained::boolean
  RETURNING *
)
SELECT assignment_id AS id, label_id AS "labelId", subject_id AS "subjectId", revision,
       slot_no AS "slotNo", created_at::text AS "createdAt", updated_at::text AS "updatedAt",
       deleted_at::text AS "deletedAt", purge_after::text AS "purgeAfter"
FROM reassigned
UNION ALL
SELECT assignment_id AS id, label_id AS "labelId", subject_id AS "subjectId", revision,
       slot_no AS "slotNo", created_at::text AS "createdAt", updated_at::text AS "updatedAt",
       deleted_at::text AS "deletedAt", purge_after::text AS "purgeAfter"
FROM inserted;
