WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id,
         :subject_id::uuid AS subject_id, :label_id::uuid AS label_id
)
SELECT assignment.subject_id AS "subjectId", assignment.label_id AS "labelId",
       assignment.assignment_id AS "assignmentId"
FROM input CROSS JOIN library.label_assignment AS assignment
WHERE assignment.route = input.route AND assignment.account_id = input.account_id
  AND assignment.subject_id = input.subject_id AND assignment.label_id = input.label_id
  AND assignment.deleted_at IS NULL AND assignment.slot_no IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM library.personal_label AS parent
    WHERE parent.route = input.route AND parent.account_id = input.account_id
      AND parent.label_id = input.label_id AND parent.deleted_at IS NULL
  );
