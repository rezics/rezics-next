WITH input AS NOT MATERIALIZED (SELECT :time::timestamptz AS time)
UPDATE library.label_assignment
SET slot_no = NULL, deleted_at = input.time,
    purge_after = input.time + interval '720 hours',
    revision = revision + 1, updated_at = input.time, transaction_id = :transaction_id::uuid
FROM input
WHERE route = :route AND account_id = :account_id AND subject_id = :subject_id AND label_id = :label_id
  AND assignment_id = :assignment_id::uuid AND revision = :revision::integer
  AND revision < 2147483647 AND deleted_at IS NULL
RETURNING route, account_id AS "accountId", subject_id AS "subjectId", label_id AS "labelId",
          assignment_id AS id, revision, slot_no AS "slotNo",
          created_at::text AS "createdAt", updated_at::text AS "updatedAt",
          deleted_at::text AS "deletedAt", purge_after::text AS "purgeAfter", transaction_id AS "transactionId";
