WITH input AS MATERIALIZED (
  SELECT :deleted_at::timestamptz AS deleted_at, :purge_after::timestamptz AS purge_after,
         :time::timestamptz AS time, :transaction_id::uuid AS transaction_id,
         :route::integer AS route, :account_id::uuid AS account_id,
         :subject_id::uuid AS subject_id, :label_id::uuid AS label_id,
         :assignment_id::uuid AS assignment_id, :revision::integer AS revision,
         :slot_no::smallint AS slot_no
)
UPDATE library.label_assignment AS assignment
SET revision = assignment.revision + 1, slot_no = NULL,
    deleted_at = input.deleted_at, purge_after = input.purge_after,
    updated_at = input.time, transaction_id = input.transaction_id
FROM input
WHERE ROW(assignment.route, assignment.account_id, assignment.assignment_id)
        >= ROW(input.route, input.account_id, input.assignment_id)
  AND ROW(assignment.route, assignment.account_id, assignment.assignment_id)
        <= ROW(input.route, input.account_id, input.assignment_id)
  AND assignment.route = input.route AND assignment.account_id = input.account_id
  AND assignment.assignment_id = input.assignment_id
  AND assignment.subject_id = input.subject_id AND assignment.label_id = input.label_id
  AND assignment.revision = input.revision AND assignment.slot_no = input.slot_no
  AND assignment.deleted_at IS NULL
RETURNING assignment.assignment_id;
