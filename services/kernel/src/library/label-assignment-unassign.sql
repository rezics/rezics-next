WITH input AS MATERIALIZED (
  SELECT :time::timestamptz AS time, :transaction_id::uuid AS transaction_id,
         :route::integer AS route, :account_id::uuid AS account_id,
         :subject_id::uuid AS subject_id, :label_id::uuid AS label_id,
         :assignment_id::uuid AS assignment_id, :revision::integer AS revision
)
UPDATE library.label_assignment AS a
SET slot_no = NULL, deleted_at = input.time,
    purge_after = input.time + interval '720 hours',
    revision = a.revision + 1, updated_at = input.time, transaction_id = input.transaction_id
FROM input
WHERE a.route = input.route AND a.account_id = input.account_id AND a.subject_id = input.subject_id
  AND a.label_id = input.label_id
  AND ROW(a.route, a.account_id, a.assignment_id)
        >= ROW(input.route, input.account_id, input.assignment_id)
  AND ROW(a.route, a.account_id, a.assignment_id)
        <= ROW(input.route, input.account_id, input.assignment_id)
  AND a.assignment_id = input.assignment_id AND a.revision = input.revision
  AND a.revision < 2147483647 AND a.deleted_at IS NULL
RETURNING a.route, a.account_id AS "accountId", a.subject_id AS "subjectId", a.label_id AS "labelId",
          a.assignment_id AS id, a.revision, a.slot_no AS "slotNo",
          a.created_at::text AS "createdAt", a.updated_at::text AS "updatedAt",
          a.deleted_at::text AS "deletedAt", a.purge_after::text AS "purgeAfter",
          a.transaction_id AS "transactionId";
