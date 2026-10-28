WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id,
         :subject_id::uuid AS subject_id, :label_id::uuid AS label_id,
         :slot_no::smallint AS slot_no, :time::timestamptz AS time,
         :transaction_id::uuid AS transaction_id, :retained::boolean AS retained,
         :assignment_id::uuid AS assignment_id, :revision::integer AS revision,
         :deleted_at::timestamptz AS deleted_at, :purge_after::timestamptz AS purge_after
), reassigned AS (
  UPDATE library.label_assignment AS a
  SET revision = a.revision + 1, slot_no = input.slot_no,
      deleted_at = NULL, purge_after = NULL,
      updated_at = input.time, transaction_id = input.transaction_id
  FROM input
  WHERE a.route = input.route AND a.account_id = input.account_id AND a.subject_id = input.subject_id
    AND a.label_id = input.label_id AND input.retained
    AND a.assignment_id = input.assignment_id AND a.revision = input.revision
    AND a.slot_no IS NULL AND a.deleted_at = input.deleted_at AND a.purge_after = input.purge_after
  RETURNING a.*
), inserted AS (
  INSERT INTO library.label_assignment
    (route, account_id, subject_id, label_id, revision, slot_no, created_at, updated_at, transaction_id)
  SELECT input.route, input.account_id, input.subject_id, input.label_id, 1, input.slot_no,
         input.time, input.time, input.transaction_id
  FROM input WHERE NOT input.retained
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
