-- Correlated bounded branches retain index predicates under generic prepared plans.
WITH input AS MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id, :label_id::uuid AS label_id,
         :after_subject_id::uuid AS after_subject_id, :limit::integer AS page_limit
), source AS MATERIALIZED (
  SELECT a.* FROM input CROSS JOIN LATERAL (
    SELECT assignment.assignment_id AS id, assignment.label_id AS "labelId",
           assignment.subject_id AS "subjectId", assignment.revision,
           assignment.slot_no AS "slotNo", assignment.deleted_at::text AS "deletedAt"
    FROM library.label_assignment AS assignment
    WHERE assignment.route = input.route AND assignment.account_id = input.account_id
      AND assignment.label_id = input.label_id
      AND assignment.subject_id > input.after_subject_id
    ORDER BY assignment.route, assignment.account_id, assignment.label_id, assignment.subject_id
    LIMIT input.page_limit
  ) a
)
SELECT * FROM source ORDER BY "subjectId";
