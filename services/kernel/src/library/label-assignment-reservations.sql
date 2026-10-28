WITH reserved AS MATERIALIZED (
  SELECT assignment_id AS id, label_id AS "labelId", subject_id AS "subjectId", revision,
         slot_no AS "slotNo", created_at::text AS "createdAt", updated_at::text AS "updatedAt",
         deleted_at::text AS "deletedAt", purge_after::text AS "purgeAfter"
  FROM library.label_assignment
  WHERE route = :route AND account_id = :account_id AND subject_id = :subject_id
    AND slot_no IS NOT NULL
  ORDER BY assignment_id
  LIMIT 32
)
SELECT * FROM reserved
UNION ALL
SELECT assignment_id AS id, label_id AS "labelId", subject_id AS "subjectId", revision,
       slot_no AS "slotNo", created_at::text AS "createdAt", updated_at::text AS "updatedAt",
       deleted_at::text AS "deletedAt", purge_after::text AS "purgeAfter"
FROM library.label_assignment
WHERE route = :route AND account_id = :account_id AND subject_id = :subject_id
  AND label_id = :label_id AND slot_no IS NULL;
