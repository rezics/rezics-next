-- Correlated owner-label windows retain label_assignment_owner_label under generic
-- prepared plans. Equality plus LIMIT Seq Scanned a small assignment table (FULL
-- warmup two sequential scans). MATERIALIZED input, Access ROW-bounded index
-- range, and OFFSET 0 keep the (route, account_id, label_id, subject_id) seek
-- even when the CTE values are constants. ORDER BY names that index. Page LIMIT
-- stays after OFFSET 0.
WITH input AS MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id, :label_id::uuid AS label_id,
         :after_subject_id::uuid AS after_subject_id, :limit::integer AS page_limit,
         'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid AS last_subject_id
), source AS MATERIALIZED (
  SELECT a.* FROM input CROSS JOIN LATERAL (
    SELECT assignment.assignment_id AS id, assignment.label_id AS "labelId",
           assignment.subject_id AS "subjectId", assignment.revision,
           assignment.slot_no AS "slotNo", assignment.deleted_at::text AS "deletedAt"
    FROM library.label_assignment AS assignment
    WHERE ROW(assignment.route, assignment.account_id, assignment.label_id, assignment.subject_id)
            > ROW(input.route, input.account_id, input.label_id, input.after_subject_id)
      AND ROW(assignment.route, assignment.account_id, assignment.label_id, assignment.subject_id)
            <= ROW(input.route, input.account_id, input.label_id, input.last_subject_id)
    ORDER BY assignment.route, assignment.account_id, assignment.label_id, assignment.subject_id
    OFFSET 0
    LIMIT input.page_limit
  ) a
)
SELECT * FROM source ORDER BY "subjectId";
